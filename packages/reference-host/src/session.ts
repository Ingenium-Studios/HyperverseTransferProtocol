import { randomUUID } from "node:crypto";
import {
  HVTP_VERSION,
  P1_LIMITS,
  parseJsonRequest,
  parseSessionHello,
  type ErrorMessage,
  type P1ErrorCode,
  type SessionWelcomeMessage,
} from "@hvtp/protocol-types";

export type SessionState = "CONNECTED" | "NEGOTIATED" | "CLOSED";
export type SessionOutbound = SessionWelcomeMessage | ErrorMessage;

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

  constructor(assetBaseUri: string) {
    const uri = new URL(assetBaseUri);
    if (!uri.pathname.endsWith("/")) throw new Error("assetBaseUri must end in /");
    this.#assetBaseUri = uri.toString();
  }

  get state(): SessionState {
    return this.#state;
  }

  close(): void {
    this.#state = "CLOSED";
  }

  handleText(text: string): SessionOutbound {
    const generic = parseJsonRequest(text);
    if (!generic.ok) return this.#error(generic.error.code, generic.error.ref, generic.error.message);

    const request = generic.value;
    const ref = request.id as string;
    const type = typeof request.type === "string" ? request.type : null;

    if (this.#state === "CLOSED") return this.#error("invalid_state", ref, "Session is closed.");

    if (type === null) return this.#error("invalid_message", ref, "Request type must be a string.");
    if (!KNOWN_CLIENT_MESSAGE_TYPES.has(type)) {
      return this.#error("unsupported_message", ref, `Unsupported P1 message type: ${type}`);
    }

    if (this.#state !== "CONNECTED") {
      return this.#error("invalid_state", ref, `Message ${type} is not valid in ${this.#state}.`);
    }

    if (type !== "session.hello") {
      return this.#error("invalid_state", ref, `Message ${type} is not valid before session.welcome.`);
    }

    const hello = parseSessionHello(text);
    if (!hello.ok) return this.#error(hello.error.code, hello.error.ref, hello.error.message);

    const participantId = `participant:${randomUUID()}`;
    this.#state = "NEGOTIATED";
    return {
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
