import { randomUUID } from "node:crypto";
import {
  HVTP_VERSION,
  P1_LIMITS,
  P1_REALM_ID,
  P1_REQUIRED_COMPONENTS,
  parseJsonRequest,
  parseMutationRequest,
  parseRealmJoin,
  parseSessionHello,
  type EntitySnapshotMessage,
  type ErrorMessage,
  type P1ErrorCode,
  type P1MutationRequest,
  type P1MutableComponent,
  type P1SharedEntityInput,
  type P1PresenceEntity,
  type P1SharedEntity,
  type P1TransformState,
  type P1MaterialState,
  type MutationAckMessage,
  type CanonicalPublicationMessage,
  type ParticipantKind,
  type RealmJoinedMessage,
  type RealmSnapshotBeginMessage,
  type RealmSnapshotEndMessage,
  type SessionServerMessage,
  type SessionWelcomeMessage,
  type SubscriptionSelector,
} from "@hvtp/protocol-types";
import { P1RealmCoordinator } from "./realm-coordinator.js";
import { P1CommitOutcomeUnknown, P1StoreError, type MutableP1Component } from "./world-store.js";

export type SessionState = "CONNECTED" | "NEGOTIATED" | "JOINING" | "JOINED" | "CLOSED";

export interface SessionDispatch {
  readonly messages: readonly SessionServerMessage[];
  readonly afterEnqueue?: () => void;
}

export interface P1WorldView {
  snapshot(selector: SubscriptionSelector): {
    readonly baseSeq: number;
    readonly entities: readonly P1SharedEntity[];
  };
  createEntity?(input: P1SharedEntityInput): { readonly seq: number; readonly entity: P1SharedEntity };
  replaceMutableComponent?(
    entityId: string,
    component: MutableP1Component,
    state: P1TransformState | P1MaterialState,
    baseRevision: number,
    authorityEpoch: number,
  ): { readonly seq: number; readonly entity: P1SharedEntity };
  deleteEntity?(entityId: string): { readonly seq: number; readonly entityId: string };
  getEntity?(entityId: string): P1SharedEntity | null;
}

const EMPTY_WORLD_VIEW: P1WorldView = {
  snapshot: () => ({ baseSeq: 0, entities: [] }),
};

const KNOWN_CLIENT_MESSAGE_TYPES = new Set([
  "session.hello",
  "realm.join",
  "entity.create",
  "entity.delete",
  "component.set",
  "component.patch",
  "component.ephemeral",
  "subscription.set",
]);

export class P1Session {
  #state: SessionState = "CONNECTED";
  readonly #assetBaseUri: string;
  readonly #realmEpoch: string;
  readonly #worldView: P1WorldView;
  #participantId: string | null = null;
  #participantKind: ParticipantKind | null = null;
  #activeSubscriptionId: string | null = null;
  #pendingSnapshotId: string | null = null;
  #presenceEntityId: string | null = null;
  #unregisterPresenceEntity: (() => void) | null = null;
  #unsubscribe: (() => void) | null = null;
  readonly #realmCoordinator: P1RealmCoordinator | undefined;
  readonly #deliverCanonical: ((message: CanonicalPublicationMessage) => void) | undefined;
  readonly #closeTransport: ((code: number, reason: string) => void) | undefined;
  readonly #afterDurableCommit: (() => void) | undefined;
  readonly #requestTable = new Map<string, { readonly content: string; terminal?: SessionServerMessage }>();

  constructor(
    assetBaseUri: string,
    realmEpoch = `epoch:${randomUUID()}`,
    worldView: P1WorldView = EMPTY_WORLD_VIEW,
    options: {
      readonly realmCoordinator?: P1RealmCoordinator;
      readonly deliverCanonical?: (message: CanonicalPublicationMessage) => void;
      readonly closeTransport?: (code: number, reason: string) => void;
      readonly afterDurableCommit?: () => void;
    } = {},
  ) {
    const uri = new URL(assetBaseUri);
    if (!uri.pathname.endsWith("/")) throw new Error("assetBaseUri must end in /");
    this.#assetBaseUri = uri.toString();
    this.#realmEpoch = realmEpoch;
    this.#worldView = worldView;
    this.#realmCoordinator = options.realmCoordinator;
    this.#deliverCanonical = options.deliverCanonical;
    this.#closeTransport = options.closeTransport;
    this.#afterDurableCommit = options.afterDurableCommit;
  }

  get state(): SessionState {
    return this.#state;
  }

  close(): void {
    this.#state = "CLOSED";
    this.#pendingSnapshotId = null;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#unregisterPresenceEntity?.();
    this.#unregisterPresenceEntity = null;
  }

  handleText(text: string): SessionDispatch {
    const generic = parseJsonRequest(text);
    if (!generic.ok) return this.#dispatch(this.#error(generic.error.code, generic.error.ref, generic.error.message));

    const request = generic.value;
    const ref = request.id as string;
    const type = typeof request.type === "string" ? request.type : null;

    if (this.#state === "CLOSED") return this.#dispatch(this.#error("invalid_state", ref, "Session is closed."));
    if (type === null) return this.#dispatch(this.#error("invalid_message", ref, "Request type must be a string."));
    if (!KNOWN_CLIENT_MESSAGE_TYPES.has(type)) {
      return this.#dispatch(this.#error("unsupported_message", ref, `Unsupported P1 message type: ${type}`));
    }

    if (this.#state === "CONNECTED") {
      if (type !== "session.hello") {
        return this.#dispatch(this.#error("invalid_state", ref, `Message ${type} is not valid before session.welcome.`));
      }
      return this.#handleHello(text);
    }

    if (this.#state === "NEGOTIATED") {
      if (type !== "realm.join") {
        return this.#dispatch(this.#error("invalid_state", ref, `Message ${type} is not valid before realm.join.`));
      }
      return this.#handleRealmJoin(text);
    }

    if (this.#state === "JOINING") {
      return this.#dispatch(this.#error("invalid_state", ref, `Message ${type} is not valid while the initial snapshot is being enqueued.`));
    }

    if (type === "realm.join" || type === "session.hello") {
      return this.#dispatch(this.#error("invalid_state", ref, `Message ${type} is not valid after the realm has been joined.`));
    }
    if (type === "component.ephemeral") {
      return this.#dispatch(this.#error("unsupported_message", ref, "P1 does not support component.ephemeral."));
    }

    if (type === "entity.create" || type === "entity.delete" || type === "component.set" || type === "component.patch") {
      return this.#handleMutation(text, request);
    }

    return this.#dispatch(this.#error("unsupported_message", ref, `Message ${type} is not implemented by P1.`));
  }

  #handleHello(text: string): SessionDispatch {
    const hello = parseSessionHello(text);
    if (!hello.ok) return this.#dispatch(this.#error(hello.error.code, hello.error.ref, hello.error.message));

    const participantId = `participant:${randomUUID()}`;
    this.#participantId = participantId;
    this.#participantKind = hello.value.body.participant.kind;
    this.#state = "NEGOTIATED";

    const welcome: SessionWelcomeMessage = {
      hvtp: HVTP_VERSION,
      id: `res:${randomUUID()}`,
      type: "session.welcome",
      body: {
        version: HVTP_VERSION,
        participantId,
        server: { name: "hvtp-reference-host", version: "0.1.0" },
        assetBaseUri: this.#assetBaseUri,
        limits: P1_LIMITS,
      },
    };
    return this.#dispatch(welcome);
  }

  #handleRealmJoin(text: string): SessionDispatch {
    const join = parseRealmJoin(text);
    if (!join.ok) return this.#dispatch(this.#error(join.error.code, join.error.ref, join.error.message));

    const participantId = this.#participantId;
    const participantKind = this.#participantKind;
    if (participantId === null || participantKind === null) {
      return this.#dispatch(this.#error("invalid_state", join.value.id, "Session has no negotiated participant."));
    }

    const effectiveSubscription = cloneSubscription(join.value.body.subscription);
    const durableSnapshot = this.#worldView.snapshot(effectiveSubscription);
    if (durableSnapshot.entities.length + 1 > P1_LIMITS.maxVisibleEntitiesPerConnection) {
      return this.#dispatch(
        this.#error(
          "resource_limit",
          join.value.id,
          "Initial effective view exceeds maxVisibleEntitiesPerConnection.",
        ),
      );
    }

    const subscriptionId = `subscription:${randomUUID()}`;
    const snapshotId = `snapshot:${randomUUID()}`;
    const presenceEntityId = `entity:presence-${randomUUID()}`;
    this.#presenceEntityId = presenceEntityId;
    const snapshotBaseSeq = durableSnapshot.baseSeq;
    const presenceEntity = createPresenceEntity(presenceEntityId, participantId, participantKind);

    const joined: RealmJoinedMessage = {
      hvtp: HVTP_VERSION,
      id: `res:${randomUUID()}`,
      type: "realm.joined",
      realm: P1_REALM_ID,
      realmEpoch: this.#realmEpoch,
      body: {
        participantId,
        presenceEntityId,
        subscriptionId,
        effectiveSubscription,
        snapshotId,
        snapshotBaseSeq,
        requiredComponents: P1_REQUIRED_COMPONENTS,
      },
    };

    const begin: RealmSnapshotBeginMessage = {
      hvtp: HVTP_VERSION,
      id: `snapshot-begin:${randomUUID()}`,
      type: "realm.snapshot.begin",
      realm: P1_REALM_ID,
      realmEpoch: this.#realmEpoch,
      body: { snapshotId, subscriptionId, snapshotBaseSeq },
    };

    const sharedEntities: EntitySnapshotMessage[] = durableSnapshot.entities.map((entity) => ({
      hvtp: HVTP_VERSION,
      id: `snapshot-entity:${randomUUID()}`,
      type: "entity.snapshot",
      realm: P1_REALM_ID,
      realmEpoch: this.#realmEpoch,
      body: { snapshotId, snapshotBaseSeq, entity },
    }));

    const presenceSnapshot: EntitySnapshotMessage = {
      hvtp: HVTP_VERSION,
      id: `snapshot-entity:${randomUUID()}`,
      type: "entity.snapshot",
      realm: P1_REALM_ID,
      realmEpoch: this.#realmEpoch,
      body: { snapshotId, snapshotBaseSeq, entity: presenceEntity },
    };

    const end: RealmSnapshotEndMessage = {
      hvtp: HVTP_VERSION,
      id: `snapshot-end:${randomUUID()}`,
      type: "realm.snapshot.end",
      realm: P1_REALM_ID,
      realmEpoch: this.#realmEpoch,
      body: {
        snapshotId,
        subscriptionId,
        snapshotBaseSeq,
        entityCount: sharedEntities.length + 1,
      },
    };

    this.#activeSubscriptionId = subscriptionId;
    this.#pendingSnapshotId = snapshotId;
    this.#state = "JOINING";

    return {
      messages: [joined, begin, ...sharedEntities, presenceSnapshot, end],
      afterEnqueue: () => {
        if (this.#state === "JOINING" && this.#pendingSnapshotId === snapshotId) {
          this.#pendingSnapshotId = null;
          this.#state = "JOINED";
          if (this.#realmCoordinator !== undefined && this.#deliverCanonical !== undefined && this.#closeTransport !== undefined) {
            this.#unregisterPresenceEntity = this.#realmCoordinator.registerPresenceEntity(presenceEntityId);
            this.#unsubscribe = this.#realmCoordinator.subscribe(
              effectiveSubscription,
              subscriptionId,
              this.#deliverCanonical,
              this.#closeTransport,
            );
          }
        }
      },
    };
  }

  #dispatch(message: SessionServerMessage): SessionDispatch {
    return { messages: [message] };
  }

  #error(
    code: P1ErrorCode,
    ref: string | null,
    message: string,
    context: Partial<Pick<ErrorMessage["body"], "entityId" | "component" | "currentRevision" | "authorityEpoch">> = {},
  ): ErrorMessage {
    const realmScoped = this.#state === "JOINING" || this.#state === "JOINED";
    return {
      hvtp: HVTP_VERSION,
      id: `res:${randomUUID()}`,
      type: "error",
      ...(realmScoped ? { realm: P1_REALM_ID, realmEpoch: this.#realmEpoch } : {}),
      body: { ref, code, message, ...context },
    };
  }

  #handleMutation(
    text: string,
    parsedRequest: Record<string, unknown>,
  ): SessionDispatch {
    const ref = parsedRequest.id as string;
    const content = canonicalJson(parsedRequest);
    const existing = this.#requestTable.get(ref);
    if (existing !== undefined) {
      if (existing.content !== content) {
        return this.#dispatch(this.#error("request_id_conflict", ref, "Request ID is already associated with different parsed request content."));
      }
      return existing.terminal === undefined ? { messages: [] } : this.#dispatch(existing.terminal);
    }
    if (this.#requestTable.size >= P1_LIMITS.maxRequestDedupEntries) {
      return this.#dispatch(this.#error("resource_limit", ref, "Session request deduplication table is full."));
    }

    const reservation: { content: string; terminal?: SessionServerMessage } = { content };
    this.#requestTable.set(ref, reservation);
    const parsed = parseMutationRequest(text);
    let terminal: SessionServerMessage;
    if (!parsed.ok) {
      terminal = this.#error(parsed.error.code, ref, parsed.error.message);
    } else {
      try {
        terminal = this.#executeMutation(parsed.value);
      } catch (error) {
        if (error instanceof PostCommitResponseFailure) return { messages: [] };
        if (error instanceof P1CommitOutcomeUnknown) {
          this.close();
          this.#closeTransport?.(1011, "durable mutation outcome is uncertain; reconnect for a fresh snapshot");
          return { messages: [] };
        }
        if (error instanceof P1StoreError) {
          const request = parsed.value;
          const entityId = request.type === "entity.create" ? request.body.entity.id : request.body.entityId;
          const component = request.type === "component.set" || request.type === "component.patch"
            ? request.body.component
            : undefined;
          terminal = this.#error(error.code, ref, error.message, {
            entityId,
            ...(component === undefined ? {} : { component }),
            ...(error.currentRevision === undefined ? {} : { currentRevision: error.currentRevision }),
            ...(error.code === "authority_epoch_mismatch" || error.code === "revision_mismatch" ? { authorityEpoch: 1 } : {}),
          });
        } else {
          terminal = this.#error("resource_limit", ref, "Durable world mutation could not be completed.");
        }
      }
    }
    reservation.terminal = terminal;
    return this.#dispatch(terminal);
  }

  #executeMutation(request: P1MutationRequest): SessionServerMessage {
    const world = this.#worldView;
    if (request.type === "entity.create") {
      if (world.createEntity === undefined) throw new P1StoreError("invalid_state", "Durable world mutations are unavailable.");
      if (request.body.entity.id === this.#presenceEntityId || this.#realmCoordinator?.isPrivatePresenceEntity(request.body.entity.id)) {
        throw new P1StoreError("presence_binding_violation", "Session presence entities cannot be created as durable entities.");
      }
      const result = world.createEntity(request.body.entity);
      this.#realmCoordinator?.publish({ kind: "created", seq: result.seq, entity: result.entity });
      this.#afterCommit();
      return this.#ack(request.id, result.seq, request.body.entity.id);
    }
    if (request.type === "entity.delete") {
      if (request.body.entityId === this.#presenceEntityId || this.#realmCoordinator?.isPrivatePresenceEntity(request.body.entityId)) {
        throw new P1StoreError("presence_binding_violation", "Session presence entities cannot be deleted.");
      }
      if (world.deleteEntity === undefined || world.getEntity === undefined) {
        throw new P1StoreError("invalid_state", "Durable world mutations are unavailable.");
      }
      const before = world.getEntity(request.body.entityId);
      if (before === null) throw new P1StoreError("entity_not_found", "Entity does not exist.");
      const result = world.deleteEntity(request.body.entityId);
      this.#realmCoordinator?.publish({ kind: "deleted", seq: result.seq, entity: before });
      this.#afterCommit();
      return this.#ack(request.id, result.seq, result.entityId);
    }

    const { entityId, component, authorityEpoch, baseRevision } = request.body;
    if (entityId === this.#presenceEntityId || this.#realmCoordinator?.isPrivatePresenceEntity(entityId)) {
      throw new P1StoreError("presence_binding_violation", "Session presence components are host-managed.");
    }
    if (component === "hvtp.presence@1" || component === "hvtp.renderable@1") {
      throw new P1StoreError("not_authorized", "P1 does not permit mutation of presence or renderable components.");
    }
    if (component !== "hvtp.transform@1" && component !== "hvtp.material@1") {
      throw new P1StoreError("unsupported_component", `Unsupported component: ${component}`);
    }
    if (world.getEntity === undefined || world.replaceMutableComponent === undefined) {
      throw new P1StoreError("invalid_state", "Durable world mutations are unavailable.");
    }
    const before = world.getEntity(entityId);
    if (before === null) throw new P1StoreError("entity_not_found", "Entity does not exist.");
    const current = before.components[component];
    if (authorityEpoch !== current.authorityEpoch) {
      throw new P1StoreError("authority_epoch_mismatch", "Authority epoch does not match the current component epoch.");
    }
    if (baseRevision !== current.revision) {
      throw new P1StoreError("revision_mismatch", "Component revision does not match current revision.", current.revision);
    }
    const state = request.type === "component.set"
      ? completeState(component, request.body.state)
      : applyPatch(component, before.components[component].state, request.body.patch);
    const result = world.replaceMutableComponent(entityId, component, state, baseRevision, authorityEpoch);
    this.#realmCoordinator?.publish({ kind: "updated", seq: result.seq, before, entity: result.entity, component });
    this.#afterCommit();
    return this.#ack(request.id, result.seq, entityId, component, result.entity.components[component].revision);
  }

  #ack(ref: string, seq: number, entityId: string, component?: MutableP1Component, revision?: number): MutationAckMessage {
    return {
      hvtp: HVTP_VERSION,
      id: `res:${randomUUID()}`,
      type: "ack",
      realm: P1_REALM_ID,
      realmEpoch: this.#realmEpoch,
      body: {
        ref,
        status: "committed",
        seq,
        entityId,
        ...(component === undefined || revision === undefined ? {} : { component, revision, authorityEpoch: 1 as const }),
      },
    };
  }

  #afterCommit(): void {
    try {
      this.#afterDurableCommit?.();
    } catch {
      this.close();
      this.#closeTransport?.(1011, "durable mutation committed but response failed");
      throw new PostCommitResponseFailure();
    }
  }
}

class PostCommitResponseFailure extends Error {}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return `number:${String(value)}`;
  return JSON.stringify(value);
}

function completeState(component: MutableP1Component, value: unknown): P1TransformState | P1MaterialState {
  if (!isRecord(value)) throw new P1StoreError("invalid_component_state", "Component state must be an object.");
  const allowed = component === "hvtp.transform@1" ? ["position", "rotation", "scale"] : ["baseColor"];
  if (!hasExactlyKeys(value, allowed)) throw new P1StoreError("invalid_component_state", "Component state has missing or unsupported fields.");
  return value as unknown as P1TransformState | P1MaterialState;
}

function applyPatch(
  component: MutableP1Component,
  current: P1TransformState | P1MaterialState,
  patch: unknown,
): P1TransformState | P1MaterialState {
  if (!isRecord(patch)) throw new P1StoreError("invalid_component_state", "Merge Patch must be a non-empty object.");
  const keys = Object.keys(patch);
  const allowed = component === "hvtp.transform@1" ? ["position", "rotation", "scale"] : ["baseColor"];
  if (keys.length === 0 || keys.some((key) => !allowed.includes(key))) {
    throw new P1StoreError("invalid_component_state", "Merge Patch must contain only allowed non-empty component fields.");
  }
  const result: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = value;
  }
  return completeState(component, result);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function cloneSubscription(subscription: SubscriptionSelector): SubscriptionSelector {
  const result: {
    spatial?: { center: [number, number, number]; radius: number };
    entities?: string[];
  } = {};
  if (subscription.spatial !== undefined) {
    result.spatial = {
      center: [...subscription.spatial.center] as [number, number, number],
      radius: subscription.spatial.radius,
    };
  }
  if (subscription.entities !== undefined) result.entities = [...subscription.entities];
  return result;
}

function createPresenceEntity(
  entityId: string,
  participantId: string,
  kind: ParticipantKind,
): P1PresenceEntity {
  return {
    id: entityId,
    components: {
      "hvtp.transform@1": {
        revision: 1,
        authority: "host",
        authorityEpoch: 1,
        consistency: "authoritative",
        state: {
          position: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      },
      "hvtp.presence@1": {
        revision: 1,
        authority: "host",
        authorityEpoch: 1,
        consistency: "authoritative",
        state: {
          participantId,
          kind,
        },
      },
    },
  };
}
