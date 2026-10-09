import type { Object3D, Texture } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { P1RenderableState } from "@hvtp/protocol-types";
import { fetchP1Fixture, inspectP1Fixture, isP1FixtureRenderable, resolveP1AssetUrl, type P1FetchLike } from "@hvtp/client-core";

export type { P1FetchLike };

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

const DISPOSED_REASON = "fixture loader disposed";

/**
 * Renderer-local P1 fixture loader (Prototype Profile §12.1/§15, C34).
 *
 * The engine-neutral fetch and JSON validation policy lives in `@hvtp/client-core` (`assets.ts`, shared with
 * headless consumers): no redirects, HTTP 200 only, `maxAssetBytes` enforced on both the declared and the
 * streamed size, embedded `data:` resources only. This class hands the validated bytes to `GLTFLoader.parse`
 * and owns the template lifecycle. `GLTFLoader.load(url)` is never used, so it cannot bypass that policy. Results, including failures, are cached for the session: P1 has one
 * fixture, so the cache holds at most one entry and a failure causes no repeated network attempts.
 */
export class P1FixtureLoader {
  readonly #options: P1FixtureLoaderOptions;
  readonly #cache = new Map<string, Promise<P1AssetLoadResult>>();
  /** Templates that finished loading before dispose; the only ones `dispose()` has to release itself. */
  readonly #templates = new Set<Object3D>();
  #disposed = false;

  constructor(options: P1FixtureLoaderOptions) {
    this.#options = options;
  }

  /** Normal URL resolution against the advertised base; independent of the document origin. */
  resolve(uri: string): string {
    return resolveP1AssetUrl(this.#options.assetBaseUri, uri);
  }

  load(renderable: P1RenderableState): Promise<P1AssetLoadResult> {
    if (!isP1FixtureRenderable(renderable)) {
      return Promise.resolve({ ok: false, url: null, reason: "renderable is not the P1 unit-cube fixture reference" });
    }
    const url = this.resolve(renderable.asset.uri);
    if (this.#disposed) return Promise.resolve({ ok: false, url, reason: DISPOSED_REASON });
    const key = `${url}#${renderable.node}`;
    let result = this.#cache.get(key);
    if (result === undefined) {
      result = this.#loadUncached(renderable).then((loaded) => {
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

  async #loadUncached(renderable: P1RenderableState): Promise<P1AssetLoadResult> {
    const fetched = await fetchP1Fixture(renderable, {
      assetBaseUri: this.#options.assetBaseUri, maxAssetBytes: this.#options.maxAssetBytes,
      ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
    });
    if (!fetched.ok) return fetched;
    const inspected = inspectP1Fixture(fetched.bytes, renderable.node);
    if (!inspected.ok) return { ok: false, url: fetched.url, reason: inspected.reason };
    try {
      const gltf = await new GLTFLoader().parseAsync(inspected.text, "");
      // The selected node with its own subtree; its glTF hierarchy is preserved, never flattened.
      const template = (await gltf.parser.getDependency("node", inspected.nodeIndex)) as Object3D;
      return { ok: true, url: fetched.url, template };
    } catch (error) {
      return { ok: false, url: fetched.url, reason: `invalid glTF: ${error instanceof Error ? error.message : String(error)}` };
    }
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
