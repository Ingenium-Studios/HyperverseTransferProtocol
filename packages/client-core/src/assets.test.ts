import assert from "node:assert/strict";
import test from "node:test";
import type { P1RenderableState } from "@hvtp/protocol-types";
import { fetchP1Fixture, inspectP1Fixture, isP1FixtureRenderable, resolveP1AssetUrl, type P1FetchLike } from "./index.js";

const BASE = "http://127.0.0.1:8787/assets/p1/";
const RENDERABLE: P1RenderableState = { asset: { uri: "unit-cube.gltf", mediaType: "model/gltf+json" }, node: "UnitCube", visible: true };
const DOC = JSON.stringify({ asset: { version: "2.0" }, nodes: [{ name: "Other" }, { name: "UnitCube" }], buffers: [{ uri: "data:application/octet-stream;base64,AAAA" }] });
const GLTF = { "content-type": "model/gltf+json" };

interface Call { url: string; init: RequestInit }
const respond = (calls: Call[], body: BodyInit | null, init: ResponseInit = { status: 200, headers: GLTF }): P1FetchLike =>
  async (url, requestInit) => { calls.push({ url, init: requestInit }); return new Response(body, init); };
const options = (fetch: P1FetchLike, maxAssetBytes = 5_242_880) => ({ assetBaseUri: BASE, maxAssetBytes, fetch });

test("resolveP1AssetUrl resolves against the advertised base, independent of any document origin", () => {
  assert.equal(resolveP1AssetUrl("https://realm.example/assets/p1/", "unit-cube.gltf"), "https://realm.example/assets/p1/unit-cube.gltf");
  assert.equal(resolveP1AssetUrl("https://realm.example/deep/a/b/", "unit-cube.gltf"), "https://realm.example/deep/a/b/unit-cube.gltf");
});

test("fetchP1Fixture: success uses redirect manual, credentials omitted, and returns the bytes", async () => {
  const calls: Call[] = [];
  const result = await fetchP1Fixture(RENDERABLE, options(respond(calls, DOC)));
  assert.ok(result.ok);
  assert.equal(result.url, `${BASE}unit-cube.gltf`);
  assert.equal(new TextDecoder().decode(result.bytes), DOC);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.init.redirect, "manual");
  assert.equal(calls[0]!.init.credentials, "omit");
});

test("fetchP1Fixture: a non-fixture renderable is refused without fetching", async () => {
  const calls: Call[] = [];
  const other = { ...RENDERABLE, asset: { ...RENDERABLE.asset, uri: "other.gltf" } } as unknown as P1RenderableState;
  assert.equal(isP1FixtureRenderable(other), false);
  const result = await fetchP1Fixture(other, options(respond(calls, DOC)));
  assert.deepEqual(result, { ok: false, url: null, reason: "renderable is not the P1 unit-cube fixture reference" });
  assert.equal(calls.length, 0);
});

const failures: Array<[string, P1FetchLike, RegExp, number?]> = [
  ["redirect (3xx)", respond([], null, { status: 302, headers: { location: "http://elsewhere/x" } }), /redirect refused \(status 302\)/],
  ["redirected flag", async () => Object.defineProperty(new Response(DOC, { status: 200, headers: GLTF }), "redirected", { value: true }), /redirect refused/],
  ["opaque redirect", async () => Object.defineProperty(new Response(null, { status: 200 }), "type", { value: "opaqueredirect" }), /redirect refused/],
  ["non-200", respond([], "missing", { status: 404, headers: { "content-type": "text/plain" } }), /unexpected status 404/],
  ["network error", async () => { throw new TypeError("network down"); }, /fetch failed: network down/],
  ["wrong media type", respond([], DOC, { status: 200, headers: { "content-type": "application/json" } }), /unexpected media type 'application\/json'/],
  ["declared size too large", respond([], DOC, { status: 200, headers: { ...GLTF, "content-length": "11" } }), /declared size 11 exceeds maxAssetBytes 10/, 10],
  ["streamed body too large", async () => new Response(new ReadableStream<Uint8Array>({ pull: (c) => c.enqueue(new Uint8Array(1024)) }), { status: 200, headers: GLTF }), /body exceeds maxAssetBytes 4096/, 4096],
];
for (const [name, fetch, reason, max] of failures) {
  test(`fetchP1Fixture: ${name} is a local failure`, async () => {
    const result = await fetchP1Fixture(RENDERABLE, options(fetch, max));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.url, `${BASE}unit-cube.gltf`);
      assert.match(result.reason, reason);
    }
  });
}

test("fetchP1Fixture: media type parameters and case are tolerated", async () => {
  const result = await fetchP1Fixture(RENDERABLE, options(respond([], DOC, { status: 200, headers: { "content-type": "Model/GLTF+JSON; charset=utf-8" } })));
  assert.ok(result.ok);
});

test("inspectP1Fixture: finds the node and returns the text", () => {
  const result = inspectP1Fixture(new TextEncoder().encode(DOC), "UnitCube");
  assert.ok(result.ok);
  assert.equal(result.nodeIndex, 1);
  assert.equal(result.text, DOC);
});

const enc = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const bad: Array<[string, Uint8Array, RegExp]> = [
  ["invalid UTF-8", new Uint8Array([0xff, 0xfe, 0x7b]), /not UTF-8 glTF JSON/],
  ["malformed JSON", new TextEncoder().encode("{\"asset\": "), /not UTF-8 glTF JSON/],
  ["non-object JSON", new TextEncoder().encode("null"), /not a glTF JSON object/],
  ["external buffer", enc({ nodes: [{ name: "UnitCube" }], buffers: [{ uri: "cube.bin" }] }), /external resource/],
  ["external image", enc({ nodes: [{ name: "UnitCube" }], images: [{ uri: "http://x/a.png" }] }), /external resource/],
  ["missing node", enc({ nodes: [{ name: "Other" }] }), /no node named 'UnitCube'/],
  ["no nodes", enc({}), /no node named 'UnitCube'/],
  ["array JSON", new TextEncoder().encode("[]"), /not a glTF JSON object/],
  ["nodes is a number", enc({ nodes: 5 }), /no node named 'UnitCube'/],
  ["null node entries", enc({ nodes: [null, 3, "x"] }), /no node named 'UnitCube'/],
];

for (const [name, document] of [
  ["buffers is a number", { buffers: 1 }], ["images is an object", { images: {} }], ["buffers is a string", { buffers: "x" }],
  ["null buffer entries", { buffers: [null, 7], images: [null] }],
] as Array<[string, Record<string, unknown>]>) {
  test(`inspectP1Fixture: ${name} never throws`, () => {
    const result = inspectP1Fixture(enc({ nodes: [{ name: "UnitCube" }], ...document }), "UnitCube");
    assert.equal(typeof result.ok, "boolean");
  });
}
for (const [name, bytes, reason] of bad) {
  test(`inspectP1Fixture: ${name} is rejected`, () => {
    const result = inspectP1Fixture(bytes, "UnitCube");
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, reason);
  });
}
