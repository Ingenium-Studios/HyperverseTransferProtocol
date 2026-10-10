import type { P1RenderableState } from "@hvtp/protocol-types";
import { fetchP1Fixture, inspectP1Fixture, type P1FetchLike } from "@hvtp/client-core";

export type AssetCheckResult =
  | { readonly ok: true; readonly url: string; readonly bytes: number }
  | { readonly ok: false; readonly url: string | null; readonly reason: string };

/**
 * Local-only fixture check using the shared client-core policy (C34): the same URL resolution, no-redirect
 * fetch, size bounds and JSON inspection as the browser client. It never touches shared state and never throws.
 */
export async function checkAsset(renderable: P1RenderableState, assetBaseUri: string, maxAssetBytes: number,
  fetch?: P1FetchLike, timeoutMs?: number): Promise<AssetCheckResult> {
  try {
    const fetched = await fetchP1Fixture(renderable, {
      assetBaseUri, maxAssetBytes, ...(fetch === undefined ? {} : { fetch }), ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    if (!fetched.ok) return fetched;
    const inspected = inspectP1Fixture(fetched.bytes, renderable.node);
    if (!inspected.ok) return { ok: false, url: fetched.url, reason: inspected.reason };
    return { ok: true, url: fetched.url, bytes: fetched.bytes.byteLength };
  } catch (error) {
    return { ok: false, url: null, reason: error instanceof Error ? error.message : String(error) };
  }
}
