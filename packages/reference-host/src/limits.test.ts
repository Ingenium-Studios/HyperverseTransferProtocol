import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import test from "node:test";
import { MAX_SAFE_PROTOCOL_INTEGER, P1_LIMITS } from "@hvtp/protocol-types";
import { createReferenceHost, type ReferenceHost } from "./server.js";
import { isLocalDevelopmentHost, validateAssetOrigin } from "./origin.js";
import {
  connect, createMessage, cubeInput, deleteMessage, joinedPeer, patchTransformMessage, setTransformMessage,
} from "./test-support.js";

const MAX_SAFE = Number.MAX_SAFE_INTEGER; // 2^53 - 1
assert.equal(MAX_SAFE_PROTOCOL_INTEGER, MAX_SAFE);

/** File-backed host plus a second raw SQLite connection used only to seed durable fixtures (no unsafe production API). */
async function withSeededHost(run: (host: ReferenceHost, raw: DatabaseSync) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(joinPath(tmpdir(), "hvtp-limits-"));
  const databasePath = joinPath(dir, "world.sqlite");
  let tick = 0;
  const host = await createReferenceHost({ databasePath, clock: () => (tick += 20) });
  const raw = new DatabaseSync(databasePath);
  try { await run(host, raw); } finally {
    raw.close();
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const rawCount = (raw: DatabaseSync): number => (raw.prepare("SELECT COUNT(*) AS n FROM p1_entities").get() as { n: number }).n;

test("C32 realm seq 2^53-1: create, component set and delete are resource_limit before any state change", () =>
  withSeededHost(async (host, raw) => {
    host.worldStore.createEntity(cubeInput("E"));
    host.worldStore.createEntity(cubeInput("F"));
    const observer = await joinedPeer(host, { spatial: { center: [0, 0, 0], radius: 10 } });
    const requester = await joinedPeer(host, {});
    raw.prepare("UPDATE p1_meta SET integer_value = ? WHERE key = 'realm_seq'").run(MAX_SAFE);
    assert.equal(host.worldStore.getRealmSeq(), MAX_SAFE);
    const before = JSON.stringify(host.worldStore.getEntity("E"));
    const countBefore = rawCount(raw);

    const results = [
      await requester.request(createMessage("req-create", "new")),
      await requester.request(setTransformMessage("req-set", "E", 1, 5)),
      await requester.request(patchTransformMessage("req-patch", "E", 1, 5)),
      await requester.request(deleteMessage("req-delete", "F")),
    ];
    for (const result of results) {
      assert.equal(result.type, "error");
      assert.equal(result.body.code, "resource_limit");
    }
    assert.deepEqual(results.map((result) => result.body.ref), ["req-create", "req-set", "req-patch", "req-delete"]);
    assert.equal(host.worldStore.getRealmSeq(), MAX_SAFE, "sequence is exactly 2^53-1");
    assert.equal(JSON.stringify(host.worldStore.getEntity("E")), before, "no revision or state change");
    assert.notEqual(host.worldStore.getEntity("F"), null, "delete did not apply");
    assert.equal(host.worldStore.isTombstoned("F"), false);
    assert.equal(host.worldStore.getEntity("new"), null);
    assert.equal(host.worldStore.isTombstoned("new"), false);
    assert.equal(rawCount(raw), countBefore, "no row or tombstone was added");
    await host.realmCoordinator.drain(); await observer.flush();
    assert.deepEqual(observer.messages, [], "no canonical publication");
    assert.deepEqual(requester.messages, [], "no committed ACK");
    assert.equal(requester.socket.readyState, requester.socket.OPEN);
    observer.socket.close(); requester.socket.close();
  }));

test("C32 component revision 2^53-1: valid mutation is resource_limit before any state change", () =>
  withSeededHost(async (host, raw) => {
    host.worldStore.createEntity(cubeInput("E"));
    const row = raw.prepare("SELECT entity_json AS json FROM p1_entities WHERE id = 'E'").get() as { json: string };
    const seeded = JSON.parse(row.json);
    seeded.components["hvtp.transform@1"].revision = MAX_SAFE;
    raw.prepare("UPDATE p1_entities SET entity_json = ? WHERE id = 'E'").run(JSON.stringify(seeded));
    const observer = await joinedPeer(host, { spatial: { center: [0, 0, 0], radius: 10 } });
    const requester = await joinedPeer(host, {});
    const before = JSON.stringify(host.worldStore.getEntity("E"));
    const seq = host.worldStore.getRealmSeq();
    assert.equal(host.worldStore.getEntity("E")!.components["hvtp.transform@1"].revision, MAX_SAFE);

    for (const request of [setTransformMessage("req-set", "E", MAX_SAFE, 7), patchTransformMessage("req-patch", "E", MAX_SAFE, 7)]) {
      const result = await requester.request(request);
      assert.equal(result.type, "error");
      assert.equal(result.body.code, "resource_limit");
      assert.equal(result.body.ref, request.id);
    }
    assert.equal(JSON.stringify(host.worldStore.getEntity("E")), before);
    assert.equal(host.worldStore.getEntity("E")!.components["hvtp.transform@1"].revision, MAX_SAFE);
    assert.equal(host.worldStore.getRealmSeq(), seq);
    await host.realmCoordinator.drain(); await observer.flush();
    assert.deepEqual(observer.messages, []);
    assert.deepEqual(requester.messages, []);
    observer.socket.close(); requester.socket.close();
  }));

test("C21 persistent budget: live entities plus tombstones fill maxPersistentEntityRecords, deletion frees no capacity", () =>
  withSeededHost(async (host, raw) => {
    const live = 10;
    const seededTombstones = P1_LIMITS.maxPersistentEntityRecords - live;
    raw.exec("BEGIN");
    const insert = raw.prepare("INSERT INTO p1_entities(id, deleted, entity_json) VALUES (?, 1, NULL)");
    for (let i = 0; i < seededTombstones; i++) insert.run(`tomb-${i}`);
    raw.exec("COMMIT");

    const observer = await joinedPeer(host, { spatial: { center: [0, 0, 0], radius: 10 } });
    const requester = await joinedPeer(host, {});
    for (let i = 0; i < live; i++) {
      assert.equal((await requester.request(createMessage(`req-${i}`, `live-${i}`))).type, "ack", `create ${i} fits (last one reaches the budget exactly)`);
    }
    assert.equal(rawCount(raw), P1_LIMITS.maxPersistentEntityRecords);
    for (let i = 0; i < 3; i++) assert.equal((await requester.request(deleteMessage(`del-${i}`, `live-${i}`))).type, "ack");
    assert.equal(rawCount(raw), P1_LIMITS.maxPersistentEntityRecords, "deleted entities remain as permanent tombstones");
    await host.realmCoordinator.drain();
    await observer.take(live + 3); // every publication from the fill/delete phase has arrived
    const seq = host.worldStore.getRealmSeq();
    assert.equal(seq, live + 3);

    for (const id of ["fresh-a", "fresh-b"]) {
      const result = await requester.request(createMessage(`req-${id}`, id));
      assert.equal(result.type, "error");
      assert.equal(result.body.code, "resource_limit");
      assert.equal(host.worldStore.getEntity(id), null);
      assert.equal(host.worldStore.isTombstoned(id), false);
    }
    assert.equal((await requester.request(createMessage("req-reuse", "live-0"))).body.code, "entity_exists", "tombstoned IDs are never reusable");
    assert.equal(rawCount(raw), P1_LIMITS.maxPersistentEntityRecords);
    assert.equal(host.worldStore.getRealmSeq(), seq);
    await host.realmCoordinator.drain(); await observer.flush();
    assert.deepEqual(observer.messages, [], "no publication for refused creates");
    observer.socket.close(); requester.socket.close();
  }));

test("maxEntityBytes is unreachable through valid P1 wire input (worst-case entity is far below the limit)", async () => {
  const host = await createReferenceHost({ databasePath: ":memory:" });
  try {
    // Longest legal ID: 128 UTF-8 bytes of control characters, each expanding to a 6-byte JSON escape.
    const id = "\u0001".repeat(128);
    // Longest-printing finite doubles inside the legal ranges; closed schema permits no other fields.
    const wide = 0.12345678901234568;
    const { entity } = host.worldStore.createEntity({
      id,
      transform: { position: [-wide, -wide, -wide], rotation: [0.5, 0.5, 0.5, 0.5], scale: [wide + 1, wide + 1, wide + 1] },
      renderable: { asset: { uri: "unit-cube.gltf", mediaType: "model/gltf+json" }, node: "UnitCube", visible: true },
      material: { baseColor: [wide, wide, wide, wide] },
    });
    const size = Buffer.byteLength(JSON.stringify(entity));
    assert.ok(size < 4_096, `worst-case valid entity is ${size} bytes`);
    assert.ok(size < P1_LIMITS.maxEntityBytes / 30);
  } finally {
    await host.close();
  }
});

// ---- asset serving and origin hardening ----

test("asset: unit-cube is served 200 with model/gltf+json, no redirect; other paths and methods are 404", async () => {
  const host = await createReferenceHost({ databasePath: ":memory:" });
  try {
    const base = `http://${host.host}:${host.port}/assets/p1/`;
    const ok = await fetch(`${base}unit-cube.gltf`, { redirect: "manual" });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "model/gltf+json");
    assert.equal(ok.headers.get("location"), null);
    assert.equal(Number(ok.headers.get("content-length")), (await ok.arrayBuffer()).byteLength);
    for (const path of ["other.gltf", "", "unit-cube.gltf?x=1", "../unit-cube.gltf", "unit-cube.glb"]) {
      const response = await fetch(`${base}${path}`, { redirect: "manual" });
      assert.equal(response.status, 404, path);
      await response.arrayBuffer();
    }
    const post = await fetch(`${base}unit-cube.gltf`, { method: "POST", redirect: "manual" });
    assert.equal(post.status, 404);
    await post.arrayBuffer();

    const peer = await connect(host);
    const welcome = await peer.hello();
    const advertised = welcome.body.assetBaseUri as string;
    assert.ok(URL.canParse(advertised) && advertised.endsWith("/"));
    assert.equal(new URL("unit-cube.gltf", advertised).toString(), `${base}unit-cube.gltf`);
    peer.socket.close();
  } finally {
    await host.close();
  }
});

test("asset: fixture larger than maxAssetBytes is 413 with no body; exactly maxAssetBytes is served; missing fixture is 404", async () => {
  const dir = mkdtempSync(joinPath(tmpdir(), "hvtp-asset-"));
  const fixturePath = joinPath(dir, "fixture.gltf");
  const host = await createReferenceHost({ databasePath: ":memory:", fixturePath });
  try {
    const url = `http://${host.host}:${host.port}/assets/p1/unit-cube.gltf`;
    writeFileSync(fixturePath, Buffer.alloc(P1_LIMITS.maxAssetBytes + 1, 0x20));
    const oversized = await fetch(url, { redirect: "manual" });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.arrayBuffer()).byteLength, 0, "oversized fixture is not streamed");
    assert.notEqual(oversized.headers.get("content-type"), "model/gltf+json");

    writeFileSync(fixturePath, Buffer.alloc(P1_LIMITS.maxAssetBytes, 0x20));
    const exact = await fetch(url, { redirect: "manual" });
    assert.equal(exact.status, 200);
    assert.equal((await exact.arrayBuffer()).byteLength, P1_LIMITS.maxAssetBytes);

    rmSync(fixturePath);
    const missing = await fetch(url, { redirect: "manual" });
    assert.equal(missing.status, 404);
    await missing.arrayBuffer();
  } finally {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HTTPS is required for non-loopback asset origins; loopback HTTP and any HTTPS origin are accepted", async () => {
  for (const origin of ["http://127.0.0.1:8787/", "http://127.1.2.3/", "http://localhost:8080", "http://dev.localhost/", "http://[::1]:9/", "https://example.com/", "https://realm.example:8443/"]) {
    assert.doesNotThrow(() => validateAssetOrigin(origin), origin);
  }
  for (const origin of ["http://example.com/", "http://10.0.0.5:8787/", "http://0.0.0.0:8787/", "http://localhost.example.com/", "ftp://example.com/", "example.com", "ws://localhost/"]) {
    assert.throws(() => validateAssetOrigin(origin), origin);
  }
  assert.equal(isLocalDevelopmentHost("[::1]"), true);
  assert.equal(isLocalDevelopmentHost("127.0.0.1"), true);

  await assert.rejects(createReferenceHost({ databasePath: ":memory:", publicOrigin: "http://example.com/" }), /HTTPS/);
  await assert.rejects(createReferenceHost({ databasePath: ":memory:", host: "0.0.0.0" }), /HTTPS/, "default origin from a non-loopback bind host is not a valid P1 origin");

  const secure = await createReferenceHost({ databasePath: ":memory:", publicOrigin: "https://example.com/" });
  try {
    const peer = await connect(secure);
    assert.equal((await peer.hello()).body.assetBaseUri, "https://example.com/assets/p1/");
    peer.socket.close();
  } finally {
    await secure.close();
  }
  const local = await createReferenceHost({ databasePath: ":memory:", publicOrigin: "http://localhost:3000" });
  try {
    const peer = await connect(local);
    assert.equal((await peer.hello()).body.assetBaseUri, "http://localhost:3000/assets/p1/");
    peer.socket.close();
  } finally {
    await local.close();
  }
});
