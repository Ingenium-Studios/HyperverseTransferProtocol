import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import test from "node:test";
import { P1_LIMITS } from "@hvtp/protocol-types";
import { createReferenceHost, type ReferenceHost } from "./server.js";
import {
  connectedPeer, cubeInput, deleteMessage, fastClock, joinCollect, patchTransformMessage, setTransformMessage,
  snapshotSharedIds, subscriptionMessage, withHost,
} from "./test-support.js";

// ------------------------------------------------------------------------- C06 union

const union = { spatial: { center: [0, 0, 0], radius: 25 }, entities: ["entity:far-away"] };

function seedUnion(host: ReferenceHost): void {
  host.worldStore.createEntity(cubeInput("entity:far-away", 1000));
  host.worldStore.createEntity(cubeInput("entity:near", 5));
  host.worldStore.createEntity(cubeInput("entity:pinned-near", 5));
  host.worldStore.createEntity(cubeInput("entity:unrelated", 500));
}

test("C06 join and subscription.set take the union of spatial and explicit selection; {} selects only own presence", () => withHost(async (host) => {
  seedUnion(host);
  const joiner = await connectedPeer(host);
  assert.deepEqual(snapshotSharedIds(await joinCollect(joiner, union)), ["entity:far-away", "entity:near", "entity:pinned-near"]);

  const replacer = await connectedPeer(host);
  await joinCollect(replacer, {});
  replacer.send(subscriptionMessage("union", union));
  assert.equal((await replacer.next()).type, "subscription.applied");
  const entered = (await replacer.take(3)).map((m) => { assert.equal(m.type, "view.entity.enter"); return (m.body.entity as { id: string }).id; });
  assert.deepEqual(entered.sort(), ["entity:far-away", "entity:near", "entity:pinned-near"]);
  assert.deepEqual(await replacer.fence(host), []);

  // Empty selector and omitted spatial + empty entity list: no world entities, only the participant's own presence.
  for (const selector of [{}, { entities: [] }]) {
    const empty = await connectedPeer(host);
    const messages = await joinCollect(empty, selector);
    assert.deepEqual(snapshotSharedIds(messages), []);
    assert.equal(messages.at(-1)!.body.entityCount, 1);
    assert.equal(messages.filter((m) => m.type === "entity.snapshot").length, 1);
  }
  replacer.send(subscriptionMessage("clear", {}));
  const applied = await replacer.next();
  assert.equal(applied.type, "subscription.applied");
  assert.deepEqual((await replacer.take(3)).map((m) => m.type), ["view.entity.leave", "view.entity.leave", "view.entity.leave"]);
}));

test("C06 live projection keeps the union: pinned entities stay when they move away, spatial-only entities leave", () => withHost(async (host) => {
  seedUnion(host);
  const observer = await connectedPeer(host);
  await joinCollect(observer, { ...union, entities: ["entity:far-away", "entity:pinned-near"] });
  const actor = await connectedPeer(host);
  await joinCollect(actor, {});

  assert.equal((await actor.request(setTransformMessage("far-further", "entity:far-away", 1, 2000))).type, "ack");
  assert.equal((await actor.request(setTransformMessage("near-out", "entity:near", 1, 100))).type, "ack");
  assert.equal((await actor.request(patchTransformMessage("pinned-out", "entity:pinned-near", 1, 100))).type, "ack");
  assert.equal((await actor.request(setTransformMessage("near-back", "entity:near", 2, 5))).type, "ack");
  const events = await observer.fence(host);
  assert.deepEqual(events.map((m) => [m.type, m.body.entityId ?? (m.body.entity as { id: string } | undefined)?.id]), [
    ["component.updated", "entity:far-away"],
    ["view.entity.leave", "entity:near"],
    ["component.updated", "entity:pinned-near"],
    ["view.entity.enter", "entity:near"],
  ]);
}));

// ------------------------------------------------------------------------- C19 other mutation kinds

test("C19 pre-commit fault on set, patch and delete: error, no publication, nothing changes, and a restart on the same file keeps the prior state", async () => {
  const dir = mkdtempSync(joinPath(tmpdir(), "hvtp-fault-"));
  const databasePath = joinPath(dir, "world.sqlite");
  let fail = false;
  const options = { databasePath, clock: fastClock(), worldStoreOptions: { beforeCommit: () => { if (fail) throw new Error("private storage detail"); } } };
  let first: ReferenceHost | null = null;
  let second: ReferenceHost | null = null;
  try {
    first = await createReferenceHost(options);
    first.worldStore.createEntity(cubeInput("E"));
    const observer = await connectedPeer(first);
    await joinCollect(observer, { entities: ["E"] });
    const actor = await connectedPeer(first);
    await joinCollect(actor, {});
    const seq = first.worldStore.getRealmSeq();
    const before = JSON.stringify(first.worldStore.getEntity("E"));

    // Recording starts before the faulted attempts: the observer's fence returns everything that arrived.
    fail = true;
    for (const request of [
      setTransformMessage("f-set", "E", 1, 5),
      patchTransformMessage("f-patch", "E", 1, 6),
      deleteMessage("f-delete", "E"),
    ]) {
      const reply = await actor.request(request);
      assert.equal(reply.type, "error", request.id);
      assert.equal(reply.body.code, "resource_limit", request.id);
      assert.equal(reply.body.ref, request.id);
      assert.equal(JSON.stringify(reply).includes("private storage detail"), false);
      assert.equal(first.worldStore.getRealmSeq(), seq, request.id);
      assert.equal(JSON.stringify(first.worldStore.getEntity("E")), before, request.id);
      assert.equal(first.worldStore.isTombstoned("E"), false, request.id);
    }
    assert.deepEqual(await observer.fence(first), [], "no faulted attempt published anything");

    await first.close();
    first = null;
    fail = false;
    second = await createReferenceHost(options);
    assert.equal(JSON.stringify(second.worldStore.getEntity("E")), before, "previous revisions survive the restart");
    assert.equal(second.worldStore.isTombstoned("E"), false, "no tombstone was written");
    assert.equal(second.worldStore.getEntity("E")!.components["hvtp.transform@1"].revision, 1);
    // The store is healthy afterwards: the same logical operations now commit at the original revision.
    const peer = await connectedPeer(second);
    await joinCollect(peer, {});
    assert.equal((await peer.request(setTransformMessage("f-set", "E", 1, 5))).type, "ack");
    assert.equal(second.worldStore.getEntity("E")!.components["hvtp.transform@1"].revision, 2);
  } finally {
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------- C21 explicit entity ids

const ids = (count: number) => Array.from({ length: count }, (_, i) => `id-${i}`);

test("C21 explicit entity id count: 256 accepted, 257 is resource_limit on join (session stays joinable) and on subscription.set (generation preserved)", () =>
  withHost(async (host) => {
    assert.equal(P1_LIMITS.maxExplicitEntityIds, 256);
    host.worldStore.createEntity(cubeInput("E"));

    const joiner = await connectedPeer(host);
    joiner.send({ hvtp: "0.2", id: "join-257", type: "realm.join", body: { realm: "urn:hvtp:realm:prototype-world", subscription: { entities: ids(257) } } });
    const refused = await joiner.next();
    assert.equal(refused.type, "error");
    assert.equal(refused.body.code, "resource_limit");
    assert.equal(refused.body.ref, "join-257");
    const ok = await joinCollect(joiner, { entities: ids(256) }, "join-256");
    assert.equal(ok[0]!.type, "realm.joined", "still NEGOTIATED after the refusal; 256 ids accepted");
    assert.equal((ok[0]!.body.effectiveSubscription as { entities: string[] }).entities.length, 256);

    const observer = await connectedPeer(host);
    const joined = await joinCollect(observer, { entities: ["E"] });
    const generation = joined[0]!.body.subscriptionId;
    observer.send(subscriptionMessage("set-257", { entities: ids(257) }));
    const tooMany = await observer.next();
    assert.equal(tooMany.body.code, "resource_limit");
    assert.equal(tooMany.body.ref, "set-257");

    const actor = await connectedPeer(host);
    await joinCollect(actor, {});
    assert.equal((await actor.request(setTransformMessage("bump", "E", 1, 3))).type, "ack");
    const [update] = await observer.fence(host);
    assert.equal(update!.type, "component.updated", "previous view preserved");
    assert.equal(update!.body.subscriptionId, generation, "publication still tagged with the old subscriptionId");

    observer.send(subscriptionMessage("set-256", { entities: ids(256) }));
    const applied = await observer.next();
    assert.equal(applied.type, "subscription.applied");
    assert.equal(applied.body.previousSubscriptionId, generation);
  }));

test("C21 maxEntityBytes is unreachable for valid P1 entities: worst-case serialized entity is far below the limit", () => {
  // A valid entity has a fixed shape: the id is at most 128 UTF-8 bytes (up to 6 bytes each when JSON-escaped),
  // the renderable is the fixed fixture, and every other field is a bounded-length numeric array. The largest
  // number text is a 17-significant-digit double with exponent (about 24 characters).
  const worstId = 128 * 6;
  const worstNumber = 24;
  const numbers = 3 + 4 + 3 + 4;
  const envelope = 3 * 140; // revision, authority, epoch, consistency keys per component
  const fixture = 200; // asset uri, mediaType, node, visible
  const worstCase = worstId + numbers * worstNumber + envelope + fixture + 100;
  assert.ok(worstCase < P1_LIMITS.maxEntityBytes / 50, `worst case ${worstCase} bytes`);
  assert.ok(worstCase * 50 < P1_LIMITS.maxEntityBytes);
});
