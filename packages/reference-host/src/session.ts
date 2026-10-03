import { randomUUID } from "node:crypto";
import {
  HVTP_VERSION,
  P1_LIMITS,
  P1_REALM_ID,
  P1_REQUIRED_COMPONENTS,
  parseJsonRequest,
  parseRealmJoin,
  parseSessionHello,
  type EntitySnapshotMessage,
  type ErrorMessage,
  type P1ErrorCode,
  type P1PresenceEntity,
  type ParticipantKind,
  type RealmJoinedMessage,
  type RealmSnapshotBeginMessage,
  type RealmSnapshotEndMessage,
  type SessionServerMessage,
  type SessionWelcomeMessage,
  type SubscriptionSelector,
} from "@hvtp/protocol-types";

export type SessionState = "CONNECTED" | "NEGOTIATED" | "JOINING" | "JOINED" | "CLOSED";

export interface SessionDispatch {
  readonly messages: readonly SessionServerMessage[];
  readonly afterEnqueue?: () => void;
}

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
  #participantId: string | null = null;
  #participantKind: ParticipantKind | null = null;
  #activeSubscriptionId: string | null = null;
  #pendingSnapshotId: string | null = null;

  constructor(assetBaseUri: string, realmEpoch = `epoch:${randomUUID()}`) {
    const uri = new URL(assetBaseUri);
    if (!uri.pathname.endsWith("/")) throw new Error("assetBaseUri must end in /");
    this.#assetBaseUri = uri.toString();
    this.#realmEpoch = realmEpoch;
  }

  get state(): SessionState {
    return this.#state;
  }

  close(): void {
    this.#state = "CLOSED";
    this.#pendingSnapshotId = null;
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

    return this.#dispatch(this.#error("unsupported_message", ref, `Message ${type} is not implemented by this reference-host slice yet.`));
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

    const subscriptionId = `subscription:${randomUUID()}`;
    const snapshotId = `snapshot:${randomUUID()}`;
    const presenceEntityId = `entity:presence-${randomUUID()}`;
    const snapshotBaseSeq = 0;
    const effectiveSubscription = cloneSubscription(join.value.body.subscription);
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

    const entity: EntitySnapshotMessage = {
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
      body: { snapshotId, subscriptionId, snapshotBaseSeq, entityCount: 1 },
    };

    this.#activeSubscriptionId = subscriptionId;
    this.#pendingSnapshotId = snapshotId;
    this.#state = "JOINING";

    return {
      messages: [joined, begin, entity, end],
      afterEnqueue: () => {
        if (this.#state === "JOINING" && this.#pendingSnapshotId === snapshotId) {
          this.#pendingSnapshotId = null;
          this.#state = "JOINED";
        }
      },
    };
  }

  #dispatch(message: SessionServerMessage): SessionDispatch {
    return { messages: [message] };
  }

  #error(code: P1ErrorCode, ref: string | null, message: string): ErrorMessage {
    return {
      hvtp: HVTP_VERSION,
      id: `res:${randomUUID()}`,
      type: "error",
      body: { ref, code, message },
    };
  }
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
