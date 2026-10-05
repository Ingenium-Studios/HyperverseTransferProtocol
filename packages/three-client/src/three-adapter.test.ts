import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BufferGeometry, Color, LinearSRGBColorSpace, Mesh, MeshStandardMaterial, Object3D, Vector3 } from "three";
import { deepFreeze } from "@hvtp/client-core";
import {
  cube, created, deleted, enter, harness, leave, live, transformValue, updated, materialValue, type Harness,
} from "@hvtp/client-core/test-support";
import { applyBaseColor, applyTransform, P1FixtureLoader, P1ThreeView, PLACEHOLDER_NAME, type P1FetchLike } from "./index.js";

// GLTFLoader's FileLoader (used for the fixture's embedded data: buffer) emits the browser-only ProgressEvent.
// Node lacks that global; browsers provide it natively. Test-environment shim only.
(globalThis as { ProgressEvent?: unknown }).ProgressEvent ??= class ProgressEvent extends Event {
  constructor(type: string, init: Record<string, unknown> = {}) { super(type); Object.assign(this, init); }
};

const FIXTURE = readFileSync(new URL("../../../protocol-spec/fixtures/unit-cube.gltf", import.meta.url));
const ASSET_URL = "http://127.0.0.1:8787/assets/p1/unit-cube.gltf";
const C17_ROTATION = [0, 0, 0.7071067811865475, 0.7071067811865476] as const;

interface FetchCall { readonly url: string; readonly init: RequestInit }

function fixtureFetch(calls: FetchCall[] = [], body: BodyInit | null = FIXTURE, init: ResponseInit = {}): P1FetchLike {
  return async (url, requestInit) => {
    calls.push({ url, init: requestInit });
    return new Response(body, { status: 200, headers: { "content-type": "model/gltf+json", "content-length": String(FIXTURE.byteLength) }, ...init });
  };
}

/** A canonical session (real client-core state machine over a fake socket) projected into a Three view. */
async function scene(entities: unknown[], fetch: P1FetchLike = fixtureFetch()): Promise<{ h: Harness; view: P1ThreeView; failures: string[] }> {
  const failures: string[] = [];
  const h = harness();
  const view = new P1ThreeView({ fetch, onAssetFailure: (_id, reason) => failures.push(reason) });
  view.attach(h.client);
  await live(h, entities);
  await view.whenIdle();
  return { h, view, failures };
}

const meshesOf = (object: Object3D): Mesh[] => {
  const meshes: Mesh[] = [];
  object.traverse((child) => { if ((child as Mesh).isMesh) meshes.push(child as Mesh); });
  return meshes;
};
const materialOf = (view: P1ThreeView, id: string) => meshesOf(view.object(id)!)[0]!.material as MeshStandardMaterial;
const close = (actual: Vector3, expected: readonly number[], tolerance = 1e-6) =>
  assert.ok(actual.toArray().every((value, i) => Math.abs(value - expected[i]!) <= tolerance), `${actual.toArray()} != ${expected}`);

const c17Cube = (id: string) => {
  const entity = cube(id);
  return { ...entity, components: { ...entity.components, "hvtp.transform@1": {
    ...entity.components["hvtp.transform@1"], state: { position: [0, 0, 0], rotation: [...C17_ROTATION], scale: [2, 1, 1] },
  } } };
};

// ---------------------------------------------------------------------------------------------------------------
// Transform (C17)
// ---------------------------------------------------------------------------------------------------------------

test("C17: the renderer maps local [0.5,0.5,0.5] through the loaded UnitCube node to [-0.5,1,0.5]", async () => {
  const { view, h } = await scene([c17Cube("entity:c17")]);
  assert.equal(view.assetStatus("entity:c17"), "loaded");
  const root = view.object("entity:c17")!;
  const node = root.getObjectByName("UnitCube")!;
  assert.ok(node, "selected glTF node is a child of the HVTP entity root");
  view.root.updateMatrixWorld(true);
  const realmPoint = node.localToWorld(new Vector3(0.5, 0.5, 0.5));
  close(realmPoint, [-0.5, 1.0, 0.5]);
  console.log(`C17 realm point: [${realmPoint.toArray().join(", ")}]`);
  h.client.disconnect();
});

test("transform mapping is component-wise position/quaternion[x,y,z,w]/scale with T × R × S composition", () => {
  const root = new Object3D();
  applyTransform(root, { position: [1, 2, 3], rotation: [...C17_ROTATION], scale: [2, 1, 1] });
  assert.deepEqual(root.position.toArray(), [1, 2, 3]);
  assert.deepEqual(root.quaternion.toArray(), [...C17_ROTATION]);
  assert.deepEqual(root.scale.toArray(), [2, 1, 1]);
  root.updateMatrixWorld(true);
  // Translation is applied last: local [0.5,0.5,0.5] → R·S·p = [-0.5,1,0.5] → + [1,2,3].
  close(new Vector3(0.5, 0.5, 0.5).applyMatrix4(root.matrixWorld), [0.5, 3, 3.5]);
  // +Y up, +Z forward stay untouched for an identity rotation.
  applyTransform(root, { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
  root.updateMatrixWorld(true);
  close(new Vector3(0, 1, 2).applyMatrix4(root.matrixWorld), [0, 1, 2]);
});

// ---------------------------------------------------------------------------------------------------------------
// Material (C18) and visibility
// ---------------------------------------------------------------------------------------------------------------

test("C18: baseColor is stored as linear RGBA factors without sRGB conversion; alpha drives opacity", async () => {
  const { view, h } = await scene([cube("entity:m", 0, {}, [0.25, 0.5, 0.75, 1])]);
  const material = materialOf(view, "entity:m");
  assert.deepEqual([material.color.r, material.color.g, material.color.b], [0.25, 0.5, 0.75]);
  assert.equal(material.opacity, 1);
  assert.equal(material.transparent, false);
  // The same factors expressed through Three's linear working space, for clarity.
  assert.ok(material.color.equals(new Color().setRGB(0.25, 0.5, 0.75, LinearSRGBColorSpace)));

  h.socket.deliver(updated("entity:m", "hvtp.material@1", materialValue([1, 0, 0, 0.5], 2), 11));
  assert.deepEqual([material.color.r, material.color.g, material.color.b, material.opacity, material.transparent], [1, 0, 0, 0.5, true]);
  // Canonical state is read, never mutated, by the adapter.
  assert.deepEqual((h.client.entities.get("entity:m") as any).components["hvtp.material@1"].state.baseColor, [1, 0, 0, 0.5]);
  h.client.disconnect();
});

test("applyBaseColor reads frozen canonical state without writing into it", () => {
  const material = new MeshStandardMaterial();
  const mesh = new Mesh(new BufferGeometry(), material);
  const state = deepFreeze({ baseColor: [0.1, 0.2, 0.3, 0.4] as [number, number, number, number] });
  applyBaseColor(mesh, state);
  assert.deepEqual([material.color.r, material.color.g, material.color.b, material.opacity], [0.1, 0.2, 0.3, 0.4]);
  assert.deepEqual(state.baseColor, [0.1, 0.2, 0.3, 0.4]);
});

test("two entities using the cached fixture never share mutable material state", async () => {
  const { view, h } = await scene([cube("entity:a", 0, {}, [1, 0, 0, 1]), cube("entity:b", 2, {}, [0, 0, 1, 1])]);
  const a = materialOf(view, "entity:a");
  const b = materialOf(view, "entity:b");
  assert.notEqual(a, b);
  assert.deepEqual([a.color.r, a.color.b, b.color.r, b.color.b], [1, 0, 0, 1]);
  h.socket.deliver(updated("entity:a", "hvtp.material@1", materialValue([0, 1, 0, 1], 2), 11));
  assert.deepEqual([b.color.r, b.color.g, b.color.b], [0, 0, 1]);
  // Geometry is the shared, cache-owned fixture.
  assert.equal(meshesOf(view.object("entity:a")!)[0]!.geometry, meshesOf(view.object("entity:b")!)[0]!.geometry);
  h.client.disconnect();
});

test("renderable visible:false hides the fixture but keeps canonical state and view membership", async () => {
  const { view, h } = await scene([cube("entity:hidden", 0, {}, [1, 1, 1, 1], false)]);
  assert.ok(h.client.entities.has("entity:hidden"));
  assert.equal(view.object("entity:hidden")!.visible, false);
  assert.equal(view.assetStatus("entity:hidden"), "loaded");
  h.client.disconnect();
});

test("own presence stays in canonical state but is not rendered", async () => {
  const { view, h } = await scene([cube("entity:a")]);
  assert.equal(h.client.entities.size, 2);
  assert.equal(view.size, 1);
  assert.equal(view.object(h.client.presenceEntityId!), undefined);
  h.client.disconnect();
});

// ---------------------------------------------------------------------------------------------------------------
// Lifecycle: creation, update, leave/re-enter, delete, disconnect
// ---------------------------------------------------------------------------------------------------------------

test("lifecycle publications add, update, remove, and rebuild renderer objects from canonical state", async () => {
  const { view, h } = await scene([]);
  h.socket.deliver(created(cube("entity:x", 1, {}, [1, 0, 0, 1]), 11));
  await view.whenIdle();
  const first = view.object("entity:x")!;
  assert.deepEqual(first.position.toArray(), [1, 0.5, 0]);

  h.socket.deliver(updated("entity:x", "hvtp.transform@1", transformValue(4, 2), 12));
  assert.equal(view.object("entity:x"), first);
  assert.deepEqual(first.position.toArray(), [4, 0.5, 0]);

  const firstMaterial = materialOf(view, "entity:x");
  let disposed = 0;
  firstMaterial.addEventListener("dispose", () => { disposed += 1; });
  h.socket.deliver(leave("entity:x", 13));
  assert.equal(view.object("entity:x"), undefined);
  assert.equal(first.parent, null);
  assert.equal(disposed, 1, "per-entity material is disposed on leave");

  // Re-entry is rebuilt solely from the complete enter message.
  h.socket.deliver(enter(cube("entity:x", -2, { transform: 5, material: 3 }, [0, 0, 1, 0.25]), 20));
  await view.whenIdle();
  const second = view.object("entity:x")!;
  assert.notEqual(second, first);
  assert.deepEqual(second.position.toArray(), [-2, 0.5, 0]);
  const secondMaterial = materialOf(view, "entity:x");
  assert.deepEqual([secondMaterial.color.r, secondMaterial.color.b, secondMaterial.opacity], [0, 1, 0.25]);

  h.socket.deliver(deleted("entity:x", 21));
  assert.equal(view.object("entity:x"), undefined);
  assert.equal(view.root.children.length, 0);
  h.client.disconnect();
});

test("repeated leave/re-enter cycles do not accumulate objects or undisposed materials", async () => {
  const { view, h } = await scene([cube("entity:loop")]);
  let created = 0;
  let disposed = 0;
  for (let i = 0; i < 25; i++) {
    const material = materialOf(view, "entity:loop");
    created += 1;
    material.addEventListener("dispose", () => { disposed += 1; });
    h.socket.deliver(leave("entity:loop", 100 + i * 2));
    h.socket.deliver(enter(cube("entity:loop", i), 101 + i * 2));
    await view.whenIdle();
  }
  assert.equal(view.root.children.length, 1);
  assert.equal(disposed, created);
  h.client.disconnect();
});

test("disconnect removes every renderer object; reconnect rebuilds from the fresh snapshot", async () => {
  const { view, h } = await scene([cube("entity:a"), cube("entity:b")]);
  assert.equal(view.root.children.length, 2);
  h.socket.hostClose(1006);
  assert.equal(view.root.children.length, 0);
  assert.equal(view.size, 0);
  await live(h, [cube("entity:b", 3, { transform: 2 })], { snapshotId: "snapshot:2", snapshotBaseSeq: 0, subscriptionId: "subscription:new", realmEpoch: "epoch:test-1" });
  await view.whenIdle();
  assert.deepEqual(view.root.children.map((child) => child.name), ["entity:b"]);
  assert.deepEqual(view.object("entity:b")!.position.toArray(), [3, 0.5, 0]);
  h.client.disconnect();
});

// ---------------------------------------------------------------------------------------------------------------
// Asset policy (C34) and placeholder
// ---------------------------------------------------------------------------------------------------------------

test("C34: the fixture URI resolves against the advertised assetBaseUri, without redirects or credentials, once per session", async () => {
  const calls: FetchCall[] = [];
  const { view, h } = await scene([cube("entity:a"), cube("entity:b")], fixtureFetch(calls));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, ASSET_URL);
  assert.equal(calls[0]!.init.redirect, "manual");
  assert.equal(calls[0]!.init.credentials, "omit");
  assert.equal(view.assetStatus("entity:a"), "loaded");
  assert.equal(view.object("entity:a")!.getObjectByName(PLACEHOLDER_NAME), undefined);
  const loader = new P1FixtureLoader({ assetBaseUri: "https://realm.example/assets/p1/", maxAssetBytes: 1 });
  assert.equal(loader.resolve("unit-cube.gltf"), "https://realm.example/assets/p1/unit-cube.gltf");
  h.client.disconnect();
});

const failureCases: Array<[string, (calls: FetchCall[]) => P1FetchLike, RegExp, number?]> = [
  ["redirect", (calls) => fixtureFetch(calls, null, { status: 302, headers: { location: "http://elsewhere/unit-cube.gltf" } }), /redirect/],
  ["non-200", (calls) => fixtureFetch(calls, "missing", { status: 404, headers: { "content-type": "text/plain" } }), /status 404/],
  ["network error", (calls) => async (url, init) => { calls.push({ url, init }); throw new TypeError("network down"); }, /fetch failed/],
  ["wrong media type", (calls) => fixtureFetch(calls, FIXTURE, { headers: { "content-type": "application/json" } }), /media type/],
  ["declared Content-Length above maxAssetBytes", (calls) => fixtureFetch(calls, FIXTURE,
    { headers: { "content-type": "model/gltf+json", "content-length": String(5_242_881) } }), /declared size/],
  ["streamed body above maxAssetBytes", (calls) => async (url, init) => {
    calls.push({ url, init });
    // An endless body with no Content-Length: the reader must stop at the limit instead of buffering forever.
    const stream = new ReadableStream<Uint8Array>({ pull: (controller) => controller.enqueue(new Uint8Array(256 * 1024)) });
    return new Response(stream, { status: 200, headers: { "content-type": "model/gltf+json" } });
  }, /exceeds maxAssetBytes/],
  ["malformed glTF JSON", (calls) => fixtureFetch(calls, "{\"asset\": ", { headers: { "content-type": "model/gltf+json" } }), /not UTF-8 glTF JSON/],
  ["structurally invalid glTF", (calls) => fixtureFetch(calls, JSON.stringify({ asset: { version: "1.0" }, nodes: [{ name: "UnitCube" }] }),
    { headers: { "content-type": "model/gltf+json" } }), /invalid glTF/],
  ["missing UnitCube node", (calls) => fixtureFetch(calls, FIXTURE.toString("utf8").replace(/"name": "UnitCube",\s*"mesh"/, "\"name\": \"Other\", \"mesh\""),
    { headers: { "content-type": "model/gltf+json" } }), /no node named 'UnitCube'/],
  ["external buffer reference", (calls) => fixtureFetch(calls, FIXTURE.toString("utf8").replace(/"uri": "data:[^"]*"/, "\"uri\": \"http://elsewhere/cube.bin\""),
    { headers: { "content-type": "model/gltf+json" } }), /external resource/],
];

for (const [name, makeFetch, reason] of failureCases) {
  test(`C34: ${name} falls back to a local placeholder without touching shared state`, async () => {
    const calls: FetchCall[] = [];
    const { view, h, failures } = await scene([cube("entity:a", 1, {}, [0.5, 0.5, 0.5, 1]), cube("entity:b")], makeFetch(calls));
    const before = structuredClone([...h.client.entities.entries()]);
    assert.equal(view.assetStatus("entity:a"), "placeholder");
    assert.equal(view.assetStatus("entity:b"), "placeholder");
    assert.ok(view.object("entity:a")!.getObjectByName(PLACEHOLDER_NAME));
    assert.equal(view.object("entity:a")!.getObjectByName("UnitCube"), undefined);
    assert.ok(failures.length === 2 && failures.every((failure) => reason.test(failure)), `${failures}`);
    // One failed attempt per session, no other network requests, no repair mutations, unchanged canonical view.
    assert.equal(calls.length, 1);
    assert.deepEqual(h.socket.sent.map((message) => message.type), ["session.hello", "realm.join"]);
    assert.deepEqual([...h.client.entities.entries()], before);
    assert.equal(h.client.phase, "live");
    // Placeholders still follow canonical transform/visibility.
    assert.deepEqual(view.object("entity:a")!.position.toArray(), [1, 0.5, 0]);
    h.client.disconnect();
  });
}

test("a renderable that is not the P1 fixture reference is a local load failure", async () => {
  const loader = new P1FixtureLoader({ assetBaseUri: "http://127.0.0.1:8787/assets/p1/", maxAssetBytes: 5_242_880,
    fetch: () => { throw new Error("must not fetch"); } });
  const result = await loader.load({ asset: { uri: "other.gltf", mediaType: "model/gltf+json" }, node: "UnitCube", visible: true } as never);
  assert.equal(result.ok, false);
});
