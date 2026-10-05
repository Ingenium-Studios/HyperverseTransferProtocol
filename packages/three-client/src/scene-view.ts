import { Group, Object3D, type Material } from "three";
import type { P1SharedEntity } from "@hvtp/protocol-types";
import { isPresenceEntity, type P1ClientListener, type P1Limits, type P1ViewEntity } from "@hvtp/client-core";
import { P1FixtureLoader, type P1AssetLoadResult, type P1FetchLike } from "./asset-loader.js";
import { applyBaseColor, applyTransform, createPlaceholder, instantiateFixture } from "./entity-adapter.js";

/**
 * What the renderer needs from a client session: read-only events plus session asset parameters. It has no
 * request methods, so a presentation failure structurally cannot become a shared-state mutation.
 */
export interface P1ViewSource {
  on(listener: P1ClientListener): () => void;
  readonly assetBaseUri: string | null;
  readonly limits: P1Limits | null;
}

export type P1AssetStatus = "loading" | "loaded" | "placeholder";

export interface P1ThreeViewOptions {
  /** Injectable fetch (tests); defaults to the platform `fetch`. */
  readonly fetch?: P1FetchLike;
  /** Called when an entity falls back to the local placeholder. */
  readonly onAssetFailure?: (entityId: string, reason: string) => void;
}

interface EntityRecord {
  entity: P1SharedEntity;
  readonly root: Object3D;
  content: Object3D | null;
  status: P1AssetStatus;
  ownedMaterials: readonly Material[];
  disposeContent: (() => void) | null;
}

/**
 * Three.js projection of the client's canonical active view. Every `THREE.Object3D` here is derived from the
 * engine-neutral entity records emitted by `@hvtp/client-core`; the scene graph is never the source of truth,
 * and no Three.js type flows back into protocol or client state.
 *
 * Hierarchy per renderable entity:
 *
 *     Object3D (name = entity ID, HVTP T × R × S)
 *     └── cloned glTF node `UnitCube` (its own glTF hierarchy) | local placeholder
 *
 * Own presence has no P1 renderable and is not drawn.
 */
export class P1ThreeView {
  readonly root = new Group();
  readonly #options: P1ThreeViewOptions;
  readonly #records = new Map<string, EntityRecord>();
  readonly #loads = new Set<Promise<void>>();
  #loader: P1FixtureLoader | null = null;
  #source: P1ViewSource | null = null;

  constructor(options: P1ThreeViewOptions = {}) {
    this.#options = options;
    this.root.name = "hvtp-p1-view";
  }

  /** Follows one client. Returns a detach function that also clears the scene. */
  attach(source: P1ViewSource): () => void {
    this.#source = source;
    const off = source.on((event) => {
      switch (event.type) {
        case "view.reset":
          this.#reset(event.entities.values());
          return;
        case "entity.upsert":
          if (event.cause === "updated") this.#update(event.entity);
          else this.#rebuild(event.entity);
          return;
        case "entity.remove":
          this.#remove(event.entityId);
          return;
        default:
          return;
      }
    });
    return () => {
      off();
      this.#source = null;
      this.#reset([]);
    };
  }

  get size(): number { return this.#records.size; }
  object(entityId: string): Object3D | undefined { return this.#records.get(entityId)?.root; }
  assetStatus(entityId: string): P1AssetStatus | undefined { return this.#records.get(entityId)?.status; }

  /** Resolves when every in-flight asset load has been applied (tests and demos). */
  async whenIdle(): Promise<void> {
    while (this.#loads.size > 0) await Promise.all([...this.#loads]);
  }

  dispose(): void {
    this.#reset([]);
  }

  #reset(entities: Iterable<P1ViewEntity>): void {
    for (const entityId of [...this.#records.keys()]) this.#remove(entityId);
    // A fresh session (or none): per-session asset cache, nothing still references the old templates.
    this.#loader?.dispose();
    this.#loader = null;
    const base = this.#source?.assetBaseUri;
    const limits = this.#source?.limits;
    if (base != null && limits != null) {
      this.#loader = new P1FixtureLoader({
        assetBaseUri: base, maxAssetBytes: limits.maxAssetBytes,
        ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
      });
    }
    for (const entity of entities) this.#rebuild(entity);
  }

  /** Creation, view enter, and snapshot entries materialize from the complete record alone. */
  #rebuild(entity: P1ViewEntity): void {
    this.#remove(entity.id);
    if (isPresenceEntity(entity)) return;
    const root = new Object3D();
    root.name = entity.id;
    root.userData.hvtpEntityId = entity.id;
    const record: EntityRecord = { entity, root, content: null, status: "loading", ownedMaterials: [], disposeContent: null };
    this.#records.set(entity.id, record);
    this.#applyState(record);
    this.root.add(root);

    const loader = this.#loader;
    const loaded: Promise<P1AssetLoadResult> = loader === null
      ? Promise.resolve({ ok: false, url: null, reason: "no asset base for this session" })
      : loader.load(entity.components["hvtp.renderable@1"].state);
    const applied = loaded.then((result) => {
      // Ignore results for a record that was removed or rebuilt meanwhile.
      if (this.#records.get(entity.id) !== record) return;
      if (result.ok) {
        const instance = instantiateFixture(result.template);
        record.content = instance.object;
        record.ownedMaterials = instance.ownedMaterials;
        record.disposeContent = () => { for (const material of instance.ownedMaterials) material.dispose(); };
        record.status = "loaded";
      } else {
        const placeholder = createPlaceholder();
        record.content = placeholder.object;
        record.disposeContent = placeholder.dispose;
        record.status = "placeholder";
        this.#options.onAssetFailure?.(entity.id, result.reason);
      }
      record.root.add(record.content);
      this.#applyState(record);
    });
    this.#loads.add(applied);
    void applied.finally(() => this.#loads.delete(applied));
  }

  #update(entity: P1ViewEntity): void {
    const record = this.#records.get(entity.id);
    if (record === undefined || isPresenceEntity(entity)) return;
    record.entity = entity;
    this.#applyState(record);
  }

  #applyState(record: EntityRecord): void {
    const components = record.entity.components;
    applyTransform(record.root, components["hvtp.transform@1"].state);
    // `visible: false` hides the fixture but the entity stays in canonical state and view membership.
    record.root.visible = components["hvtp.renderable@1"].state.visible;
    if (record.status === "loaded" && record.content !== null) applyBaseColor(record.content, components["hvtp.material@1"].state);
  }

  #remove(entityId: string): void {
    const record = this.#records.get(entityId);
    if (record === undefined) return;
    this.#records.delete(entityId);
    record.root.removeFromParent();
    // Per-entity materials/placeholder resources only; shared template geometry stays with the loader cache.
    record.disposeContent?.();
  }
}
