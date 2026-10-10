import {
  HVTP_VERSION, P1_LIMITS, P1_POSITION_LIMIT_METERS, P1_REALM_ID,
  type CanonicalPublicationMessage, type EntitySnapshotMessage, type ErrorMessage, type MutationAckMessage,
  type P1ComponentEnvelope, type P1MaterialState, type P1MutableComponent, type P1PresenceEntity,
  type P1RenderableState, type P1SharedEntity, type P1TransformState, type RealmJoinedMessage,
  type RealmSnapshotBeginMessage, type RealmSnapshotEndMessage, type SessionWelcomeMessage,
  type SubscriptionAppliedMessage, type SubscriptionSelector,
} from "@hvtp/protocol-types";
import { P1ProtocolViolationError } from "./errors.js";
import { parseJsonObject } from "./json.js";

/** Canonical client view record: exactly the structured HVTP entity, never a renderer object. */
export type P1ViewEntity = P1SharedEntity | P1PresenceEntity;
export type P1Limits = { readonly [K in keyof typeof P1_LIMITS]: number };

export type P1HostMessage =
  | SessionWelcomeMessage
  | ErrorMessage
  | RealmJoinedMessage
  | RealmSnapshotBeginMessage
  | EntitySnapshotMessage
  | RealmSnapshotEndMessage
  | MutationAckMessage
  | SubscriptionAppliedMessage
  | CanonicalPublicationMessage;

export type P1PublicationType = CanonicalPublicationMessage["type"];

type JsonObject = Record<string, unknown>;

const QUATERNION_TOLERANCE = 1e-5;
const MAX_SCALE = 1000;

export const P1_FIXTURE_RENDERABLE = { uri: "unit-cube.gltf", mediaType: "model/gltf+json", node: "UnitCube" } as const;

/**
 * Parses one host text frame into a validated, deep-frozen P1 message. Any deviation from the P1 wire
 * contract throws `P1ProtocolViolationError`; the client never repairs host output.
 */
export function parseHostMessage(text: string): P1HostMessage {
  const message = parseJsonObject(text);
  // Host-generated IDs are opaque to clients (§14.0): unlike a client request ID, no length bound applies.
  opaque(message.id, "message id");
  if (message.hvtp !== HVTP_VERSION) violation("Host message is not HVTP 0.2.");
  const type = message.type;
  switch (type) {
    case "session.welcome": return deepFreeze(welcome(message));
    case "error": return deepFreeze(error(message));
    case "realm.joined": return deepFreeze(joined(message));
    case "realm.snapshot.begin": {
      const body = realmEnvelope(message, false);
      closed(body, ["snapshotId", "subscriptionId", "snapshotBaseSeq"], [], type);
      opaque(body.snapshotId, "snapshotId"); opaque(body.subscriptionId, "subscriptionId");
      sequence(body.snapshotBaseSeq, "snapshotBaseSeq");
      return deepFreeze(message as unknown as RealmSnapshotBeginMessage);
    }
    case "entity.snapshot": {
      const body = realmEnvelope(message, false);
      closed(body, ["snapshotId", "snapshotBaseSeq", "entity"], [], type);
      opaque(body.snapshotId, "snapshotId"); sequence(body.snapshotBaseSeq, "snapshotBaseSeq");
      viewEntity(body.entity);
      return deepFreeze(message as unknown as EntitySnapshotMessage);
    }
    case "realm.snapshot.end": {
      const body = realmEnvelope(message, false);
      closed(body, ["snapshotId", "subscriptionId", "snapshotBaseSeq", "entityCount"], [], type);
      opaque(body.snapshotId, "snapshotId"); opaque(body.subscriptionId, "subscriptionId");
      sequence(body.snapshotBaseSeq, "snapshotBaseSeq"); sequence(body.entityCount, "entityCount");
      return deepFreeze(message as unknown as RealmSnapshotEndMessage);
    }
    case "ack": return deepFreeze(ack(message));
    case "subscription.applied": {
      const body = realmEnvelope(message, false);
      closed(body, ["ref", "previousSubscriptionId", "subscriptionId", "baseRealmSeq", "effectiveSubscription"], [], type);
      opaque(body.ref, "ref"); opaque(body.previousSubscriptionId, "previousSubscriptionId");
      opaque(body.subscriptionId, "subscriptionId"); sequence(body.baseRealmSeq, "baseRealmSeq");
      selector(body.effectiveSubscription);
      return deepFreeze(message as unknown as SubscriptionAppliedMessage);
    }
    case "entity.created":
    case "component.updated":
    case "entity.deleted":
    case "view.entity.enter":
    case "view.entity.leave":
      return deepFreeze(publication(message, type));
    default:
      return violation(`Unsupported host message type: ${String(type)}`);
  }
}

function welcome(message: JsonObject): SessionWelcomeMessage {
  closed(message, ["hvtp", "id", "type", "body"], [], "session.welcome");
  const body = object(message.body, "session.welcome body");
  closed(body, ["version", "participantId", "server", "assetBaseUri", "limits"], [], "session.welcome body");
  if (body.version !== HVTP_VERSION) violation("session.welcome selected a version other than HVTP 0.2.");
  opaque(body.participantId, "participantId");
  const server = object(body.server, "server");
  closed(server, ["name", "version"], [], "server");
  if (typeof server.name !== "string" || typeof server.version !== "string") violation("server name/version must be strings.");
  if (typeof body.assetBaseUri !== "string") violation("assetBaseUri must be a string.");
  let base: URL;
  try {
    base = new URL(body.assetBaseUri);
  } catch {
    return violation("assetBaseUri must be an absolute URI.");
  }
  if ((base.protocol !== "http:" && base.protocol !== "https:") || !body.assetBaseUri.endsWith("/")) {
    violation("assetBaseUri must be an absolute HTTP(S) URI ending in '/'.");
  }
  const limits = object(body.limits, "limits");
  closed(limits, Object.keys(P1_LIMITS), [], "limits");
  for (const [name, value] of Object.entries(limits)) positiveInteger(value, `limits.${name}`);
  return message as unknown as SessionWelcomeMessage;
}

function error(message: JsonObject): ErrorMessage {
  closed(message, ["hvtp", "id", "type", "body"], ["realm", "realmEpoch"], "error");
  if (Object.hasOwn(message, "realm") !== Object.hasOwn(message, "realmEpoch")) violation("error realm/realmEpoch must appear together.");
  if (Object.hasOwn(message, "realm")) realmIdentity(message);
  const body = object(message.body, "error body");
  closed(body, ["ref", "code", "message"], ["entityId", "component", "currentRevision", "authorityEpoch"], "error body");
  if (body.ref !== null) opaque(body.ref, "error ref");
  if (typeof body.code !== "string" || body.code.length === 0) violation("error code must be a non-empty string.");
  if (typeof body.message !== "string") violation("error message must be a string.");
  return message as unknown as ErrorMessage;
}

function joined(message: JsonObject): RealmJoinedMessage {
  const body = realmEnvelope(message, false);
  closed(body, ["participantId", "presenceEntityId", "subscriptionId", "effectiveSubscription", "snapshotId",
    "snapshotBaseSeq", "requiredComponents"], [], "realm.joined body");
  opaque(body.participantId, "participantId"); opaque(body.presenceEntityId, "presenceEntityId");
  opaque(body.subscriptionId, "subscriptionId"); opaque(body.snapshotId, "snapshotId");
  sequence(body.snapshotBaseSeq, "snapshotBaseSeq");
  selector(body.effectiveSubscription);
  if (!Array.isArray(body.requiredComponents) || body.requiredComponents.some((c) => typeof c !== "string")) {
    violation("requiredComponents must be an array of strings.");
  }
  return message as unknown as RealmJoinedMessage;
}

function ack(message: JsonObject): MutationAckMessage {
  const body = realmEnvelope(message, false);
  closed(body, ["ref", "status", "seq", "entityId"], ["component", "revision", "authorityEpoch"], "ack body");
  opaque(body.ref, "ref");
  if (body.status !== "committed") violation("ack status must be committed.");
  sequence(body.seq, "ack seq");
  opaque(body.entityId, "entityId");
  const contextFields = ["component", "revision", "authorityEpoch"].filter((key) => Object.hasOwn(body, key)).length;
  if (contextFields !== 0 && contextFields !== 3) violation("ack component/revision/authorityEpoch must appear together.");
  if (contextFields === 3) {
    mutableComponentName(body.component);
    positiveInteger(body.revision, "ack revision");
    positiveInteger(body.authorityEpoch, "ack authorityEpoch");
  }
  return message as unknown as MutationAckMessage;
}

function publication(message: JsonObject, type: P1PublicationType): CanonicalPublicationMessage {
  const body = realmEnvelope(message, true);
  switch (type) {
    case "entity.created":
      closed(body, ["subscriptionId", "entity"], [], type);
      viewEntity(body.entity);
      break;
    case "view.entity.enter":
      closed(body, ["subscriptionId", "reason", "entity"], [], type);
      enterReason(body.reason);
      viewEntity(body.entity);
      break;
    case "component.updated": {
      closed(body, ["subscriptionId", "entityId", "component", "value"], [], type);
      opaque(body.entityId, "entityId");
      const component = mutableComponentName(body.component);
      if (component === "hvtp.transform@1") envelope(body.value, transformState, component);
      else envelope(body.value, materialState, component);
      break;
    }
    case "entity.deleted":
      closed(body, ["subscriptionId", "entityId"], [], type);
      opaque(body.entityId, "entityId");
      break;
    case "view.entity.leave":
      closed(body, ["subscriptionId", "reason", "entityId"], [], type);
      leaveReason(body.reason);
      opaque(body.entityId, "entityId");
      break;
  }
  opaque(body.subscriptionId, "subscriptionId");
  return message as unknown as CanonicalPublicationMessage;
}

function realmEnvelope(message: JsonObject, withSeq: boolean): JsonObject {
  const keys = ["hvtp", "id", "type", "realm", "realmEpoch", "body"];
  closed(message, withSeq ? [...keys, "seq"] : keys, [], String(message.type));
  realmIdentity(message);
  if (withSeq) sequence(message.seq, "seq");
  return object(message.body, `${String(message.type)} body`);
}

function realmIdentity(message: JsonObject): void {
  if (message.realm !== P1_REALM_ID) violation("Message realm is not the P1 prototype realm.");
  opaque(message.realmEpoch, "realmEpoch");
}

function enterReason(value: unknown): void {
  if (value !== "subscription" && value !== "interest") violation("Invalid view.entity.enter reason.");
}

/** `authorization` is a leave-only reason (§14.15); the P1 enter reasons are `subscription` and `interest`. */
function leaveReason(value: unknown): void {
  if (value !== "subscription" && value !== "interest" && value !== "authorization") violation("Invalid view.entity.leave reason.");
}

function mutableComponentName(value: unknown): P1MutableComponent {
  if (value !== "hvtp.transform@1" && value !== "hvtp.material@1") violation("Only transform/material components are mutable in P1.");
  return value;
}

/** Validates a complete P1 entity record (shared fixture entity or participant presence). */
export function viewEntity(value: unknown): P1ViewEntity {
  const entity = object(value, "entity");
  closed(entity, ["id", "components"], [], "entity");
  opaque(entity.id, "entity id");
  const components = object(entity.components, "entity components");
  if (Object.hasOwn(components, "hvtp.presence@1")) {
    closed(components, ["hvtp.transform@1", "hvtp.presence@1"], [], "presence entity components");
    envelope(components["hvtp.transform@1"], transformState, "hvtp.transform@1");
    envelope(components["hvtp.presence@1"], presenceState, "hvtp.presence@1");
    return entity as unknown as P1PresenceEntity;
  }
  closed(components, ["hvtp.transform@1", "hvtp.renderable@1", "hvtp.material@1"], [], "shared entity components");
  envelope(components["hvtp.transform@1"], transformState, "hvtp.transform@1");
  envelope(components["hvtp.renderable@1"], renderableState, "hvtp.renderable@1");
  envelope(components["hvtp.material@1"], materialState, "hvtp.material@1");
  return entity as unknown as P1SharedEntity;
}

export function isPresenceEntity(entity: P1ViewEntity): entity is P1PresenceEntity {
  return Object.hasOwn(entity.components, "hvtp.presence@1");
}

function envelope<State>(value: unknown, state: (value: unknown) => State, name: string): P1ComponentEnvelope<State> {
  const component = object(value, name);
  closed(component, ["revision", "authority", "authorityEpoch", "consistency", "state"], [], name);
  positiveInteger(component.revision, `${name} revision`);
  positiveInteger(component.authorityEpoch, `${name} authorityEpoch`);
  if (component.authority !== "host") violation(`${name} authority must be host.`);
  if (component.consistency !== "authoritative") violation(`${name} consistency must be authoritative.`);
  state(component.state);
  return component as unknown as P1ComponentEnvelope<State>;
}

function transformState(value: unknown): P1TransformState {
  const state = object(value, "transform state");
  closed(state, ["position", "rotation", "scale"], [], "transform state");
  const position = numbers(state.position, 3, "position");
  if (position.some((v) => v < -P1_POSITION_LIMIT_METERS || v > P1_POSITION_LIMIT_METERS)) violation("position outside P1 range.");
  const rotation = numbers(state.rotation, 4, "rotation");
  if (Math.abs(Math.hypot(...rotation) - 1) > QUATERNION_TOLERANCE) violation("rotation quaternion is not normalized.");
  const scale = numbers(state.scale, 3, "scale");
  if (scale.some((v) => v <= 0 || v > MAX_SCALE)) violation("scale outside P1 range.");
  return state as unknown as P1TransformState;
}

function renderableState(value: unknown): P1RenderableState {
  const state = object(value, "renderable state");
  closed(state, ["asset", "node", "visible"], [], "renderable state");
  const asset = object(state.asset, "renderable asset");
  closed(asset, ["uri", "mediaType"], [], "renderable asset");
  if (asset.uri !== P1_FIXTURE_RENDERABLE.uri || asset.mediaType !== P1_FIXTURE_RENDERABLE.mediaType ||
      state.node !== P1_FIXTURE_RENDERABLE.node || typeof state.visible !== "boolean") {
    violation("renderable state is not the P1 unit-cube fixture reference.");
  }
  return state as unknown as P1RenderableState;
}

function materialState(value: unknown): P1MaterialState {
  const state = object(value, "material state");
  closed(state, ["baseColor"], [], "material state");
  if (numbers(state.baseColor, 4, "baseColor").some((v) => v < 0 || v > 1)) violation("baseColor outside [0, 1].");
  return state as unknown as P1MaterialState;
}

function presenceState(value: unknown): unknown {
  const state = object(value, "presence state");
  closed(state, ["participantId", "kind"], [], "presence state");
  opaque(state.participantId, "presence participantId");
  if (state.kind !== "human" && state.kind !== "agent") violation("presence kind must be human or agent.");
  return state;
}

function selector(value: unknown): SubscriptionSelector {
  const selector = object(value, "subscription selector");
  closed(selector, [], ["spatial", "entities"], "subscription selector");
  if (Object.hasOwn(selector, "spatial")) {
    const spatial = object(selector.spatial, "spatial");
    closed(spatial, ["center", "radius"], [], "spatial");
    numbers(spatial.center, 3, "spatial center");
    if (typeof spatial.radius !== "number" || !Number.isFinite(spatial.radius) || spatial.radius < 0) violation("Invalid spatial radius.");
  }
  if (Object.hasOwn(selector, "entities")) {
    if (!Array.isArray(selector.entities)) violation("entities must be an array.");
    for (const id of selector.entities) opaque(id, "selector entity id");
  }
  return selector as SubscriptionSelector;
}

function numbers(value: unknown, length: number, name: string): number[] {
  if (!Array.isArray(value) || value.length !== length || value.some((v) => typeof v !== "number" || !Number.isFinite(v))) {
    violation(`${name} must contain ${length} finite numbers.`);
  }
  return value as number[];
}

function object(value: unknown, name: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) violation(`${name} must be an object.`);
  return value as JsonObject;
}

function closed(value: unknown, required: readonly string[], optional: readonly string[], name: string): void {
  const record = object(value, name);
  const allowed = new Set([...required, ...optional]);
  if (!Object.keys(record).every((key) => allowed.has(key)) || !required.every((key) => Object.hasOwn(record, key))) {
    violation(`${name} does not match the closed P1 shape.`);
  }
}

/** Host-issued IDs are opaque to clients (§14.0); only non-emptiness is assumed. */
function opaque(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) violation(`${name} must be a non-empty opaque ID.`);
  return value;
}

function sequence(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) violation(`${name} must be a nonnegative safe integer.`);
  return value as number;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) violation(`${name} must be a positive safe integer.`);
  return value as number;
}

function violation(message: string): never {
  throw new P1ProtocolViolationError(message);
}

/** Canonical records are shared with adapters by reference; freezing makes accidental mutation fail loudly. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
