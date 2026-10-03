export const HVTP_VERSION = "0.2" as const;
export const P1_REALM_ID = "urn:hvtp:realm:prototype-world" as const;
export const MAX_SAFE_PROTOCOL_INTEGER = Number.MAX_SAFE_INTEGER;

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
  readonly body: {
    readonly ref: string | null;
    readonly code: P1ErrorCode;
    readonly message: string;
  };
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: P1ProtocolError };

export { parseJsonRequest, parseSessionHello } from "./validation.js";
