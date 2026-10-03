export const HVTP_VERSION = "0.2" as const;
export const P1_REALM_ID = "urn:hvtp:realm:prototype-world" as const;
export const MAX_SAFE_PROTOCOL_INTEGER = Number.MAX_SAFE_INTEGER;
export const P1_POSITION_LIMIT_METERS = 1_000_000;

export const P1_REQUIRED_COMPONENTS = [
  "hvtp.transform@1",
  "hvtp.renderable@1",
  "hvtp.material@1",
  "hvtp.presence@1",
] as const;

export const P1_LIMITS = {
  maxMessageBytes: 262_144,
  maxEntityBytes: 131_072,
  maxVisibleEntitiesPerConnection: 2_048,
  maxPersistentEntityRecords: 10_000,
  maxSubscriptionRadiusMeters: 500,
  maxExplicitEntityIds: 256,
  maxQueuedOutboundBytes: 4_194_304,
  maxClientRequestsPerSecond: 120,
  maxMutationRequestsPerSecond: 60,
  maxPendingStateChangingRequests: 256,
  maxRequestDedupEntries: 4_096,
  maxAssetBytes: 5_242_880,
  maxAssetUriCharacters: 2_048,
} as const;

export type ParticipantKind = "human" | "agent";

export type P1ErrorCode =
  | "unsupported_version"
  | "unsupported_component"
  | "unsupported_message"
  | "realm_not_found"
  | "invalid_state"
  | "invalid_json"
  | "invalid_message"
  | "invalid_component_state"
  | "not_authorized"
  | "presence_binding_violation"
  | "revision_mismatch"
  | "authority_epoch_mismatch"
  | "entity_exists"
  | "entity_not_found"
  | "request_id_conflict"
  | "resource_limit";

export interface P1ProtocolError {
  readonly code: P1ErrorCode;
  readonly ref: string | null;
  readonly message: string;
}

export interface SubscriptionSelector {
  readonly spatial?: {
    readonly center: readonly [number, number, number];
    readonly radius: number;
  };
  readonly entities?: readonly string[];
}

export interface SessionHelloRequest {
  readonly hvtp: typeof HVTP_VERSION;
  readonly id: string;
  readonly type: "session.hello";
  readonly body: {
    readonly versions: readonly string[];
    readonly client: {
      readonly name: string;
      readonly version: string;
    };
    readonly participant: {
      readonly kind: ParticipantKind;
    };
    readonly capabilities: {
      readonly components: readonly string[];
    };
  };
}

export interface RealmJoinRequest {
  readonly hvtp: typeof HVTP_VERSION;
  readonly id: string;
  readonly type: "realm.join";
  readonly body: {
    readonly realm: typeof P1_REALM_ID;
    readonly subscription: SubscriptionSelector;
  };
}

export type P1MutableComponent = "hvtp.transform@1" | "hvtp.material@1";

interface MutationRequestEnvelope {
  readonly hvtp: typeof HVTP_VERSION;
  readonly id: string;
  readonly realm: typeof P1_REALM_ID;
}

export interface EntityCreateRequest extends MutationRequestEnvelope {
  readonly type: "entity.create";
  readonly body: { readonly entity: P1SharedEntityInput };
}

export interface EntityDeleteRequest extends MutationRequestEnvelope {
  readonly type: "entity.delete";
  readonly body: { readonly entityId: string };
}

export interface ComponentSetRequest extends MutationRequestEnvelope {
  readonly type: "component.set";
  readonly body: {
    readonly entityId: string;
    readonly component: P1MutableComponent | "hvtp.renderable@1" | "hvtp.presence@1";
    readonly authorityEpoch: number;
    readonly baseRevision: number;
    readonly state: unknown;
  };
}

export interface ComponentPatchRequest extends MutationRequestEnvelope {
  readonly type: "component.patch";
  readonly body: {
    readonly entityId: string;
    readonly component: P1MutableComponent | "hvtp.renderable@1" | "hvtp.presence@1";
    readonly authorityEpoch: number;
    readonly baseRevision: number;
    readonly patch: unknown;
  };
}

export type P1MutationRequest = EntityCreateRequest | EntityDeleteRequest | ComponentSetRequest | ComponentPatchRequest;

export interface MutationAckMessage {
  readonly hvtp: typeof HVTP_VERSION;
  readonly id: string;
  readonly type: "ack";
  readonly realm: typeof P1_REALM_ID;
  readonly realmEpoch: string;
  readonly body: {
    readonly ref: string;
    readonly status: "committed";
    readonly seq: number;
    readonly entityId: string;
    readonly component?: P1MutableComponent;
    readonly revision?: number;
    readonly authorityEpoch?: 1;
  };
}

export type CanonicalPublicationMessage =
  | {
      readonly hvtp: typeof HVTP_VERSION;
      readonly id: string;
      readonly type: "entity.created";
      readonly realm: typeof P1_REALM_ID;
      readonly realmEpoch: string;
      readonly seq: number;
      readonly body: { readonly subscriptionId: string; readonly entity: P1SharedEntity };
    }
  | {
      readonly hvtp: typeof HVTP_VERSION;
      readonly id: string;
      readonly type: "component.updated";
      readonly realm: typeof P1_REALM_ID;
      readonly realmEpoch: string;
      readonly seq: number;
      readonly body: {
        readonly subscriptionId: string;
        readonly entityId: string;
        readonly component: P1MutableComponent;
        readonly value: P1SharedEntity["components"][P1MutableComponent];
      };
    }
  | {
      readonly hvtp: typeof HVTP_VERSION;
      readonly id: string;
      readonly type: "entity.deleted";
      readonly realm: typeof P1_REALM_ID;
      readonly realmEpoch: string;
      readonly seq: number;
      readonly body: { readonly subscriptionId: string; readonly entityId: string };
    }
  | {
      readonly hvtp: typeof HVTP_VERSION;
      readonly id: string;
      readonly type: "view.entity.enter";
      readonly realm: typeof P1_REALM_ID;
      readonly realmEpoch: string;
      readonly seq: number;
      readonly body: { readonly subscriptionId: string; readonly reason: "interest"; readonly entity: P1SharedEntity };
    }
  | {
      readonly hvtp: typeof HVTP_VERSION;
      readonly id: string;
      readonly type: "view.entity.leave";
      readonly realm: typeof P1_REALM_ID;
      readonly realmEpoch: string;
      readonly seq: number;
      readonly body: { readonly subscriptionId: string; readonly reason: "interest"; readonly entityId: string };
    };

export interface SessionWelcomeMessage {
  readonly hvtp: typeof HVTP_VERSION;
  readonly id: string;
  readonly type: "session.welcome";
  readonly body: {
    readonly version: typeof HVTP_VERSION;
    readonly participantId: string;
    readonly server: {
      readonly name: "hvtp-reference-host";
      readonly version: "0.1.0";
    };
    readonly assetBaseUri: string;
    readonly limits: typeof P1_LIMITS;
  };
}

export interface ErrorMessage {
  readonly hvtp: typeof HVTP_VERSION;
  readonly id: string;
  readonly type: "error";
  readonly realm?: typeof P1_REALM_ID;
  readonly realmEpoch?: string;
  readonly body: {
    readonly ref: string | null;
    readonly code: P1ErrorCode;
    readonly message: string;
    readonly entityId?: string;
    readonly component?: string;
    readonly currentRevision?: number;
    readonly authorityEpoch?: number;
  };
}

export interface P1ComponentEnvelope<State> {
  readonly revision: number;
  readonly authority: "host";
  readonly authorityEpoch: 1;
  readonly consistency: "authoritative";
  readonly state: State;
}

export interface P1TransformState {
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
  readonly scale: readonly [number, number, number];
}

export interface P1RenderableState {
  readonly asset: {
    readonly uri: "unit-cube.gltf";
    readonly mediaType: "model/gltf+json";
  };
  readonly node: "UnitCube";
  readonly visible: boolean;
}

export interface P1MaterialState {
  readonly baseColor: readonly [number, number, number, number];
}

export interface P1SharedEntityInput {
  readonly id: string;
  readonly transform: P1TransformState;
  readonly renderable: P1RenderableState;
  readonly material: P1MaterialState;
}

export interface P1SharedEntity {
  readonly id: string;
  readonly components: {
    readonly "hvtp.transform@1": P1ComponentEnvelope<P1TransformState>;
    readonly "hvtp.renderable@1": P1ComponentEnvelope<P1RenderableState>;
    readonly "hvtp.material@1": P1ComponentEnvelope<P1MaterialState>;
  };
}

export interface P1PresenceEntity {
  readonly id: string;
  readonly components: {
    readonly "hvtp.transform@1": P1ComponentEnvelope<{
      readonly position: readonly [0, 0, 0];
      readonly rotation: readonly [0, 0, 0, 1];
      readonly scale: readonly [1, 1, 1];
    }>;
    readonly "hvtp.presence@1": P1ComponentEnvelope<{
      readonly participantId: string;
      readonly kind: ParticipantKind;
    }>;
  };
}

interface RealmSnapshotEnvelope {
  readonly hvtp: typeof HVTP_VERSION;
  readonly id: string;
  readonly realm: typeof P1_REALM_ID;
  readonly realmEpoch: string;
}

export interface RealmJoinedMessage extends RealmSnapshotEnvelope {
  readonly type: "realm.joined";
  readonly body: {
    readonly participantId: string;
    readonly presenceEntityId: string;
    readonly subscriptionId: string;
    readonly effectiveSubscription: SubscriptionSelector;
    readonly snapshotId: string;
    readonly snapshotBaseSeq: number;
    readonly requiredComponents: typeof P1_REQUIRED_COMPONENTS;
  };
}

export interface RealmSnapshotBeginMessage extends RealmSnapshotEnvelope {
  readonly type: "realm.snapshot.begin";
  readonly body: {
    readonly snapshotId: string;
    readonly subscriptionId: string;
    readonly snapshotBaseSeq: number;
  };
}

export interface EntitySnapshotMessage extends RealmSnapshotEnvelope {
  readonly type: "entity.snapshot";
  readonly body: {
    readonly snapshotId: string;
    readonly snapshotBaseSeq: number;
    readonly entity: P1PresenceEntity | P1SharedEntity;
  };
}

export interface RealmSnapshotEndMessage extends RealmSnapshotEnvelope {
  readonly type: "realm.snapshot.end";
  readonly body: {
    readonly snapshotId: string;
    readonly subscriptionId: string;
    readonly snapshotBaseSeq: number;
    readonly entityCount: number;
  };
}

export type SessionServerMessage =
  | SessionWelcomeMessage
  | ErrorMessage
  | RealmJoinedMessage
  | RealmSnapshotBeginMessage
  | EntitySnapshotMessage
  | RealmSnapshotEndMessage
  | MutationAckMessage
  | CanonicalPublicationMessage;

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: P1ProtocolError };

export { parseJsonRequest, parseMutationRequest, parseRealmJoin, parseSessionHello } from "./validation.js";
