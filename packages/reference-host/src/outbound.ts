import { P1_LIMITS, type SessionServerMessage } from "@hvtp/protocol-types";

/** Minimal transport seam; tests delay or fail `done` deterministically. */
export interface OutboundTransport {
  isOpen(): boolean;
  /** `done` fires when the transport has accepted/flushed the payload, or failed. */
  send(data: string, done: (error?: Error | null) => void): void;
}

interface InFlight {
  readonly bytes: number;
  released: boolean;
}

/**
 * The single per-connection outbound byte budget (`maxQueuedOutboundBytes`).
 *
 * Every payload byte is reserved exactly once, when it is admitted either by the
 * realm coordinator (snapshots, transitions, publications) or by `trySend`
 * (direct control responses). Ownership of a coordinator reservation transfers
 * to the transport in `sendReserved` without re-reserving. A reservation is
 * released when the transport `done` callback fires, when a synchronous send
 * fails, or when the channel is disposed; each in-flight send releases once.
 */
export class P1OutboundChannel {
  readonly #transport: OutboundTransport;
  readonly #onFailure: (error: Error) => void;
  readonly #limit: number;
  readonly #inFlight = new Set<InFlight>();
  #used = 0;
  #disposed = false;

  constructor(
    transport: OutboundTransport,
    onFailure: (error: Error) => void = () => {},
    limit: number = P1_LIMITS.maxQueuedOutboundBytes,
  ) {
    this.#transport = transport;
    this.#onFailure = onFailure;
    this.#limit = limit;
  }

  get queuedBytes(): number {
    return this.#used;
  }

  get inFlightCount(): number {
    return this.#inFlight.size;
  }

  reserve(bytes: number): boolean {
    if (this.#disposed || bytes > this.#limit - this.#used) return false;
    this.#used += bytes;
    return true;
  }

  release(bytes: number): void {
    if (this.#disposed) return;
    if (bytes > this.#used) throw new Error("Outbound byte budget underflow.");
    this.#used -= bytes;
  }

  /** Reserve and send a direct message. Returns false, sending nothing, when it does not fit. */
  trySend(message: SessionServerMessage): boolean {
    const payload = JSON.stringify(message);
    const bytes = Buffer.byteLength(payload, "utf8");
    if (!this.reserve(bytes)) return false;
    this.sendReserved(payload, bytes);
    return true;
  }

  /** Send a payload whose bytes the caller already reserved. Always takes ownership of the reservation. */
  sendReserved(payload: string, bytes: number): void {
    if (this.#disposed) throw new Error("Outbound channel is closed.");
    if (!this.#transport.isOpen()) {
      this.release(bytes);
      throw new Error("Transport is closed.");
    }
    const entry: InFlight = { bytes, released: false };
    this.#inFlight.add(entry);
    const done = (error?: Error | null): void => {
      if (entry.released) return;
      this.#releaseEntry(entry);
      if (error != null) this.#onFailure(error);
    };
    try {
      this.#transport.send(payload, done);
    } catch (error) {
      this.#releaseEntry(entry);
      throw error;
    }
  }

  /** Connection closed: drop all accounting. Late transport callbacks become no-ops. */
  dispose(): void {
    this.#disposed = true;
    for (const entry of this.#inFlight) entry.released = true;
    this.#inFlight.clear();
    this.#used = 0;
  }

  #releaseEntry(entry: InFlight): void {
    if (entry.released) return;
    entry.released = true;
    this.#inFlight.delete(entry);
    this.release(entry.bytes);
  }
}
