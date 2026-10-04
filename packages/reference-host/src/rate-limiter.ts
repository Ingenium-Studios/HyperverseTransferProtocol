/** Monotonic millisecond clock. Injected in tests so rate behavior never depends on real sleeps. */
export type MonotonicClock = () => number;

export const defaultClock: MonotonicClock = () => performance.now();

/**
 * Sliding-window admission limiter.
 *
 * A request at time `t` is admitted only if fewer than `limit` requests were
 * admitted in the half-open window `(t - windowMs, t]`; an admission at exactly
 * `t - windowMs` has expired. Refused requests are not recorded, so a flood
 * cannot extend its own lockout. Memory is bounded by `limit` timestamps.
 */
export class SlidingWindowRateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #admitted: number[] = [];

  constructor(limit: number, windowMs = 1000) {
    this.#limit = limit;
    this.#windowMs = windowMs;
  }

  tryAcquire(now: number): boolean {
    let expired = 0;
    while (expired < this.#admitted.length && now - this.#admitted[expired]! >= this.#windowMs) expired += 1;
    if (expired > 0) this.#admitted.splice(0, expired);
    if (this.#admitted.length >= this.#limit) return false;
    this.#admitted.push(now);
    return true;
  }

  clear(): void {
    this.#admitted.length = 0;
  }
}
