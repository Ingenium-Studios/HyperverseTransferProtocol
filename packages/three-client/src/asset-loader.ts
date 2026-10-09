import type { Object3D, Texture } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { P1RenderableState } from "@hvtp/protocol-types";
import { P1_FIXTURE_RENDERABLE } from "@hvtp/client-core";

export type P1FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type P1AssetLoadResult =
  | { readonly ok: true; readonly url: string; readonly template: Object3D }
  | { readonly ok: false; readonly url: string | null; readonly reason: string };

export interface P1FixtureLoaderOptions {
  /** `session.welcome.assetBaseUri` of the current session. */
  readonly assetBaseUri: string;
  /** `session.welcome.limits.maxAssetBytes` of the current session. */
  readonly maxAssetBytes: number;
  readonly fetch?: P1FetchLike;
}

class AssetLoadFailure extends Error {}

const DISPOSED_REASON = "fixture loader disposed";

/**
 * Renderer-local P1 fixture loader (Prototype Profile §12.1/§15, C34).
 *
 * The client fetches and size-checks the bytes itself (no redirects, HTTP 200 only, `maxAssetBytes` enforced
 * on both the declared and the streamed size), then hands them to `GLTFLoader.parse`. `GLTFLoader.load(url)`
 * is never used, so it cannot bypass that policy, and glTF resources must be embedded `data:` URIs so parsing
 * cannot trigger further network fetches. Results, including failures, are cached for the session: P1 has one
 * fixture, so the cache holds at most one entry and a failure causes no repeated network attempts.
 */
export class P1FixtureLoader {
  readonly #options: P1FixtureLoaderOptions;
  readonly #fetch: P1FetchLike;
  readonly #cache = new Map<string, Promise<P1AssetLoadResult>>();
  /** Templates that finished loading before dispose; the only ones `dispose()` has to release itself. */
  readonly #templates = new Set<Object3D>();
  #disposed = false;

  constructor(options: P1FixtureLoaderOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  }

  /** Normal URL resolution against the advertised base; independent of the document origin. */
  resolve(uri: string): string {
    return new URL(uri, this.#options.assetBaseUri).href;
  }

  load(renderable: P1RenderableState): Promise<P1AssetLoadResult> {
    if (renderable.asset.uri !== P1_FIXTURE_RENDERABLE.uri || renderable.asset.mediaType !== P1_FIXTURE_RENDERABLE.mediaType ||
        renderable.node !== P1_FIXTURE_RENDERABLE.node || typeof renderable.visible !== "boolean") {
      return Promise.resolve({ ok: false, url: null, reason: "renderable is not the P1 unit-cube fixture reference" });
    }
    const url = this.resolve(renderable.asset.uri);
    if (this.#disposed) return Promise.resolve({ ok: false, url, reason: DISPOSED_REASON });
    const key = `${url}#${renderable.node}`;
    let result = this.#cache.get(key);
    if (result === undefined) {
      result = this.#loadUncached(url, renderable.node).then((loaded) => {
        if (!loaded.ok) return loaded;
        if (this.#disposed) {
          // Disposed while loading: this is the only place the late template is released, and it is never handed out.
          disposeObject(loaded.template);
          return { ok: false, url, reason: DISPOSED_REASON } satisfies P1AssetLoadResult;
        }
        this.#templates.add(loaded.template);
        return loaded;
      });
      this.#cache.set(key, result);
    }
    return result;
  }

  /**
   * Releases cached template geometry/materials/textures exactly once. Templates still loading are released when
   * their load completes. Call only once no instance from this loader is displayed. Idempotent.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const template of this.#templates) disposeObject(template);
    this.#templates.clear();
    this.#cache.clear();
  }

  async #loadUncached(url: string, nodeName: string): Promise<P1AssetLoadResult> {
    try {
      const bytes = await this.#fetchBounded(url);
      const template = await parseFixture(bytes, nodeName);
      return { ok: true, url, template };
    } catch (error) {
      return { ok: false, url, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async #fetchBounded(url: string): Promise<Uint8Array> {
    const limit = this.#options.maxAssetBytes;
    let response: Response;
    try {
      response = await this.#fetch(url, { redirect: "manual", credentials: "omit", mode: "cors" });
    } catch (error) {
      throw new AssetLoadFailure(`fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      if (response.type === "opaqueredirect" || response.redirected || (response.status >= 300 && response.status < 400)) {
        throw new AssetLoadFailure(`redirect refused (status ${response.status})`);
      }
      if (response.status !== 200) throw new AssetLoadFailure(`unexpected status ${response.status}`);
      const mediaType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (mediaType !== P1_FIXTURE_RENDERABLE.mediaType) throw new AssetLoadFailure(`unexpected media type '${mediaType}'`);
      const declared = response.headers.get("content-length");
      if (declared !== null && Number(declared) > limit) throw new AssetLoadFailure(`declared size ${declared} exceeds maxAssetBytes ${limit}`);
      return await readBounded(response, limit);
    } catch (error) {
      void response.body?.cancel().catch(() => {});
      throw error;
    }
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
      throw new AssetLoadFailure(`body exceeds maxAssetBytes ${limit}`);
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

async function parseFixture(bytes: Uint8Array, nodeName: string): Promise<Object3D> {
  let text: string;
  let json: { nodes?: Array<{ name?: unknown }>; buffers?: Array<{ uri?: unknown }>; images?: Array<{ uri?: unknown }> };
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    json = JSON.parse(text) as typeof json;
  } catch {
    throw new AssetLoadFailure("fixture is not UTF-8 glTF JSON");
  }
  if (typeof json !== "object" || json === null) throw new AssetLoadFailure("fixture is not a glTF JSON object");
  for (const resource of [...(json.buffers ?? []), ...(json.images ?? [])]) {
    if (resource?.uri !== undefined && !(typeof resource.uri === "string" && resource.uri.startsWith("data:"))) {
      throw new AssetLoadFailure("fixture references an external resource; only embedded data: URIs are allowed");
    }
  }
  const nodeIndex = Array.isArray(json.nodes) ? json.nodes.findIndex((node) => node?.name === nodeName) : -1;
  if (nodeIndex < 0) throw new AssetLoadFailure(`fixture has no node named '${nodeName}'`);

  try {
    const gltf = await new GLTFLoader().parseAsync(text, "");
    // The selected node with its own subtree; its glTF hierarchy is preserved, never flattened.
    return (await gltf.parser.getDependency("node", nodeIndex)) as Object3D;
  } catch (error) {
    throw new AssetLoadFailure(`invalid glTF: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Disposes geometry, materials, and the textures those materials reference; each shared resource once. */
export function disposeObject(object: Object3D): void {
  const geometries = new Set<{ dispose(): void }>();
  const materials = new Set<{ dispose(): void }>();
  object.traverse((child) => {
    const mesh = child as Partial<{ geometry: { dispose(): void }; material: { dispose(): void } | Array<{ dispose(): void }> }>;
    if (mesh.geometry !== undefined) geometries.add(mesh.geometry);
    if (Array.isArray(mesh.material)) for (const material of mesh.material) materials.add(material);
    else if (mesh.material !== undefined) materials.add(mesh.material);
  });
  const textures = new Set<Texture>();
  for (const material of materials) {
    for (const value of Object.values(material) as unknown[]) {
      if ((value as Partial<Texture> | null)?.isTexture === true) textures.add(value as Texture);
    }
  }
  for (const resource of [...geometries, ...materials, ...textures]) resource.dispose();
}
