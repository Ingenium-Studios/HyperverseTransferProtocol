import type { P1Client } from "@hvtp/client-core";

export type WaitResult = "ok" | "disconnected" | "timeout";

/**
 * Resolves `ok` once `predicate` holds while the session is LIVE, re-checking after every client event.
 * Resolves `disconnected` as soon as the client leaves LIVE and `timeout` after `timeoutMs`. The listener
 * never throws (client-core would rethrow a listener exception asynchronously).
 */
export function until(client: P1Client, predicate: () => boolean, timeoutMs: number): Promise<WaitResult> {
  const check = (): WaitResult | null => {
    if (client.phase !== "live") return "disconnected";
    try { return predicate() ? "ok" : null; } catch { return null; }
  };
  const immediate = check();
  if (immediate !== null) return Promise.resolve(immediate);
  return new Promise<WaitResult>((resolve) => {
    let off = () => {};
    const timer = setTimeout(() => { off(); resolve("timeout"); }, timeoutMs);
    off = client.on(() => {
      const result = check();
      if (result === null) return;
      clearTimeout(timer);
      off();
      resolve(result);
    });
  });
}
