import {
  HVTP_VERSION, P1_REALM_ID, P1_REQUIRED_COMPONENTS,
  type CanonicalPublicationMessage, type ErrorMessage, type MutationAckMessage, type P1MaterialState,
  type P1MutableComponent, type P1RenderableState, type P1SharedEntity, type P1TransformState, type ParticipantKind,
  type RealmJoinedMessage, type SubscriptionAppliedMessage, type SubscriptionSelector,
} from "@hvtp/protocol-types";
import {
  P1ClientStateError, P1ConnectionError, P1OutcomeUncertainError, P1ProtocolViolationError, P1RequestError,
} from "./errors.js";
import { randomId } from "./ids.js";
import {
  CLIENT_CLOSE_NORMAL, CLIENT_CLOSE_PROTOCOL_VIOLATION, platformSocketFactory, type P1Socket, type P1SocketFactory,
} from "./socket.js";
import {
  deepFreeze, isPresenceEntity, P1_FIXTURE_RENDERABLE, parseHostMessage,
  type P1HostMessage, type P1Limits, type P1PublicationType, type P1ViewEntity,
} from "./wire.js";

/**
 * Client connection phases. The client is LIVE only after a complete, validated initial snapshot has been
 * activated atomically.
 */
export type P1ClientPhase = "disconnected" | "connecting" | "negotiating" | "joining" | "snapshot" | "live";

export type P1EntityView = ReadonlyMap<string, P1ViewEntity>;

export type P1ClientEvent =
  | { readonly type: "phase"; readonly phase: P1ClientPhase }
  /** The whole active view was replaced: a fresh snapshot activated, or the session ended (empty view). */
  | { readonly type: "view.reset"; readonly reason: "snapshot" | "disconnect"; readonly entities: P1EntityView }
  | { readonly type: "entity.upsert"; readonly cause: "created" | "updated" | "enter"; readonly entity: P1ViewEntity }
  | { readonly type: "entity.remove"; readonly cause: "deleted" | "leave"; readonly entityId: string }
  | { readonly type: "subscription.activated"; readonly previousSubscriptionId: string; readonly subscriptionId: string;
      readonly effectiveSubscription: SubscriptionSelector }
  /** A subscriber-scoped publication for a non-active generation was ignored (Profile §10.1, C28). */
  | { readonly type: "publication.stale"; readonly messageType: P1PublicationType; readonly subscriptionId: string }
  /** An `error` that correlates to no in-flight request (e.g. `ref: null` before a host-initiated close). */
  | { readonly type: "host.error"; readonly body: ErrorMessage["body"] }
  | { readonly type: "protocol.violation"; readonly error: P1ProtocolViolationError }
  | { readonly type: "closed"; readonly code: number; readonly reason: string; readonly uncertainRequestIds: readonly string[] };

export type P1ClientListener = (event: P1ClientEvent) => void;

export interface P1ClientOptions {
  /** Host WebSocket URL, e.g. `ws://127.0.0.1:8787/hvtp`. */
  readonly url: string;
  readonly socketFactory?: P1SocketFactory;
  /** Defaults to `human`; a headless participant passes `agent`. */
  readonly participantKind?: ParticipantKind;
  readonly clientName?: string;
  readonly clientVersion?: string;
  /** Initial `realm.join` selector. Defaults to `{}` (own presence only). */
  readonly subscription?: SubscriptionSelector;
  /** Collision-resistant ID source; tests inject a deterministic one. */
  readonly createId?: (prefix: string) => string;
}

export type P1Ack = MutationAckMessage["body"];

export interface P1SubscriptionResult {
  readonly body: SubscriptionAppliedMessage["body"];
  /**
   * True only when this response answered the pending request and its `previousSubscriptionId` equalled the
   * active generation, so the new generation was activated. A stale/cached response is terminal information
   * only and is `false`.
   */
  readonly activated: boolean;
}

export interface P1CreateEntityInput {
  readonly id?: string;
  readonly transform: P1TransformState;
  readonly material: P1MaterialState;
  /** Defaults to the P1 fixture reference with `visible: true`. */
  readonly renderable?: P1RenderableState;
}

export interface P1MutationOptions {
  /** Defaults to the revision in the canonical active view. Required when the entity is not in view. */
  readonly baseRevision?: number;
  readonly authorityEpoch?: number;
}

type StateChangingType = "entity.create" | "entity.delete" | "component.set" | "component.patch" | "subscription.set";

interface PendingRequest {
  readonly type: StateChangingType;
  readonly resolve: (value: never) => void;
  readonly reject: (error: Error) => void;
}

interface PendingSnapshot {
  readonly realmEpoch: string;
  readonly snapshotId: string;
  readonly snapshotBaseSeq: number;
  readonly subscriptionId: string;
  readonly effectiveSubscription: SubscriptionSelector;
  readonly presenceEntityId: string;
  began: boolean;
  readonly entities: Map<string, P1ViewEntity>;
}

interface Connection {
  readonly socket: P1Socket;
  readonly helloId: string;
  readonly joinId: string;
  readonly subscription: SubscriptionSelector;
  readonly ready: { resolve: () => void; reject: (error: Error) => void };
}

const EMPTY_VIEW: P1EntityView = new Map();
const textEncoder = new TextEncoder();

/**
 * Engine-neutral P1 session client. Owns the WebSocket lifecycle, negotiation, join, atomic snapshot
 * activation, the canonical active entity view, subscription generations, and request correlation.
 *
 * The canonical view changes only from host-authoritative subscriber messages or a fresh snapshot. Sending a
 * mutation never changes it optimistically. Renderers derive their objects from the emitted events.
 */
export class P1Client {
  readonly #options: P1ClientOptions;
  readonly #createId: (prefix: string) => string;
  readonly #listeners = new Set<P1ClientListener>();

  #phase: P1ClientPhase = "disconnected";
  #connection: Connection | null = null;
  #joinSubscription: SubscriptionSelector;

  // Session-scoped state; cleared on every close.
  #participantId: string | null = null;
  #assetBaseUri: string | null = null;
  #limits: P1Limits | null = null;
  #realmEpoch: string | null = null;
  #presenceEntityId: string | null = null;
  #subscriptionId: string | null = null;
  #effectiveSubscription: SubscriptionSelector | null = null;
  #pendingSnapshot: PendingSnapshot | null = null;
  #entities: Map<string, P1ViewEntity> = new Map();
  readonly #pending = new Map<string, PendingRequest>();

  constructor(options: P1ClientOptions) {
    this.#options = options;
    this.#createId = options.createId ?? randomId;
    this.#joinSubscription = options.subscription ?? {};
  }

  get phase(): P1ClientPhase { return this.#phase; }
  get participantId(): string | null { return this.#participantId; }
  get assetBaseUri(): string | null { return this.#assetBaseUri; }
  get limits(): P1Limits | null { return this.#limits; }
  get realmEpoch(): string | null { return this.#realmEpoch; }
  get presenceEntityId(): string | null { return this.#presenceEntityId; }
  get subscriptionId(): string | null { return this.#subscriptionId; }
  get effectiveSubscription(): SubscriptionSelector | null { return this.#effectiveSubscription; }
  /** The canonical active view (empty unless LIVE). Records are deep-frozen host state. */
  get entities(): P1EntityView { return this.#entities; }
  get pendingRequestCount(): number { return this.#pending.size; }

  on(listener: P1ClientListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Opens a new session: hello → welcome → join → snapshot → LIVE. Resolves once the initial snapshot has
   * been activated. Every call is a fresh session; nothing from a previous session is replayed.
   */
  connect(options: { readonly subscription?: SubscriptionSelector } = {}): Promise<void> {
    if (this.#phase !== "disconnected") return Promise.reject(new P1ClientStateError(`Cannot connect while ${this.#phase}.`));
    const subscription = options.subscription ?? this.#joinSubscription;
    this.#joinSubscription = subscription;
    return new Promise<void>((resolve, reject) => {
      let socket: P1Socket;
      try {
        socket = (this.#options.socketFactory ?? platformSocketFactory)(this.#options.url);
      } catch (error) {
        reject(new P1ConnectionError("Could not open WebSocket.", error));
        return;
      }
      const connection: Connection = {
        socket, subscription, ready: { resolve, reject },
        helloId: this.#createId("req-hello"), joinId: this.#createId("req-join"),
      };
      this.#connection = connection;
      socket.onopen = () => {
        if (this.#connection !== connection) return;
        this.#setPhase("negotiating");
        this.#write(connection, {
          hvtp: HVTP_VERSION, id: connection.helloId, type: "session.hello",
          body: {
            versions: [HVTP_VERSION],
            client: { name: this.#options.clientName ?? "hvtp-client-core", version: this.#options.clientVersion ?? "0.1.0" },
            participant: { kind: this.#options.participantKind ?? "human" },
            capabilities: { components: [...P1_REQUIRED_COMPONENTS] },
          },
        });
      };
      socket.onmessage = (event) => {
        if (this.#connection !== connection) return;
        if (typeof event.data !== "string") {
          this.#violate(new P1ProtocolViolationError("P1 host messages must be JSON text frames."));
          return;
        }
        let message: P1HostMessage;
        try {
          message = parseHostMessage(event.data);
        } catch (error) {
          this.#violate(error instanceof P1ProtocolViolationError ? error : new P1ProtocolViolationError(String(error)));
          return;
        }
        try {
          this.#handle(connection, message);
        } catch (error) {
          if (error instanceof P1ProtocolViolationError) this.#violate(error);
          else throw error;
        }
      };
      socket.onclose = (event) => {
        if (this.#connection === connection) this.#teardown(event.code, event.reason, new P1ConnectionError(`Connection closed (${event.code}) before LIVE.`));
      };
      socket.onerror = () => { /* a close event always follows */ };
      this.#setPhase("connecting");
    });
  }

  /** Closes the session. Sent-but-unresolved state-changing requests become outcome-uncertain. */
  disconnect(): void {
    const connection = this.#connection;
    if (connection === null) return;
    connection.socket.close(CLIENT_CLOSE_NORMAL, "client disconnect");
    this.#teardown(CLIENT_CLOSE_NORMAL, "client disconnect", new P1ConnectionError("Disconnected before LIVE."));
  }

  createEntity(input: P1CreateEntityInput): Promise<P1Ack> {
    const renderable = input.renderable ?? {
      asset: { uri: P1_FIXTURE_RENDERABLE.uri, mediaType: P1_FIXTURE_RENDERABLE.mediaType },
      node: P1_FIXTURE_RENDERABLE.node, visible: true,
    };
    return this.#request("entity.create", {
      entity: {
        id: input.id ?? this.#createId("entity"),
        components: {
          "hvtp.transform@1": { state: input.transform },
          "hvtp.renderable@1": { state: renderable },
          "hvtp.material@1": { state: input.material },
        },
      },
    });
  }

  deleteEntity(entityId: string): Promise<P1Ack> {
    return this.#request("entity.delete", { entityId });
  }

  setComponent(entityId: string, component: P1MutableComponent, state: P1TransformState | P1MaterialState,
    options: P1MutationOptions = {}): Promise<P1Ack> {
    return this.#componentRequest("component.set", entityId, component, "state", state, options);
  }

  /** Sends an RFC 7396 merge patch. The local canonical view is not patched; it follows `component.updated`. */
  patchComponent(entityId: string, component: P1MutableComponent, patch: Partial<P1TransformState> | Partial<P1MaterialState>,
    options: P1MutationOptions = {}): Promise<P1Ack> {
    return this.#componentRequest("component.patch", entityId, component, "patch", patch, options);
  }

  setSubscription(selector: SubscriptionSelector): Promise<P1SubscriptionResult> {
    return this.#request("subscription.set", selector);
  }

  #componentRequest(type: "component.set" | "component.patch", entityId: string, component: P1MutableComponent,
    field: "state" | "patch", value: unknown, options: P1MutationOptions): Promise<P1Ack> {
    const entity = this.#entities.get(entityId);
    const current = entity !== undefined && !isPresenceEntity(entity) ? entity.components[component] : undefined;
    const baseRevision = options.baseRevision ?? current?.revision;
    const authorityEpoch = options.authorityEpoch ?? current?.authorityEpoch;
    if (baseRevision === undefined || authorityEpoch === undefined) {
      return Promise.reject(new P1ClientStateError(`${entityId} is not in the active view; pass baseRevision/authorityEpoch.`));
    }
    return this.#request(type, { entityId, component, authorityEpoch, baseRevision, [field]: value });
  }

  #request<T>(type: StateChangingType, body: unknown): Promise<T> {
    const connection = this.#connection;
    if (this.#phase !== "live" || connection === null || this.#limits === null) {
      return Promise.reject(new P1ClientStateError(`${type} requires a LIVE session (currently ${this.#phase}).`));
    }
    if (this.#pending.size >= this.#limits.maxPendingStateChangingRequests) {
      return Promise.reject(new P1ClientStateError("maxPendingStateChangingRequests reached; wait for terminal results."));
    }
    const id = this.#createId("req");
    const text = JSON.stringify({ hvtp: HVTP_VERSION, id, type, realm: P1_REALM_ID, body });
    if (textEncoder.encode(text).byteLength > this.#limits.maxMessageBytes) {
      return Promise.reject(new P1ClientStateError("Request exceeds advertised maxMessageBytes."));
    }
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { type, resolve: resolve as (value: never) => void, reject });
      connection.socket.send(text);
    });
  }

  #handle(connection: Connection, message: P1HostMessage): void {
    if (message.type === "error") {
      this.#handleError(connection, message);
      return;
    }
    switch (this.#phase) {
      case "negotiating":
        if (message.type !== "session.welcome") return violation(`Expected session.welcome, received ${message.type}.`);
        this.#participantId = message.body.participantId;
        this.#assetBaseUri = message.body.assetBaseUri;
        this.#limits = message.body.limits;
        this.#setPhase("joining");
        this.#write(connection, {
          hvtp: HVTP_VERSION, id: connection.joinId, type: "realm.join",
          body: { realm: P1_REALM_ID, subscription: connection.subscription },
        });
        return;
      case "joining":
        if (message.type !== "realm.joined") return violation(`Expected realm.joined, received ${message.type}.`);
        this.#beginSnapshot(message);
        return;
      case "snapshot":
        this.#assembleSnapshot(connection, message);
        return;
      case "live":
        this.#handleLive(message);
        return;
      default:
        return violation(`Unexpected ${message.type} while ${this.#phase}.`);
    }
  }

  #handleError(connection: Connection, message: ErrorMessage): void {
    const epoch = this.#realmEpoch ?? this.#pendingSnapshot?.realmEpoch;
    if (message.realmEpoch !== undefined && epoch !== undefined && message.realmEpoch !== epoch) {
      return violation("error carries a different realmEpoch.");
    }
    const ref = message.body.ref;
    if (ref !== null && (ref === connection.helloId || ref === connection.joinId)) {
      // Negotiation/join was rejected: no session to keep.
      connection.socket.close(CLIENT_CLOSE_NORMAL, "session setup rejected");
      this.#teardown(CLIENT_CLOSE_NORMAL, "session setup rejected", new P1RequestError(message.body));
      return;
    }
    const pending = ref === null ? undefined : this.#pending.get(ref);
    if (pending === undefined) {
      this.#emit({ type: "host.error", body: message.body });
      return;
    }
    this.#pending.delete(ref!);
    pending.reject(new P1RequestError(message.body));
  }

  #beginSnapshot(message: RealmJoinedMessage): void {
    if (message.body.participantId !== this.#participantId) violation("realm.joined participantId differs from session.welcome.");
    for (const component of P1_REQUIRED_COMPONENTS) {
      if (!message.body.requiredComponents.includes(component)) violation(`realm.joined omits required component ${component}.`);
    }
    this.#pendingSnapshot = {
      realmEpoch: message.realmEpoch, snapshotId: message.body.snapshotId, snapshotBaseSeq: message.body.snapshotBaseSeq,
      subscriptionId: message.body.subscriptionId, effectiveSubscription: message.body.effectiveSubscription,
      presenceEntityId: message.body.presenceEntityId, began: false, entities: new Map(),
    };
    this.#setPhase("snapshot");
  }

  /**
   * Builds the replacement view in a private map. Nothing reaches the active view until a fully consistent
   * `realm.snapshot.end`; any inconsistency or interleaved live traffic discards the whole snapshot (C30).
   */
  #assembleSnapshot(connection: Connection, message: P1HostMessage): void {
    const pending = this.#pendingSnapshot!;
    if (message.type !== "realm.snapshot.begin" && message.type !== "entity.snapshot" && message.type !== "realm.snapshot.end") {
      return violation(`${message.type} arrived while the initial snapshot was incomplete.`);
    }
    if (message.realmEpoch !== pending.realmEpoch) violation(`${message.type} realmEpoch differs from realm.joined.`);
    if (message.body.snapshotId !== pending.snapshotId) violation(`${message.type} snapshotId differs from realm.joined.`);
    if (message.body.snapshotBaseSeq !== pending.snapshotBaseSeq) violation(`${message.type} snapshotBaseSeq differs from realm.joined.`);

    if (message.type === "realm.snapshot.begin") {
      if (pending.began) violation("Duplicate realm.snapshot.begin.");
      if (message.body.subscriptionId !== pending.subscriptionId) violation("realm.snapshot.begin subscriptionId differs from realm.joined.");
      pending.began = true;
      return;
    }
    if (!pending.began) violation(`${message.type} before realm.snapshot.begin.`);

    if (message.type === "entity.snapshot") {
      const entity = message.body.entity;
      if (pending.entities.has(entity.id)) violation(`Duplicate entity ${entity.id} in snapshot.`);
      if (isPresenceEntity(entity)) {
        // P1 read policy: the only presence a participant may ever see is its own.
        if (entity.id !== pending.presenceEntityId || entity.components["hvtp.presence@1"].state.participantId !== this.#participantId) {
          violation("Snapshot contains a presence entity that is not this participant's own.");
        }
      }
      pending.entities.set(entity.id, entity);
      return;
    }

    if (message.body.subscriptionId !== pending.subscriptionId) violation("realm.snapshot.end subscriptionId differs from realm.joined.");
    if (message.body.entityCount !== pending.entities.size) {
      violation(`realm.snapshot.end entityCount ${message.body.entityCount} != ${pending.entities.size} records.`);
    }
    if (!pending.entities.has(pending.presenceEntityId)) violation("Snapshot omits this participant's presence entity.");

    // Atomic activation: the completed snapshot replaces the active view in one step.
    this.#pendingSnapshot = null;
    this.#realmEpoch = pending.realmEpoch;
    this.#presenceEntityId = pending.presenceEntityId;
    this.#subscriptionId = pending.subscriptionId;
    this.#effectiveSubscription = pending.effectiveSubscription;
    this.#entities = pending.entities;
    this.#setPhase("live");
    this.#emit({ type: "view.reset", reason: "snapshot", entities: this.#entities });
    connection.ready.resolve();
  }

  #handleLive(message: Exclude<P1HostMessage, ErrorMessage>): void {
    if (message.type === "session.welcome" || message.type === "realm.joined" || message.type === "realm.snapshot.begin" ||
        message.type === "entity.snapshot" || message.type === "realm.snapshot.end") {
      return violation(`${message.type} is not valid on a LIVE connection.`);
    }
    if (message.realmEpoch !== this.#realmEpoch) violation(`${message.type} realmEpoch differs from the active epoch.`);

    if (message.type === "ack") {
      const pending = this.#pending.get(message.body.ref);
      if (pending === undefined) return; // Terminal for nothing in flight in this session (e.g. a cached duplicate).
      if (pending.type === "subscription.set") violation("ack received for a subscription.set request.");
      this.#pending.delete(message.body.ref);
      pending.resolve(message.body as never);
      return;
    }
    if (message.type === "subscription.applied") {
      this.#subscriptionApplied(message);
      return;
    }
    this.#publication(message);
  }

  /**
   * Activation rule (Profile §10.1, C28). A response may activate a generation only when it answers a pending
   * `subscription.set` AND continues from the currently active generation with a new subscription ID. A response
   * that answers nothing in flight (e.g. a duplicate terminal response for a settled retransmission) is inert
   * terminal noise, like an unmatched `ack`; a response for another request kind contradicts the host contract.
   */
  #subscriptionApplied(message: SubscriptionAppliedMessage): void {
    const body = message.body;
    const pending = this.#pending.get(body.ref);
    if (pending === undefined) return;
    if (pending.type !== "subscription.set") violation(`subscription.applied received for a ${pending.type} request.`);
    // A cached response for an older, already-superseded transition fails this test: terminal information only.
    const activated = body.previousSubscriptionId === this.#subscriptionId && body.subscriptionId !== this.#subscriptionId;
    if (activated) {
      this.#subscriptionId = body.subscriptionId;
      this.#effectiveSubscription = body.effectiveSubscription;
      this.#joinSubscription = body.effectiveSubscription;
      this.#emit({ type: "subscription.activated", previousSubscriptionId: body.previousSubscriptionId,
        subscriptionId: body.subscriptionId, effectiveSubscription: body.effectiveSubscription });
    }
    this.#pending.delete(body.ref);
    pending.resolve({ body, activated } satisfies P1SubscriptionResult as never);
  }

  /**
   * Applies one subscriber publication to the canonical view. `seq` is a sparse mutation watermark and is
   * deliberately never used for gap detection or deduplication; order comes from the stream itself.
   */
  #publication(message: CanonicalPublicationMessage): void {
    if (message.body.subscriptionId !== this.#subscriptionId) {
      this.#emit({ type: "publication.stale", messageType: message.type, subscriptionId: message.body.subscriptionId });
      return;
    }
    switch (message.type) {
      case "entity.created": {
        const entity = message.body.entity;
        if (isPresenceEntity(entity)) violation("entity.created carries a presence entity.");
        if (this.#entities.has(entity.id)) violation(`entity.created for ${entity.id}, which is already in view.`);
        this.#entities.set(entity.id, entity);
        this.#emit({ type: "entity.upsert", cause: "created", entity });
        return;
      }
      case "view.entity.enter": {
        // The message alone materializes the entity; any stale local record is replaced, never merged.
        const entity = message.body.entity;
        if (isPresenceEntity(entity)) violation("view.entity.enter carries a presence entity.");
        this.#entities.set(entity.id, entity);
        this.#emit({ type: "entity.upsert", cause: "enter", entity });
        return;
      }
      case "component.updated": {
        const { entityId, component, value } = message.body;
        const current = this.#sharedEntity(entityId, message.type);
        if (value.revision <= current.components[component].revision) {
          violation(`component.updated revision ${value.revision} does not advance ${entityId} ${component}.`);
        }
        const entity = deepFreeze<P1SharedEntity>({ id: entityId, components: { ...current.components, [component]: value } });
        this.#entities.set(entityId, entity);
        this.#emit({ type: "entity.upsert", cause: "updated", entity });
        return;
      }
      case "view.entity.leave":
        // View eviction only: no tombstone, the entity may legitimately re-enter later.
        this.#sharedEntity(message.body.entityId, message.type);
        this.#entities.delete(message.body.entityId);
        this.#emit({ type: "entity.remove", cause: "leave", entityId: message.body.entityId });
        return;
      case "entity.deleted":
        this.#sharedEntity(message.body.entityId, message.type);
        this.#entities.delete(message.body.entityId);
        this.#emit({ type: "entity.remove", cause: "deleted", entityId: message.body.entityId });
        return;
    }
  }

  #sharedEntity(entityId: string, type: string): P1SharedEntity {
    const entity = this.#entities.get(entityId);
    if (entity === undefined) violation(`${type} references ${entityId}, which is not in the active view.`);
    if (isPresenceEntity(entity)) violation(`${type} targets the participant's presence entity.`);
    return entity;
  }

  #violate(error: P1ProtocolViolationError): void {
    const connection = this.#connection;
    if (connection === null) return;
    this.#emit({ type: "protocol.violation", error });
    connection.socket.close(CLIENT_CLOSE_PROTOCOL_VIOLATION, "P1 protocol violation");
    this.#teardown(CLIENT_CLOSE_PROTOCOL_VIOLATION, error.message, new P1ConnectionError("Protocol violation before LIVE.", error));
  }

  /**
   * Ends the session: every session-scoped identifier, the partial snapshot, and the active view are dropped.
   * In-flight state-changing requests become outcome-uncertain and are never replayed.
   */
  #teardown(code: number, reason: string, setupError: Error): void {
    const connection = this.#connection;
    if (connection === null) return;
    this.#connection = null;
    connection.socket.onopen = connection.socket.onmessage = connection.socket.onclose = null;
    // Keep a no-op error handler: some socket implementations emit a late error after an early close.
    connection.socket.onerror = () => {};

    const wasLive = this.#phase === "live";
    const uncertain = [...this.#pending.entries()];
    this.#pending.clear();
    this.#participantId = this.#assetBaseUri = this.#realmEpoch = this.#presenceEntityId = this.#subscriptionId = null;
    this.#limits = null;
    this.#effectiveSubscription = null;
    this.#pendingSnapshot = null;
    const hadView = this.#entities.size > 0;
    this.#entities = new Map();
    this.#setPhase("disconnected");

    if (!wasLive) connection.ready.reject(setupError);
    for (const [id, request] of uncertain) request.reject(new P1OutcomeUncertainError(id, request.type));
    if (hadView || wasLive) this.#emit({ type: "view.reset", reason: "disconnect", entities: EMPTY_VIEW });
    this.#emit({ type: "closed", code, reason, uncertainRequestIds: uncertain.map(([id]) => id) });
  }

  #write(connection: Connection, message: unknown): void {
    connection.socket.send(JSON.stringify(message));
  }

  #setPhase(phase: P1ClientPhase): void {
    if (this.#phase === phase) return;
    this.#phase = phase;
    this.#emit({ type: "phase", phase });
  }

  #emit(event: P1ClientEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        // A failing consumer (e.g. a renderer) must not corrupt client state; surface it asynchronously.
        queueMicrotask(() => { throw error; });
      }
    }
  }
}

function violation(message: string): never {
  throw new P1ProtocolViolationError(message);
}
