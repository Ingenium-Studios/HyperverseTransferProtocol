import type { ErrorMessage } from "@hvtp/protocol-types";

/** Base class for every error surfaced by the engine-neutral P1 client. */
export class P1ClientError extends Error {
  override name = "P1ClientError";
}

/** A request was refused locally because the client is not in a state that may send it. Nothing was sent. */
export class P1ClientStateError extends P1ClientError {
  override name = "P1ClientStateError";
}

/** The host terminated a request with an `error` message. The outcome is known: nothing was committed. */
export class P1RequestError extends P1ClientError {
  override name = "P1RequestError";
  readonly code: ErrorMessage["body"]["code"];
  readonly ref: string | null;
  readonly body: ErrorMessage["body"];

  constructor(body: ErrorMessage["body"]) {
    super(`${body.code}: ${body.message}`);
    this.code = body.code;
    this.ref = body.ref;
    this.body = body;
  }
}

/**
 * A state-changing request was sent but the connection ended before its terminal `ack`/`error`/
 * `subscription.applied` arrived (Prototype Profile §11.1, C12). The host may or may not have committed it.
 * The client never replays the request ID in a later session; the caller resolves intent from the next
 * fresh snapshot and, if still needed, issues a new request with a new ID and current base revision.
 */
export class P1OutcomeUncertainError extends P1ClientError {
  override name = "P1OutcomeUncertainError";
  readonly requestId: string;
  readonly requestType: string;

  constructor(requestId: string, requestType: string) {
    super(`Outcome of ${requestType} ${requestId} is uncertain: the connection closed before a terminal result arrived.`);
    this.requestId = requestId;
    this.requestType = requestType;
  }
}

/** The host sent something the P1 client contract does not allow; the client discards session state and closes. */
export class P1ProtocolViolationError extends P1ClientError {
  override name = "P1ProtocolViolationError";
}

/** The connection could not reach LIVE (closed, rejected negotiation/join, or protocol violation during setup). */
export class P1ConnectionError extends P1ClientError {
  override name = "P1ConnectionError";
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    if (cause !== undefined) this.cause = cause;
  }
}
