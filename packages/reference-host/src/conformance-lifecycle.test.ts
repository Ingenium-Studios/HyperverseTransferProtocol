import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import test from "node:test";
import { P1_REALM_ID } from "@hvtp/protocol-types";
import { createReferenceHost, type ReferenceHost } from "./server.js";
import {
  connectedPeer, createMessage, cubeInput, deleteMessage, fastClock, joinCollect, patchTransformMessage, setTransformMessage,
  snapshotSharedIds, subscriptionMessage, withHost,
} from "./test-support.js";

const near = { spatial: { center: [0, 0, 0], radius: 10 } };
const far = { spatial: { center: [10000, 0, 0], radius: 10 } };

// ------------------------------------------------------------------------- C35

test("C35 creation visible to A and invisible to B: A gets exactly one entity.created on its active subscription, B gets nothing", () =>
  withHost(async (host) => {
    const a = await connectedPeer(host);
    const aJoin = await joinCollect(a, near);
    const b = await connectedPeer(host);
    await joinCollect(b, far);
    // A replaces its subscription first, so "active subscriptionId" is the new generation, not the join's.
    a.send(subscriptionMessage("a-replace", near));
    const applied = await a.next();
    assert.equal(applied.type, "subscription.applied");
    const activeId = applied.body.subscriptionId;
    assert.notEqual(activeId, aJoin[0]!.body.subscriptionId);
    const creator = await connectedPeer(host);
    await joinCollect(creator, {});

    const ack = await creator.request(createMessage("create", "entity:c35", 0));
    assert.equal(ack.type, "ack");
    const seqAfterCreate = host.worldStore.getRealmSeq();
    const aEvents = await a.fence(host);
    assert.deepEqual(aEvents.map((m) => m.type), ["entity.created"], "exactly one created, no view.entity.enter");
    assert.equal(aEvents[0]!.body.subscriptionId, activeId);
    assert.equal(aEvents[0]!.seq, seqAfterCreate);
    assert.deepEqual(await b.fence(host), [], "B receives neither created nor enter");

    // Deletion: A exactly one entity.deleted, no leave; B nothing.
    const deleted = await creator.request(deleteMessage("delete", "entity:c35"));
    assert.equal(deleted.type, "ack");
    const seqAfterDelete = host.worldStore.getRealmSeq();
    const aDeletion = await a.fence(host);
    assert.deepEqual(aDeletion.map((m) => m.type), ["entity.deleted"], "exactly one deleted, no view.entity.leave");
    assert.equal(aDeletion[0]!.body.subscriptionId, activeId);
    assert.equal(aDeletion[0]!.body.entityId, "entity:c35");
    assert.deepEqual(await b.fence(host), [], "B receives neither deleted nor leave");

    // Deleting again: entity_not_found, no sequence advance, no publication to anyone.
    const again = await creator.request(deleteMessage("delete-again", "entity:c35"));
    assert.equal(again.body.code, "entity_not_found");
    assert.equal(host.worldStore.getRealmSeq(), seqAfterDelete);
    assert.deepEqual(await a.fence(host), []);
    assert.deepEqual(await b.fence(host), []);
  }));

test("C35 a delayed deletion at seq N is enqueued before a later publication at seq N+1", () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return withHost(async (host) => {
    host.worldStore.createEntity(cubeInput("doomed"));
    host.worldStore.createEntity(cubeInput("other"));
    const observer = await connectedPeer(host);
    await joinCollect(observer, { entities: ["doomed", "other"] });
    const actor = await connectedPeer(host);
    await joinCollect(actor, {});
    assert.equal((await actor.request(deleteMessage("del", "doomed"))).type, "ack");
    assert.equal((await actor.request(setTransformMessage("later", "other", 1, 4))).type, "ack");
    release();
    const events = await observer.fence(host);
    assert.deepEqual(events.map((m) => [m.type, m.seq]), [["entity.deleted", 3], ["component.updated", 4]]);
  }, { realmCoordinatorOptions: { beforeMutationEnqueue: async (seq) => { if (seq === 3) await gate; } } }).finally(release);
});

// ------------------------------------------------------------------------- C10

test("C10 Variant B: a cached terminal error is replayed identically and is not reprocessed, even after the world would give a different answer", () =>
  withHost(async (host) => {
    host.worldStore.createEntity(cubeInput("E"));
    const observer = await connectedPeer(host);
    await joinCollect(observer, { entities: ["E", "late"] });
    const a = await connectedPeer(host);
    await joinCollect(a, {});
    const b = await connectedPeer(host);
    await joinCollect(b, {});

    // 1. revision_mismatch: base 2 is ahead of revision 1.
    const stale = setTransformMessage("stale", "E", 2, 9);
    const firstStale = await a.request(stale);
    assert.equal(firstStale.body.code, "revision_mismatch");
    assert.equal(firstStale.body.currentRevision, 1);
    // 2. entity_not_found: "late" does not exist yet.
    const missing = setTransformMessage("missing", "late", 1, 9);
    const firstMissing = await a.request(missing);
    assert.equal(firstMissing.body.code, "entity_not_found");
    // 3. invalid_component_state.
    const invalid = patchTransformMessage("invalid", "E", 1, 1);
    (invalid.body as any).patch = { position: null };
    const firstInvalid = await a.request(invalid);
    assert.equal(firstInvalid.body.code, "invalid_component_state");

    // Change the world so that reprocessing would give different answers: E reaches revision 2 (so base 2 would
    // now match, and base 1 would now mismatch) and "late" exists (so its update would now commit).
    assert.equal((await b.request(setTransformMessage("b-bump", "E", 1, 1))).type, "ack");
    assert.equal((await b.request(createMessage("b-late", "late", 0))).type, "ack");
    await host.realmCoordinator.drain();
    await observer.fence(host);
    const seq = host.worldStore.getRealmSeq();
    const snapshot = JSON.stringify([host.worldStore.getEntity("E"), host.worldStore.getEntity("late")]);

    // Reprocessing "stale" (base 2 vs current 2) would now ack, and "missing" would now commit.
    assert.deepEqual(await a.request(stale), firstStale);
    assert.deepEqual(await a.request(missing), firstMissing);
    assert.deepEqual(await a.request(invalid), firstInvalid);
    // A reordered-key but structurally equal retry is also the same logical request.
    const reordered = JSON.parse(JSON.stringify(stale));
    reordered.body = Object.fromEntries(Object.entries(reordered.body).reverse());
    assert.deepEqual(await a.request(JSON.stringify(Object.fromEntries(Object.entries(reordered).reverse()))), firstStale);

    assert.equal(host.worldStore.getRealmSeq(), seq);
    assert.equal(JSON.stringify([host.worldStore.getEntity("E"), host.worldStore.getEntity("late")]), snapshot);
    assert.deepEqual(await observer.fence(host), [], "no publication from any replay");
  }));

test("C10 Variant B: cached retry of create, delete and view-changing updates rebroadcasts no historical publication", () => withHost(async (host) => {
  host.worldStore.createEntity(cubeInput("mover", 20));
  const observer = await connectedPeer(host);
  await joinCollect(observer, near);
  const actor = await connectedPeer(host);
  await joinCollect(actor, {});

  const requests = [
    createMessage("r-create", "entity:r", 0), // entity.created
    setTransformMessage("r-enter", "mover", 1, 5), // view.entity.enter
    setTransformMessage("r-update", "mover", 2, 6), // component.updated
    setTransformMessage("r-leave", "mover", 3, 20), // view.entity.leave
    deleteMessage("r-delete", "entity:r"), // entity.deleted
  ];
  const acks = [];
  for (const request of requests) acks.push(await actor.request(request));
  assert.ok(acks.every((ack) => ack.type === "ack"));
  const original = await observer.fence(host);
  assert.deepEqual(original.map((m) => m.type), ["entity.created", "view.entity.enter", "component.updated", "view.entity.leave", "entity.deleted"]);

  const seq = host.worldStore.getRealmSeq();
  for (const [index, request] of requests.entries()) {
    assert.deepEqual(await actor.request(request), acks[index], request.id);
  }
  assert.equal(host.worldStore.getRealmSeq(), seq);
  assert.deepEqual(await observer.fence(host), [], "no historical publication was rebroadcast");
}));

test("C10 Variant A: two structurally equal frames written back-to-back are one logical operation", async () => {
  // Host mutation processing completes synchronously inside one message dispatch, so there is no observable
  // "admitted but not yet terminal" window for a durable mutation: the second frame is always processed after the
  // first has reached its terminal state, and Variant A reduces to the cached-terminal path. The burst below still
  // proves the observable contract: one execution, one sequence advance, one publication, identical results.
  await withHost(async (host) => {
    host.worldStore.createEntity(cubeInput("E"));
    const observer = await connectedPeer(host);
    await joinCollect(observer, { entities: ["E"] });
    const peer = await connectedPeer(host);
    await joinCollect(peer, {});
    const seq = host.worldStore.getRealmSeq();

    const original = patchTransformMessage("dup", "E", 1, 3);
    const reordered = {
      body: { patch: { position: [3, 0, 0] }, baseRevision: 1, authorityEpoch: 1, component: "hvtp.transform@1", entityId: "E" },
      realm: P1_REALM_ID, type: "component.patch", id: "dup", hvtp: "0.2",
    };
    peer.send(original);
    peer.send(reordered);
    const [first, second] = await peer.take(2);
    assert.equal(first!.type, "ack");
    assert.deepEqual(second, first, "identical terminal results");
    assert.equal(host.worldStore.getRealmSeq(), seq + 1, "single sequence advance");
    assert.equal(host.worldStore.getEntity("E")!.components["hvtp.transform@1"].revision, 2, "exactly one mutation");
    assert.deepEqual((await observer.fence(host)).map((m) => [m.type, m.seq]), [["component.updated", seq + 1]], "single publication");

    // A conflicting frame with the same id in the same kind of burst is refused without a second mutation.
    peer.send(patchTransformMessage("dup2", "E", 2, 4));
    peer.send(patchTransformMessage("dup2", "E", 2, 5));
    const [ok, conflict] = await peer.take(2);
    assert.equal(ok!.type, "ack");
    assert.equal(conflict!.body.code, "request_id_conflict");
    assert.deepEqual(host.worldStore.getEntity("E")!.components["hvtp.transform@1"].state.position, [4, 0, 0]);
    assert.equal(host.worldStore.getRealmSeq(), seq + 2);
  });
});

// ------------------------------------------------------------------------- C20 / C24 over a real restart

test("C20/C24 a real host restart over the same SQLite file invalidates sessions but keeps tombstones and durable entities", async () => {
  const dir = mkdtempSync(joinPath(tmpdir(), "hvtp-restart-"));
  const databasePath = joinPath(dir, "world.sqlite");
  let first: ReferenceHost | null = null;
  let second: ReferenceHost | null = null;
  try {
    first = await createReferenceHost({ databasePath, clock: fastClock() });
    const a = await connectedPeer(first);
    const aJoin = await joinCollect(a, { entities: ["E", "F"], ...near });
    const b = await connectedPeer(first);
    const bJoin = await joinCollect(b, { entities: ["E", "F"], ...near });
    const creator = await connectedPeer(first);
    await joinCollect(creator, {});

    assert.equal((await creator.request(createMessage("create-E", "E", 0))).type, "ack");
    assert.equal((await creator.request(createMessage("create-F", "F", 1))).type, "ack");
    await first.realmCoordinator.drain();
    await a.fence(); await b.fence();
    // C24 step 1: A's view evicts E; B keeps it.
    a.send(subscriptionMessage("a-evict", { entities: ["F"] }));
    assert.deepEqual((await a.take(2)).map((m) => m.type), ["subscription.applied", "view.entity.leave"]);
    // C24 step 2: B deletes E globally. B alone hears entity.deleted; A hears nothing.
    const deleteE = deleteMessage("delete-E", "E");
    const deletedAck = await b.request(deleteE);
    assert.equal(deletedAck.type, "ack");
    assert.deepEqual((await b.fence(first)).map((m) => m.type), ["entity.deleted"]);
    assert.deepEqual(await a.fence(first), []);
    assert.equal(first.worldStore.isTombstoned("E"), true);
    const oldEpoch = first.realmEpoch;
    const oldParticipants = [aJoin[0]!.body.participantId, bJoin[0]!.body.participantId];
    const oldPresence = [aJoin[0]!.body.presenceEntityId, bJoin[0]!.body.presenceEntityId];

    await first.close();
    first = null;
    // Old connections terminate.
    assert.equal(await a.closed, 1001);
    assert.equal(await b.closed, 1001);
    assert.equal(await creator.closed, 1001);

    second = await createReferenceHost({ databasePath, clock: fastClock() });
    assert.notEqual(second.realmEpoch, oldEpoch, "new realmEpoch");
    assert.equal(second.worldStore.getRealmSeq(), 0);
    assert.equal(second.worldStore.isTombstoned("E"), true, "tombstone survives restart");
    assert.notEqual(second.worldStore.getEntity("F"), null, "durable entity survives restart");

    // Old session state is not valid state: fresh participants and presence entities, no private presence registered.
    assert.equal(second.realmCoordinator.privatePresenceCount, 0);
    assert.equal(second.realmCoordinator.subscriberCount, 0);
    const watcher = await connectedPeer(second);
    const watcherJoin = await joinCollect(watcher, { entities: ["E", "F"], ...near });
    assert.equal(watcherJoin[0]!.realmEpoch, second.realmEpoch);
    assert.ok(!oldParticipants.includes(watcherJoin[0]!.body.participantId));
    assert.ok(!oldPresence.includes(watcherJoin[0]!.body.presenceEntityId));
    // A later subscription that would include the deleted entity does not resurrect it.
    assert.deepEqual(snapshotSharedIds(watcherJoin), ["F"]);
    watcher.send(subscriptionMessage("watch-again", { entities: ["E", "F"], spatial: { center: [0, 0, 0], radius: 500 } }));
    const applied = await watcher.next();
    assert.equal(applied.type, "subscription.applied");
    assert.deepEqual(await watcher.fence(second), [], "no enter for the tombstoned E");

    const actor = await connectedPeer(second);
    await joinCollect(actor, {});
    // A tombstoned id is not reusable after restart; the old session's request-dedup cache is not consulted, so the
    // very request ids used before the restart are processed afresh.
    const recreate = await actor.request(createMessage("create-E", "E", 0));
    assert.equal(recreate.body.code, "entity_exists");
    assert.equal(second.worldStore.getRealmSeq(), 0);
    const again = await actor.request(deleteE);
    assert.equal(again.body.code, "entity_not_found", "deleting a tombstoned entity again");
    assert.equal(second.worldStore.getRealmSeq(), 0, "no sequence advance");
    // A cached retry in the new session is the same terminal error and rebroadcasts nothing.
    assert.deepEqual(await actor.request(deleteE), again);
    assert.deepEqual(await watcher.fence(second), [], "historical deletion is not rebroadcast");
    assert.equal(second.worldStore.getRealmSeq(), 0);
  } finally {
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
