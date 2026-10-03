import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  MAX_SAFE_PROTOCOL_INTEGER,
  P1_LIMITS,
  P1_POSITION_LIMIT_METERS,
  type P1ErrorCode,
  type P1MaterialState,
  type P1SharedEntity,
  type P1SharedEntityInput,
  type P1TransformState,
  type SubscriptionSelector,
} from "@hvtp/protocol-types";

export type MutableP1Component = "hvtp.transform@1" | "hvtp.material@1";

export interface P1WorldSnapshot {
  readonly baseSeq: number;
  readonly entities: readonly P1SharedEntity[];
}

export interface DurableEntityMutation {
  readonly seq: number;
  readonly entity: P1SharedEntity;
}

export interface DurableDeletion {
  readonly seq: number;
  readonly entityId: string;
}

export class P1StoreError extends Error {
  readonly code: P1ErrorCode;
  readonly currentRevision: number | undefined;

  constructor(code: P1ErrorCode, message: string, currentRevision?: number) {
    super(message);
    this.name = "P1StoreError";
    this.code = code;
    this.currentRevision = currentRevision;
  }
}

/**
 * SQLite-backed durable P1 world state.
 *
 * Entity/component state, revisions and tombstones survive process restart.
 * The realm sequence is durable inside one process epoch for atomic commit
 * semantics, then intentionally reset to 0 when a new store instance starts,
 * matching P1's new-realmEpoch-on-restart rule.
 */
export class P1WorldStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec("PRAGMA synchronous = FULL");
    if (path !== ":memory:") this.#db.exec("PRAGMA journal_mode = WAL");

    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS p1_meta (
        key TEXT PRIMARY KEY,
        integer_value INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS p1_entities (
        id TEXT PRIMARY KEY,
        deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
        entity_json TEXT,
        CHECK (
          (deleted = 0 AND entity_json IS NOT NULL) OR
          (deleted = 1 AND entity_json IS NULL)
        )
      ) STRICT;
    `);

    // A host restart creates a new realmEpoch and therefore a new seq domain.
    this.#db.prepare(`
      INSERT INTO p1_meta(key, integer_value)
      VALUES ('realm_seq', 0)
      ON CONFLICT(key) DO UPDATE SET integer_value = 0
    `).run();
  }

  close(): void {
    this.#db.close();
  }

  getRealmSeq(): number {
    const row = this.#db.prepare(
      "SELECT integer_value AS value FROM p1_meta WHERE key = 'realm_seq'",
    ).get() as { value: number } | undefined;
    if (row === undefined) throw new Error("P1 realm sequence row is missing");
    return row.value;
  }

  getEntity(entityId: string): P1SharedEntity | null {
    const row = this.#db.prepare(
      "SELECT deleted, entity_json FROM p1_entities WHERE id = ?",
    ).get(entityId) as { deleted: number; entity_json: string | null } | undefined;

    if (row === undefined || row.deleted === 1 || row.entity_json === null) return null;
    return parseStoredEntity(row.entity_json);
  }

  isTombstoned(entityId: string): boolean {
    const row = this.#db.prepare(
      "SELECT deleted FROM p1_entities WHERE id = ?",
    ).get(entityId) as { deleted: number } | undefined;
    return row?.deleted === 1;
  }

  snapshot(selector: SubscriptionSelector): P1WorldSnapshot {
    const baseSeq = this.getRealmSeq();
    const rows = this.#db.prepare(
      "SELECT entity_json FROM p1_entities WHERE deleted = 0 ORDER BY id",
    ).all() as Array<{ entity_json: string }>;

    const entities = rows
      .map((row) => parseStoredEntity(row.entity_json))
      .filter((entity) => selectedBy(entity, selector));

    return { baseSeq, entities };
  }

  createEntity(input: P1SharedEntityInput): DurableEntityMutation {
    validateSharedEntityInput(input);

    const entity: P1SharedEntity = {
      id: input.id,
      components: {
        "hvtp.transform@1": envelope(1, cloneTransform(input.transform)),
        "hvtp.renderable@1": envelope(1, {
          asset: { uri: "unit-cube.gltf", mediaType: "model/gltf+json" },
          node: "UnitCube",
          visible: input.renderable.visible,
        }),
        "hvtp.material@1": envelope(1, {
          baseColor: [...input.material.baseColor] as [number, number, number, number],
        }),
      },
    };
    ensureEntitySize(entity);

    return this.#mutate((seq) => {
      const existing = this.#db.prepare(
        "SELECT 1 AS present FROM p1_entities WHERE id = ?",
      ).get(input.id);
      if (existing !== undefined) {
        throw new P1StoreError("entity_exists", "Entity ID is live or permanently tombstoned.");
      }

      const countRow = this.#db.prepare(
        "SELECT COUNT(*) AS count FROM p1_entities",
      ).get() as { count: number };
      if (countRow.count >= P1_LIMITS.maxPersistentEntityRecords) {
        throw new P1StoreError("resource_limit", "Persistent entity/tombstone budget is exhausted.");
      }

      this.#db.prepare(
        "INSERT INTO p1_entities(id, deleted, entity_json) VALUES (?, 0, ?)",
      ).run(input.id, JSON.stringify(entity));

      return { seq, entity };
    });
  }

  replaceMutableComponent(
    entityId: string,
    component: MutableP1Component,
    state: P1TransformState | P1MaterialState,
    baseRevision: number,
    authorityEpoch: number,
  ): DurableEntityMutation {
    validatePositiveProtocolInteger(baseRevision, "baseRevision");
    validatePositiveProtocolInteger(authorityEpoch, "authorityEpoch");
    if (authorityEpoch !== 1) {
      throw new P1StoreError(
        "authority_epoch_mismatch",
        "P1 canonical authority epoch is 1.",
      );
    }

    return this.#mutate((seq) => {
      const current = this.getEntity(entityId);
      if (current === null) {
        throw new P1StoreError("entity_not_found", "Entity does not exist.");
      }

      const value = current.components[component];
      if (value.revision !== baseRevision) {
        throw new P1StoreError(
          "revision_mismatch",
          "Component revision does not match current revision.",
          value.revision,
        );
      }
      if (value.revision >= MAX_SAFE_PROTOCOL_INTEGER) {
        throw new P1StoreError("resource_limit", "Component revision cannot advance safely.");
      }

      const nextRevision = value.revision + 1;
      let updated: P1SharedEntity;
      if (component === "hvtp.transform@1") {
        validateTransformState(state);
        updated = {
          ...current,
          components: {
            ...current.components,
            "hvtp.transform@1": envelope(nextRevision, cloneTransform(state)),
          },
        };
      } else {
        validateMaterialState(state);
        updated = {
          ...current,
          components: {
            ...current.components,
            "hvtp.material@1": envelope(nextRevision, {
              baseColor: [...state.baseColor] as [number, number, number, number],
            }),
          },
        };
      }

      ensureEntitySize(updated);
      this.#db.prepare(
        "UPDATE p1_entities SET entity_json = ? WHERE id = ? AND deleted = 0",
      ).run(JSON.stringify(updated), entityId);

      return { seq, entity: updated };
    });
  }

  deleteEntity(entityId: string): DurableDeletion {
    return this.#mutate((seq) => {
      const row = this.#db.prepare(
        "SELECT deleted FROM p1_entities WHERE id = ?",
      ).get(entityId) as { deleted: number } | undefined;
      if (row === undefined || row.deleted === 1) {
        throw new P1StoreError("entity_not_found", "Entity does not exist.");
      }

      this.#db.prepare(
        "UPDATE p1_entities SET deleted = 1, entity_json = NULL WHERE id = ?",
      ).run(entityId);
      return { seq, entityId };
    });
  }

  #mutate<T>(operation: (seq: number) => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const currentSeq = this.getRealmSeq();
      if (currentSeq >= MAX_SAFE_PROTOCOL_INTEGER) {
        throw new P1StoreError("resource_limit", "Realm sequence cannot advance safely.");
      }
      const seq = currentSeq + 1;
      const result = operation(seq);
      this.#db.prepare(
        "UPDATE p1_meta SET integer_value = ? WHERE key = 'realm_seq'",
      ).run(seq);
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
}

function envelope<State>(revision: number, state: State) {
  return {
    revision,
    authority: "host" as const,
    authorityEpoch: 1 as const,
    consistency: "authoritative" as const,
    state,
  };
}

function validateSharedEntityInput(input: P1SharedEntityInput): void {
  validateOpaqueId(input.id, "entity id");
  validateTransformState(input.transform);
  validateMaterialState(input.material);

  if (
    input.renderable.asset.uri !== "unit-cube.gltf" ||
    input.renderable.asset.mediaType !== "model/gltf+json" ||
    input.renderable.node !== "UnitCube" ||
    typeof input.renderable.visible !== "boolean"
  ) {
    throw new P1StoreError("invalid_component_state", "Renderable state violates P1 fixture rules.");
  }
}

function validateTransformState(value: P1TransformState | P1MaterialState): asserts value is P1TransformState {
  const candidate = value as P1TransformState;
  const position = candidate.position;
  const rotation = candidate.rotation;
  const scale = candidate.scale;

  if (
    !Array.isArray(position) ||
    position.length !== 3 ||
    position.some(
      (coordinate) =>
        typeof coordinate !== "number" ||
        !Number.isFinite(coordinate) ||
        coordinate < -P1_POSITION_LIMIT_METERS ||
        coordinate > P1_POSITION_LIMIT_METERS,
    )
  ) {
    throw new P1StoreError("invalid_component_state", "Transform position is invalid.");
  }
  if (
    !Array.isArray(scale) ||
    scale.length !== 3 ||
    scale.some(
      (coordinate) =>
        typeof coordinate !== "number" ||
        !Number.isFinite(coordinate) ||
        coordinate <= 0 ||
        coordinate > 1000,
    )
  ) {
    throw new P1StoreError("invalid_component_state", "Transform scale is invalid.");
  }
  if (
    !Array.isArray(rotation) ||
    rotation.length !== 4 ||
    rotation.some((coordinate) => typeof coordinate !== "number" || !Number.isFinite(coordinate))
  ) {
    throw new P1StoreError("invalid_component_state", "Transform quaternion is invalid.");
  }

  const norm = Math.hypot(rotation[0]!, rotation[1]!, rotation[2]!, rotation[3]!);
  if (Math.abs(norm - 1) > 1e-5) {
    throw new P1StoreError("invalid_component_state", "Transform quaternion is not normalized.");
  }
}

function validateMaterialState(value: P1TransformState | P1MaterialState): asserts value is P1MaterialState {
  const baseColor = (value as P1MaterialState).baseColor;
  if (
    !Array.isArray(baseColor) ||
    baseColor.length !== 4 ||
    baseColor.some(
      (channel) =>
        typeof channel !== "number" ||
        !Number.isFinite(channel) ||
        channel < 0 ||
        channel > 1,
    )
  ) {
    throw new P1StoreError("invalid_component_state", "Material baseColor is invalid.");
  }
}

function validatePositiveProtocolInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new P1StoreError("invalid_message", `${label} must be a positive safe integer.`);
  }
}

function validateOpaqueId(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 128
  ) {
    throw new P1StoreError("invalid_message", `${label} must be a non-empty opaque ID of at most 128 UTF-8 bytes.`);
  }
}

function ensureEntitySize(entity: P1SharedEntity): void {
  const size = Buffer.byteLength(JSON.stringify(entity), "utf8");
  if (size > P1_LIMITS.maxEntityBytes) {
    throw new P1StoreError("resource_limit", "Serialized entity exceeds maxEntityBytes.");
  }
}

function cloneTransform(state: P1TransformState): P1TransformState {
  return {
    position: [...state.position] as [number, number, number],
    rotation: [...state.rotation] as [number, number, number, number],
    scale: [...state.scale] as [number, number, number],
  };
}

function parseStoredEntity(text: string): P1SharedEntity {
  const parsed = JSON.parse(text) as P1SharedEntity;
  // Rows are only created/updated through validated store operations. A light
  // structural guard still prevents corrupt JSON from silently entering views.
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof parsed.id !== "string" ||
    typeof parsed.components !== "object" ||
    parsed.components === null
  ) {
    throw new Error("Stored P1 entity is corrupt.");
  }
  return parsed;
}

function selectedBy(entity: P1SharedEntity, selector: SubscriptionSelector): boolean {
  const explicit = selector.entities?.includes(entity.id) ?? false;
  if (explicit) return true;

  const spatial = selector.spatial;
  if (spatial === undefined) return false;

  const position = entity.components["hvtp.transform@1"].state.position;
  const dx = position[0] - spatial.center[0];
  const dy = position[1] - spatial.center[1];
  const dz = position[2] - spatial.center[2];
  return dx * dx + dy * dy + dz * dz <= spatial.radius * spatial.radius;
}
