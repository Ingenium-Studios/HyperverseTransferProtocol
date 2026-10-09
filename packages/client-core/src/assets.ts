import type { P1RenderableState } from "@hvtp/protocol-types";
import { P1_FIXTURE_RENDERABLE } from "./wire.js";

/**
 * Engine-neutral P1 fixture asset policy (Prototype Profile §12.1/§15, C34). It is identical for browser and
 * headless consumers: URL resolution against the advertised `assetBaseUri`, a bounded fetch with no redirects,
 * and JSON-level fixture inspection. Parsing the glTF into renderer objects is the renderer's job.
 */
export type P1FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type P1AssetFetchResult =
  | { readonly ok: true; readonly url: string; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly url: string | null; readonly reason: string };

export interface P1AssetFetchOptions {
  /** `session.welcome.assetBaseUri` of the current session. */
  readonly assetBaseUri: string;
  /** `session.welcome.limits.maxAssetBytes` of the current session. */
  readonly maxAssetBytes: number;
  readonly fetch?: P1FetchLike;
}

export type P1FixtureInspection =
  | { readonly ok: true; readonly text: string; readonly nodeIndex: number }
  | { readonly ok: false; readonly reason: string };

class AssetFailure extends Error {}

/** Normal URL resolution against the advertised base; independent of the document origin. */
export function resolveP1AssetUrl(assetBaseUri: string, uri: string): string {
  return new URL(uri, assetBaseUri).href;
}

/** True when the renderable is exactly the P1 unit-cube fixture reference. */
export function isP1FixtureRenderable(renderable: P1RenderableState): boolean {
  return renderable.asset.uri === P1_FIXTURE_RENDERABLE.uri && renderable.asset.mediaType === P1_FIXTURE_RENDERABLE.mediaType &&
    renderable.node === P1_FIXTURE_RENDERABLE.node && typeof renderable.visible === "boolean";
}

/**
 * Fetches the fixture bytes under the P1 policy: no redirects, HTTP 200 only, media type `model/gltf+json`,
 * credentials omitted, and `maxAssetBytes` enforced on both the declared and the streamed size. Never throws.
 */
export async function fetchP1Fixture(renderable: P1RenderableState, options: P1AssetFetchOptions): Promise<P1AssetFetchResult> {
  if (!isP1FixtureRenderable(renderable)) {
    return { ok: false, url: null, reason: "renderable is not the P1 unit-cube fixture reference" };
  }
  const url = resolveP1AssetUrl(options.assetBaseUri, renderable.asset.uri);
  try {
    return { ok: true, url, bytes: await fetchBounded(url, options) };
  } catch (error) {
    return { ok: false, url, reason: error instanceof Error ? error.message : String(error) };
  }
}

async function fetchBounded(url: string, options: P1AssetFetchOptions): Promise<Uint8Array> {
  const limit = options.maxAssetBytes;
  const fetchFn: P1FetchLike = options.fetch ?? ((target, init) => globalThis.fetch(target, init));
  let response: Response;
  try {
    response = await fetchFn(url, { redirect: "manual", credentials: "omit", mode: "cors" });
  } catch (error) {
    throw new AssetFailure(`fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    if (response.type === "opaqueredirect" || response.redirected || (response.status >= 300 && response.status < 400)) {
      throw new AssetFailure(`redirect refused (status ${response.status})`);
    }
    if (response.status !== 200) throw new AssetFailure(`unexpected status ${response.status}`);
    const mediaType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (mediaType !== P1_FIXTURE_RENDERABLE.mediaType) throw new AssetFailure(`unexpected media type '${mediaType}'`);
    const declared = response.headers.get("content-length");
    if (declared !== null && Number(declared) > limit) throw new AssetFailure(`declared size ${declared} exceeds maxAssetBytes ${limit}`);
    return await readBounded(response, limit);
  } catch (error) {
    void response.body?.cancel().catch(() => {});
    throw error;
  }
}

/** Consumes the body chunk by chunk and stops as soon as the running total would exceed the limit. */
async function readBounded(response: Response, limit: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new AssetFailure(`body exceeds maxAssetBytes ${limit}`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * JSON-level fixture checks that need no glTF engine: UTF-8 glTF JSON object, only embedded `data:` resources
 * (so parsing can never trigger further network fetches), and a node named `nodeName`. Never throws.
 */
export function inspectP1Fixture(bytes: Uint8Array, nodeName: string): P1FixtureInspection {
  let text: string;
  let json: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: "fixture is not UTF-8 glTF JSON" };
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return { ok: false, reason: "fixture is not a glTF JSON object" };
  try {
    const doc = json as { nodes?: unknown; buffers?: unknown; images?: unknown };
    // Shapes that are not arrays are left for the glTF parser to reject; only array entries are inspected here.
    const resources = [doc.buffers, doc.images].flatMap((list) => (Array.isArray(list) ? list : []));
    for (const resource of resources as Array<{ uri?: unknown } | null>) {
      const uri = typeof resource === "object" && resource !== null ? resource.uri : undefined;
      if (uri !== undefined && !(typeof uri === "string" && uri.startsWith("data:"))) {
        return { ok: false, reason: "fixture references an external resource; only embedded data: URIs are allowed" };
      }
    }
    const nodes = Array.isArray(doc.nodes) ? (doc.nodes as unknown[]) : [];
    const nodeIndex = nodes.findIndex((node) => typeof node === "object" && node !== null && (node as { name?: unknown }).name === nodeName);
    if (nodeIndex < 0) return { ok: false, reason: `fixture has no node named '${nodeName}'` };
    return { ok: true, text, nodeIndex };
  } catch (error) {
    return { ok: false, reason: `fixture could not be inspected: ${error instanceof Error ? error.message : String(error)}` };
  }
}
