import assert from "node:assert/strict";
import test from "node:test";
import { P1ConnectionError, P1OutcomeUncertainError, P1RequestError, type P1SubscriptionResult } from "./index.js";
import {
  ack, applied, begin, created, cube, deleted, end, enter, EPOCH, harness, hostError, leave, live, META,
  negotiate, presence, PRESENCE, publication, S0, snapshotEntity, transformValue, updated, welcome, joined,
  type Harness, type SnapshotMeta,
} from "./test-support.js";

const ids = (h: Harness) => [...h.client.entities.keys()].sort();
const lastSent = (h: Harness) => h.socket.sent.at(-1)!;

// ---------------------------------------------------------------------------------------------------------------
// Negotiation and atomic snapshot activation (C30)
// ---------------------------------------------------------------------------------------------------------------

test("negotiates HVTP 0.2 as a human participant, joins, and activates the snapshot atomically at end", async () => {
  const h = harness({ subscription: { spatial: { center: [0, 0, 0], radius: 100 } } });
  const ready = h.client.connect();
  assert.equal(h.client.phase, "connecting");
  h.socket.open();
  assert.equal(h.client.phase, "negotiating");
  const hello = h.socket.sent[0]!;
  assert.equal(hello.type, "session.hello");
  assert.deepEqual(hello.body.versions, ["0.2"]);
  assert.equal(hello.body.participant.kind, "human");
  assert.deepEqual(hello.body.capabilities.components, ["hvtp.transform@1", "hvtp.renderable@1", "hvtp.material@1", "hvtp.presence@1"]);

  h.socket.deliver(welcome());
  assert.equal(h.client.assetBaseUri, "http://127.0.0.1:8787/assets/p1/");
  const join = lastSent(h);
  assert.equal(join.type, "realm.join");
  assert.deepEqual(join.body, { realm: "urn:hvtp:realm:prototype-world", subscription: { spatial: { center: [0, 0, 0], radius: 100 } } });

  h.socket.deliver(joined());
  h.socket.deliver(begin());
  h.socket.deliver(snapshotEntity(cube("entity:a")));
  h.socket.deliver(snapshotEntity(presence()));
  // Active view stays untouched while records stream in.
  assert.equal(h.client.phase, "snapshot");
  assert.equal(h.client.entities.size, 0);
  assert.equal(h.events.filter((e) => e.type === "view.reset" || e.type === "entity.upsert").length, 0);

  h.socket.deliver(end(2));
  await ready;
  assert.equal(h.client.phase, "live");
  assert.deepEqual(ids(h), ["entity:a", PRESENCE]);
  assert.equal(h.client.realmEpoch, EPOCH);
  assert.equal(h.client.subscriptionId, S0);
  assert.equal(h.client.presenceEntityId, PRESENCE);
  const resets = h.events.filter((e) => e.type === "view.reset");
  assert.equal(resets.length, 1);
  // Own presence is retained as structured canonical state.
  assert.equal((h.client.entities.get(PRESENCE)!.components as any)["hvtp.presence@1"].state.participantId, "participant:me");
});

test("an agent participant negotiates with kind agent", async () => {
  const h = harness({ participantKind: "agent" });
  void h.client.connect().catch(() => {});
  h.socket.open();
  assert.equal(h.socket.sent[0]!.body.participant.kind, "agent");
  h.client.disconnect();
});

async function assertRejectedSnapshot(h: Harness, ready: Promise<void>, pattern: RegExp): Promise<void> {
  await assert.rejects(ready, (error: unknown) => error instanceof P1ConnectionError && pattern.test(String((error.cause as Error)?.message)));
  assert.equal(h.client.phase, "disconnected");
  assert.equal(h.client.entities.size, 0);
  assert.equal(h.socket.closed?.code, 4002);
  assert.equal(h.events.some((e) => e.type === "view.reset" && e.reason === "snapshot"), false);
  assert.equal(h.events.some((e) => e.type === "entity.upsert"), false);
  assert.equal(h.client.realmEpoch, null);
  assert.equal(h.client.subscriptionId, null);
}

const wrong = (patch: Partial<SnapshotMeta>): SnapshotMeta => ({ ...META, ...patch });

test("C30: a mismatched snapshotId discards the snapshot without partial activation", async () => {
  const h = harness();
  const ready = negotiate(h);
  h.socket.deliver(begin());
  h.socket.deliver(snapshotEntity(cube("entity:a")));
  h.socket.deliver(snapshotEntity(presence(), wrong({ snapshotId: "snapshot:other" })));
  await assertRejectedSnapshot(h, ready, /snapshotId/);
});

test("C30: a mismatched snapshotBaseSeq discards the snapshot", async () => {
  const h = harness();
  const ready = negotiate(h);
  h.socket.deliver(begin());
  h.socket.deliver(snapshotEntity(cube("entity:a")));
  h.socket.deliver(snapshotEntity(presence()));
  h.socket.deliver(end(2, wrong({ snapshotBaseSeq: 11 })));
  await assertRejectedSnapshot(h, ready, /snapshotBaseSeq/);
});

test("C30: a mismatched realmEpoch discards the snapshot", async () => {
  const h = harness();
  const ready = negotiate(h);
  h.socket.deliver(begin(wrong({ realmEpoch: "epoch:other" })));
  await assertRejectedSnapshot(h, ready, /realmEpoch/);
});

test("C30: a mismatched subscriptionId at begin or end discards the snapshot", async () => {
  for (const at of ["begin", "end"] as const) {
    const h = harness();
    const ready = negotiate(h);
    h.socket.deliver(begin(at === "begin" ? wrong({ subscriptionId: "subscription:x" }) : META));
    h.socket.deliver(snapshotEntity(presence()));
    h.socket.deliver(end(1, at === "end" ? wrong({ subscriptionId: "subscription:x" }) : META));
    await assertRejectedSnapshot(h, ready, /subscriptionId/);
  }
});

test("C30: an entityCount that disagrees with the records discards the snapshot", async () => {
  const h = harness();
  const ready = negotiate(h);
  h.socket.deliver(begin());
  h.socket.deliver(snapshotEntity(cube("entity:a")));
  h.socket.deliver(snapshotEntity(presence()));
  h.socket.deliver(end(3));
  await assertRejectedSnapshot(h, ready, /entityCount/);
});

test("a duplicated entity ID within one snapshot is rejected", async () => {
  const h = harness();
  const ready = negotiate(h);
  h.socket.deliver(begin());
  h.socket.deliver(snapshotEntity(cube("entity:a")));
  h.socket.deliver(snapshotEntity(cube("entity:a", 3)));
  await assertRejectedSnapshot(h, ready, /Duplicate entity/);
});

test("snapshot records before begin, structurally invalid entities, or foreign presence are rejected", async () => {
  const cases: Array<[unknown[], RegExp]> = [
    [[snapshotEntity(presence())], /before realm.snapshot.begin/],
    [[begin(), snapshotEntity({ id: "entity:bad", components: {} })], /closed P1 shape/],
    [[begin(), snapshotEntity(presence("entity:presence-other", "participant:other"))], /presence entity that is not/],
    [[begin(), end(0)], /entityCount|presence/],
  ];
  for (const [messages, pattern] of cases) {
    const h = harness();
    const ready = negotiate(h);
    for (const message of messages) h.socket.deliver(message);
    await assertRejectedSnapshot(h, ready, pattern);
  }
});

test("a partial snapshot never activates when the connection fails before end", async () => {
  const h = harness();
  const ready = negotiate(h);
  h.socket.deliver(begin());
  h.socket.deliver(snapshotEntity(cube("entity:a")));
  h.socket.hostClose(1006);
  await assert.rejects(ready, P1ConnectionError);
  assert.equal(h.client.phase, "disconnected");
  assert.equal(h.client.entities.size, 0);
  assert.equal(h.events.some((e) => e.type === "entity.upsert" || (e.type === "view.reset" && e.reason === "snapshot")), false);
});

test("a live publication interleaved into an incomplete snapshot is an order violation, not a partial update", async () => {
  const h = harness();
  const ready = negotiate(h);
  h.socket.deliver(begin());
  h.socket.deliver(snapshotEntity(cube("entity:a")));
  h.socket.deliver(created(cube("entity:b"), 11));
  await assertRejectedSnapshot(h, ready, /incomplete/);
});

test("after a rejected snapshot the next connect is a fresh session with a fresh snapshot", async () => {
  const h = harness();
  const ready = negotiate(h);
  h.socket.deliver(begin());
  h.socket.deliver(end(5));
  await assert.rejects(ready);
  await live(h, [cube("entity:a")]);
  assert.equal(h.sockets.length, 2);
  assert.deepEqual(ids(h), ["entity:a", PRESENCE]);
});

test("a rejected realm.join rejects connect with the host error and leaves no session", async () => {
  const h = harness();
  const ready = h.client.connect();
  h.socket.open();
  h.socket.deliver(welcome());
  const joinId = lastSent(h).id as string;
  h.socket.deliver({ hvtp: "0.2", id: "e1", type: "error", body: { ref: joinId, code: "resource_limit", message: "too broad" } });
  await assert.rejects(ready, (error: unknown) => error instanceof P1RequestError && error.code === "resource_limit");
  assert.equal(h.client.phase, "disconnected");
  assert.equal(h.client.participantId, null);
});

// ---------------------------------------------------------------------------------------------------------------
// Canonical active-view lifecycle
// ---------------------------------------------------------------------------------------------------------------

test("entity.created adds complete state without a separate view.entity.enter", async () => {
  const h = harness();
  await live(h);
  h.socket.deliver(created(cube("entity:new", 4), 11));
  assert.deepEqual(ids(h), ["entity:new", PRESENCE]);
  assert.deepEqual(h.client.entities.get("entity:new"), cube("entity:new", 4));
  assert.deepEqual(h.events.filter((e) => e.type === "entity.upsert").map((e) => (e as any).cause), ["created"]);
});

test("component.updated replaces the complete component envelope; the request patch is never applied locally", async () => {
  const h = harness();
  await live(h, [cube("entity:a", 0, {}, [1, 1, 1, 1])]);
  const before = h.client.entities.get("entity:a");
  const pending = h.client.patchComponent("entity:a", "hvtp.transform@1", { position: [2, 0.5, 0] });
  const request = lastSent(h);
  assert.equal(request.type, "component.patch");
  assert.deepEqual(request.body, { entityId: "entity:a", component: "hvtp.transform@1", authorityEpoch: 1, baseRevision: 1, patch: { position: [2, 0.5, 0] } });
  // No optimistic mutation of canonical state.
  assert.equal(h.client.entities.get("entity:a"), before);

  h.socket.deliver(ack(request.id, 11, "entity:a", { component: "hvtp.transform@1", revision: 2, authorityEpoch: 1 }));
  assert.equal((await pending).revision, 2);
  // ACK alone is not canonical subscriber state.
  assert.equal(h.client.entities.get("entity:a"), before);

  h.socket.deliver(updated("entity:a", "hvtp.transform@1", transformValue(7, 2), 11));
  const after = h.client.entities.get("entity:a") as ReturnType<typeof cube>;
  // Canonical value comes from the publication (x = 7), not from the request patch (x = 2).
  assert.deepEqual(after.components["hvtp.transform@1"], transformValue(7, 2));
  assert.deepEqual(after.components["hvtp.material@1"], cube("entity:a").components["hvtp.material@1"]);
  assert.ok(Object.isFrozen(after) && Object.isFrozen((after.components["hvtp.transform@1"].state as any).position));
});

test("view.entity.leave evicts without a tombstone and view.entity.enter rematerializes from the message alone", async () => {
  const h = harness();
  await live(h, [cube("entity:a", 0, { material: 1 }, [1, 0, 0, 1])]);
  h.socket.deliver(leave("entity:a", 11));
  assert.deepEqual(ids(h), [PRESENCE]);
  // Re-entry carries newer complete state; nothing from the earlier record is merged in.
  h.socket.deliver(enter(cube("entity:a", 3, { transform: 4, material: 2 }, [0, 0, 1, 1]), 14));
  assert.deepEqual(h.client.entities.get("entity:a"), cube("entity:a", 3, { transform: 4, material: 2 }, [0, 0, 1, 1]));
  // An enter for an entity still in view replaces the stale local representation.
  h.socket.deliver(enter(cube("entity:a", 5, { transform: 5, material: 2 }), 15));
  assert.equal((h.client.entities.get("entity:a") as any).components["hvtp.transform@1"].revision, 5);
  assert.deepEqual(h.events.filter((e) => e.type === "entity.remove" || e.type === "entity.upsert").map((e) => (e as any).cause),
    ["leave", "enter", "enter"]);
});

test("entity.deleted removes the entity from the active view", async () => {
  const h = harness();
  await live(h, [cube("entity:a"), cube("entity:b")]);
  h.socket.deliver(deleted("entity:a", 12));
  assert.deepEqual(ids(h), ["entity:b", PRESENCE]);
  assert.deepEqual(h.events.filter((e) => e.type === "entity.remove").map((e) => [(e as any).cause, (e as any).entityId]), [["deleted", "entity:a"]]);
});

test("publications that contradict the active view are protocol violations", async () => {
  const cases: Array<[unknown, RegExp]> = [
    [updated("entity:missing", "hvtp.transform@1", transformValue(1, 2), 11), /not in the active view/],
    [updated("entity:a", "hvtp.transform@1", transformValue(1, 1), 11), /does not advance/],
    [leave(PRESENCE, 11), /presence/],
    [created(cube("entity:a"), 11), /already in view/],
    [created(presence("entity:presence-x", "participant:x"), 11), /presence/],
    [publication("component.updated", 11, S0, { entityId: "entity:a", component: "hvtp.transform@1", value: transformValue(1, 2) }, "epoch:stale"), /realmEpoch/],
  ];
  for (const [message, pattern] of cases) {
    const h = harness();
    await live(h, [cube("entity:a")]);
    h.socket.deliver(message);
    const violation = h.events.find((e) => e.type === "protocol.violation");
    assert.ok(violation && pattern.test((violation as any).error.message), `expected ${pattern}`);
    assert.equal(h.client.phase, "disconnected");
    assert.equal(h.client.entities.size, 0);
    assert.equal(h.socket.closed?.code, 4002);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Sequence semantics (C09, C28)
// ---------------------------------------------------------------------------------------------------------------

test("sparse canonical sequences are accepted and never treated as loss", async () => {
  const h = harness();
  await live(h, [cube("entity:a")]);
  h.socket.deliver(updated("entity:a", "hvtp.transform@1", transformValue(1, 2), 100));
  h.socket.deliver(updated("entity:a", "hvtp.transform@1", transformValue(2, 3), 103));
  h.socket.deliver(created(cube("entity:b"), 9_000));
  assert.equal(h.client.phase, "live");
  assert.equal((h.client.entities.get("entity:a") as any).components["hvtp.transform@1"].revision, 3);
  assert.ok(h.client.entities.has("entity:b"));
});

test("legitimate messages sharing one realm seq are all applied, not deduplicated", async () => {
  const h = harness();
  await live(h, [cube("entity:a")]);
  const pending = h.client.setSubscription({ entities: ["entity:b", "entity:c"] });
  const ref = lastSent(h).id as string;
  h.socket.deliver(applied(ref, S0, "subscription:s1", 20, { entities: ["entity:b", "entity:c"] }));
  h.socket.deliver(leave("entity:a", 20, "subscription:s1", "subscription"));
  h.socket.deliver(enter(cube("entity:b"), 20, "subscription:s1", "subscription"));
  h.socket.deliver(enter(cube("entity:c"), 20, "subscription:s1", "subscription"));
  assert.equal((await pending).activated, true);
  assert.deepEqual(ids(h), ["entity:b", "entity:c", PRESENCE]);
});

// ---------------------------------------------------------------------------------------------------------------
// Subscription generations (C28)
// ---------------------------------------------------------------------------------------------------------------

test("C28: a delayed publication tagged with an old generation is ignored after the new one is active", async () => {
  const h = harness();
  await live(h, [cube("entity:e")]);
  // S1 excludes E, S2 includes E again.
  const r1 = h.client.setSubscription({});
  const ref1 = lastSent(h).id as string;
  const r2 = h.client.setSubscription({ entities: ["entity:e"] });
  const ref2 = lastSent(h).id as string;
  h.socket.deliver(applied(ref1, S0, "subscription:s1", 20));
  h.socket.deliver(leave("entity:e", 20, "subscription:s1", "subscription"));
  assert.equal((await r1).activated, true);
  h.socket.deliver(applied(ref2, "subscription:s1", "subscription:s2", 20, { entities: ["entity:e"] }));
  h.socket.deliver(enter(cube("entity:e", 0, { transform: 2 }), 20, "subscription:s2", "subscription"));
  assert.equal((await r2).activated, true);
  assert.equal(h.client.subscriptionId, "subscription:s2");
  const before = h.client.entities.get("entity:e");

  // Deliberately delayed, otherwise valid, S1 publications.
  h.socket.deliver(leave("entity:e", 21, "subscription:s1"));
  h.socket.deliver(updated("entity:e", "hvtp.transform@1", transformValue(9, 3), 21, "subscription:s1"));
  h.socket.deliver(publication("component.updated", 21, S0, { entityId: "entity:e", component: "hvtp.transform@1", value: transformValue(9, 3) }));

  assert.equal(h.client.phase, "live");
  assert.equal(h.client.subscriptionId, "subscription:s2");
  assert.equal(h.client.entities.get("entity:e"), before);
  assert.equal(h.events.filter((e) => e.type === "publication.stale").length, 3);

  // The active generation still applies normally.
  h.socket.deliver(updated("entity:e", "hvtp.transform@1", transformValue(4, 3), 22, "subscription:s2"));
  assert.equal((h.client.entities.get("entity:e") as any).components["hvtp.transform@1"].revision, 3);
});

test("C28: a cached older subscription.applied resolves its request but never reactivates the old generation", async () => {
  const h = harness();
  await live(h, [cube("entity:e")]);
  const r1 = h.client.setSubscription({});
  const ref1 = lastSent(h).id as string;
  h.socket.deliver(applied(ref1, S0, "subscription:s1", 20));
  h.socket.deliver(leave("entity:e", 20, "subscription:s1", "subscription"));
  await r1;
  const r2 = h.client.setSubscription({ entities: ["entity:e"] });
  const ref2 = lastSent(h).id as string;
  h.socket.deliver(applied(ref2, "subscription:s1", "subscription:s2", 21, { entities: ["entity:e"] }));
  h.socket.deliver(enter(cube("entity:e"), 21, "subscription:s2", "subscription"));
  await r2;

  // A third request whose terminal response turns out to be a historical S0 → S1 transition (e.g. a cached
  // retry response). It is terminal request information only.
  const r3 = h.client.setSubscription({});
  const ref3 = lastSent(h).id as string;
  h.socket.deliver(applied(ref3, S0, "subscription:s1", 20));
  const result: P1SubscriptionResult = await r3;
  assert.equal(result.activated, false);
  assert.equal(result.body.subscriptionId, "subscription:s1");
  assert.equal(h.client.subscriptionId, "subscription:s2");
  assert.deepEqual(h.client.effectiveSubscription, { entities: ["entity:e"] });
  assert.deepEqual(ids(h), ["entity:e", PRESENCE]);

  // An unsolicited duplicate of the same historical response is also inert.
  h.socket.deliver(applied(ref1, S0, "subscription:s1", 20));
  assert.equal(h.client.subscriptionId, "subscription:s2");
  // S1-tagged traffic stays stale.
  h.socket.deliver(leave("entity:e", 22, "subscription:s1"));
  assert.deepEqual(ids(h), ["entity:e", PRESENCE]);
});

const activations = (h: Harness) => h.events.filter((e) => e.type === "subscription.activated");
const staleCount = (h: Harness) => h.events.filter((e) => e.type === "publication.stale").length;

test("B1: an unsolicited subscription.applied with an unknown ref is inert and never activates a generation", async () => {
  const h = harness();
  await live(h, [cube("entity:a")]);
  const activeSelector = h.client.effectiveSubscription;
  const viewBefore = h.client.entities;

  // Syntactically valid, formally a transition from the active generation, but it answers no request.
  h.socket.deliver(applied("req:never-sent", S0, "subscription:rogue", 20, { entities: ["entity:zzz"] }));
  assert.equal(h.client.phase, "live");
  assert.equal(h.socket.closed, null, "unmatched terminal noise must not close the connection");
  assert.equal(h.client.subscriptionId, S0);
  assert.equal(h.client.effectiveSubscription, activeSelector);
  assert.equal(h.client.entities, viewBefore);
  assert.deepEqual(ids(h), ["entity:a", PRESENCE]);
  assert.equal(activations(h).length, 0);
  assert.equal(h.events.some((e) => e.type === "protocol.violation"), false);

  // The real generation keeps applying; the rogue generation's traffic is stale.
  h.socket.deliver(created(cube("entity:b", 2), 21));
  assert.deepEqual(ids(h), ["entity:a", "entity:b", PRESENCE]);
  assert.equal(staleCount(h), 0);
  h.socket.deliver(created(cube("entity:c", 3), 22, "subscription:rogue"));
  assert.equal(h.client.entities.has("entity:c"), false);
  assert.equal(staleCount(h), 1);
  assert.equal(h.client.subscriptionId, S0);
});

test("B1: an unmatched subscription.applied neither settles nor disturbs an unrelated pending subscription.set", async () => {
  const h = harness();
  await live(h, [cube("entity:a")]);
  const pending = h.client.setSubscription({ entities: ["entity:a"] });
  const ref = lastSent(h).id as string;

  h.socket.deliver(applied("req:other", S0, "subscription:rogue", 20));
  assert.equal(h.client.subscriptionId, S0);
  assert.equal(h.client.pendingRequestCount, 1);
  assert.equal(activations(h).length, 0);

  // A later publication of the real, still-active generation applies; the request settles from its own response.
  h.socket.deliver(created(cube("entity:b", 2), 21));
  assert.ok(h.client.entities.has("entity:b"));
  h.socket.deliver(applied(ref, S0, "subscription:s1", 22, { entities: ["entity:a"] }));
  const result = await pending;
  assert.equal(result.activated, true);
  assert.equal(h.client.subscriptionId, "subscription:s1");
  assert.equal(activations(h).length, 1);
});

test("B1: a duplicate terminal response for an already-settled request is inert", async () => {
  const h = harness();
  await live(h, [cube("entity:a")]);
  const pending = h.client.setSubscription({ entities: ["entity:a"] });
  const ref = lastSent(h).id as string;
  h.socket.deliver(applied(ref, S0, "subscription:s1", 20, { entities: ["entity:a"] }));
  assert.equal((await pending).activated, true);

  h.socket.deliver(applied(ref, S0, "subscription:s1", 20, { entities: ["entity:a"] }));
  // Even a duplicate that formally continues from the (new) active generation must not activate again.
  h.socket.deliver(applied(ref, "subscription:s1", "subscription:s2", 21, {}));
  assert.equal(h.client.phase, "live");
  assert.equal(h.client.subscriptionId, "subscription:s1");
  assert.deepEqual(h.client.effectiveSubscription, { entities: ["entity:a"] });
  assert.equal(activations(h).length, 1);
});

test("B1: a matching subscription.set response whose previousSubscriptionId is superseded settles but never reactivates", async () => {
  const h = harness();
  await live(h, [cube("entity:e")]);
  const r1 = h.client.setSubscription({});
  const ref1 = lastSent(h).id as string;
  h.socket.deliver(applied(ref1, S0, "subscription:s1", 20));
  h.socket.deliver(leave("entity:e", 20, "subscription:s1", "subscription"));
  await r1;
  const r2 = h.client.setSubscription({ entities: ["entity:e"] });
  const ref2 = lastSent(h).id as string;
  h.socket.deliver(applied(ref2, "subscription:s1", "subscription:s2", 21, { entities: ["entity:e"] }));
  h.socket.deliver(enter(cube("entity:e"), 21, "subscription:s2", "subscription"));
  await r2;
  assert.equal(activations(h).length, 2);

  // Cached responses for older transitions reach still-pending requests: S1 → S2 and S0 → S1 are both history.
  for (const [previous, next] of [["subscription:s1", "subscription:s3"], [S0, "subscription:s1"]] as const) {
    const late = h.client.setSubscription({});
    const lateRef = lastSent(h).id as string;
    h.socket.deliver(applied(lateRef, previous, next, 22));
    const result = await late;
    assert.equal(result.activated, false);
    assert.equal(result.body.subscriptionId, next);
    assert.equal(h.client.subscriptionId, "subscription:s2");
    assert.deepEqual(h.client.effectiveSubscription, { entities: ["entity:e"] });
    assert.deepEqual(ids(h), ["entity:e", PRESENCE]);
  }
  assert.equal(activations(h).length, 2);
  // S1 traffic stays stale after the cached S1 response; S2 traffic keeps applying.
  h.socket.deliver(leave("entity:e", 23, "subscription:s1"));
  assert.deepEqual(ids(h), ["entity:e", PRESENCE]);
  assert.equal(staleCount(h), 1);
  h.socket.deliver(updated("entity:e", "hvtp.transform@1", transformValue(5, 2), 24, "subscription:s2"));
  assert.equal((h.client.entities.get("entity:e") as any).components["hvtp.transform@1"].revision, 2);
});

test("B1: a subscription.applied whose ref matches a pending non-subscription request is a host protocol violation and never activates", async () => {
  for (const start of [
    (h: Harness) => h.client.createEntity({ id: "entity:new", transform: { position: [1, 0.5, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      material: { baseColor: [1, 1, 1, 1] } }),
    (h: Harness) => h.client.deleteEntity("entity:a"),
    (h: Harness) => h.client.patchComponent("entity:a", "hvtp.transform@1", { position: [2, 0.5, 0] }),
  ]) {
    const h = harness();
    await live(h, [cube("entity:a")]);
    const request = start(h);
    const outcome = assert.rejects(request, P1OutcomeUncertainError);
    h.socket.deliver(applied(lastSent(h).id as string, S0, "subscription:rogue", 20));
    const violation = h.events.find((e) => e.type === "protocol.violation");
    assert.ok(violation && /subscription\.applied received for a .* request/.test((violation as any).error.message));
    assert.equal(activations(h).length, 0);
    assert.equal(h.client.phase, "disconnected");
    assert.equal(h.socket.closed?.code, 4002);
    // The session is torn down like any other contradictory host frame: nothing of the rogue generation survives.
    assert.equal(h.client.subscriptionId, null);
    assert.equal(h.client.entities.size, 0);
    await outcome;
  }
});

test("B1: positive control — a matching pending subscription.set from the active generation activates exactly once", async () => {
  const h = harness();
  await live(h, [cube("entity:a")]);
  const pending = h.client.setSubscription({ entities: ["entity:a"] });
  const ref = lastSent(h).id as string;
  assert.equal(h.client.pendingRequestCount, 1);
  h.socket.deliver(applied(ref, S0, "subscription:s1", 20, { entities: ["entity:a"] }));
  const result = await pending;
  assert.equal(result.activated, true);
  assert.equal(h.client.pendingRequestCount, 0);
  assert.equal(h.client.subscriptionId, "subscription:s1");
  assert.deepEqual(h.client.effectiveSubscription, { entities: ["entity:a"] });
  assert.deepEqual(activations(h).map((e) => e.type === "subscription.activated" && [e.previousSubscriptionId, e.subscriptionId]),
    [[S0, "subscription:s1"]]);
  // The previous generation is now stale.
  h.socket.deliver(created(cube("entity:b"), 21, S0));
  assert.equal(h.client.entities.has("entity:b"), false);
});

// ---------------------------------------------------------------------------------------------------------------
// Requests, terminal results, and reconnect uncertainty (C12, C13)
// ---------------------------------------------------------------------------------------------------------------

test("requests use unique IDs, real P1 shapes, and resolve from terminal ack/error only", async () => {
  const h = harness();
  await live(h, [cube("entity:a")]);
  const create = h.client.createEntity({ id: "entity:new", transform: { position: [1, 0.5, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    material: { baseColor: [0.25, 0.5, 0.75, 1] } });
  const createRequest = lastSent(h);
  assert.deepEqual(createRequest.body.entity.components["hvtp.renderable@1"],
    { state: { asset: { uri: "unit-cube.gltf", mediaType: "model/gltf+json" }, node: "UnitCube", visible: true } });
  const set = h.client.setComponent("entity:a", "hvtp.material@1", { baseColor: [0, 1, 0, 1] });
  const setRequest = lastSent(h);
  const remove = h.client.deleteEntity("entity:a");
  const deleteRequest = lastSent(h);
  assert.equal(new Set([createRequest.id, setRequest.id, deleteRequest.id]).size, 3);
  assert.equal(setRequest.body.baseRevision, 1);

  // A subscriber publication for the created entity does not settle the request.
  h.socket.deliver(created(cube("entity:new", 1), 11));
  assert.equal(h.client.pendingRequestCount, 3);
  h.socket.deliver(ack(createRequest.id, 11, "entity:new"));
  assert.deepEqual(await create, { ref: createRequest.id, status: "committed", seq: 11, entityId: "entity:new" });
  h.socket.deliver(hostError(setRequest.id, "revision_mismatch"));
  await assert.rejects(set, (error: unknown) => error instanceof P1RequestError && error.code === "revision_mismatch");
  h.socket.deliver(ack(deleteRequest.id, 12, "entity:a"));
  await remove;
  assert.equal(h.client.pendingRequestCount, 0);
});

test("C13: a move that evicts the entity from the requester's view still resolves from the terminal ack", async () => {
  const h = harness();
  await live(h, [cube("entity:a")]);
  const move = h.client.patchComponent("entity:a", "hvtp.transform@1", { position: [400, 0.5, 0] });
  const ref = lastSent(h).id as string;
  h.socket.deliver(leave("entity:a", 11));
  h.socket.deliver(ack(ref, 11, "entity:a", { component: "hvtp.transform@1", revision: 2, authorityEpoch: 1 }));
  assert.equal((await move).revision, 2);
  assert.equal(h.client.entities.has("entity:a"), false);
});

test("requests are refused locally unless LIVE, and need a base revision for entities outside the view", async () => {
  const h = harness();
  await assert.rejects(h.client.deleteEntity("entity:a"), /LIVE/);
  await live(h);
  await assert.rejects(h.client.patchComponent("entity:unseen", "hvtp.material@1", { baseColor: [1, 0, 0, 1] }), /baseRevision/);
  const explicit = h.client.patchComponent("entity:unseen", "hvtp.material@1", { baseColor: [1, 0, 0, 1] }, { baseRevision: 7, authorityEpoch: 1 });
  assert.equal(lastSent(h).body.baseRevision, 7);
  h.socket.deliver(hostError(lastSent(h).id, "entity_not_found"));
  await assert.rejects(explicit, P1RequestError);
});

test("C12: disconnect invalidates the session, marks sent mutations uncertain, and never replays them", async () => {
  const h = harness();
  await live(h, [cube("entity:a")]);
  const move = h.client.patchComponent("entity:a", "hvtp.transform@1", { position: [3, 0.5, 0] });
  const sub = h.client.setSubscription({});
  const moveId = h.socket.sent.at(-2)!.id as string;
  const firstSocket = h.socket;

  firstSocket.hostClose(1006);
  await assert.rejects(move, (error: unknown) => error instanceof P1OutcomeUncertainError && error.requestId === moveId);
  await assert.rejects(sub, P1OutcomeUncertainError);
  assert.equal(h.client.phase, "disconnected");
  assert.equal(h.client.entities.size, 0);
  for (const value of [h.client.participantId, h.client.realmEpoch, h.client.subscriptionId, h.client.presenceEntityId, h.client.assetBaseUri]) {
    assert.equal(value, null);
  }
  const reset = h.events.filter((e) => e.type === "view.reset").at(-1)!;
  assert.deepEqual([reset.type === "view.reset" && reset.reason, reset.type === "view.reset" && reset.entities.size], ["disconnect", 0]);
  const closed = h.events.find((e) => e.type === "closed");
  assert.deepEqual(closed?.type === "closed" && closed.uncertainRequestIds.length, 2);
  // Late frames from the dead socket are ignored.
  firstSocket.deliver(ack(moveId, 11, "entity:a", { component: "hvtp.transform@1", revision: 2, authorityEpoch: 1 }));

  // Reconnect: new session, fresh snapshot in a new epoch, no replay of the old request ID.
  await live(h, [cube("entity:a", 3, { transform: 2 })], { ...META, realmEpoch: "epoch:test-2", snapshotId: "snapshot:2" });
  assert.deepEqual(h.socket.sent.map((m) => m.type), ["session.hello", "realm.join"]);
  assert.equal(h.socket.sent.some((m) => m.id === moveId), false);
  assert.equal(h.client.realmEpoch, "epoch:test-2");
  // The caller resolves intent from canonical state and, if still needed, issues a NEW request at the current revision.
  void h.client.patchComponent("entity:a", "hvtp.transform@1", { position: [3, 0.5, 0] }).catch(() => {});
  const retry = lastSent(h);
  assert.notEqual(retry.id, moveId);
  assert.equal(retry.body.baseRevision, 2);
  h.client.disconnect();
});

test("an uncorrelated host error is surfaced as an event and the host close then invalidates the view", async () => {
  const h = harness();
  await live(h, [cube("entity:a")]);
  h.socket.deliver(hostError(null, "resource_limit"));
  assert.ok(h.events.some((e) => e.type === "host.error" && e.body.code === "resource_limit"));
  assert.equal(h.client.phase, "live");
  h.socket.hostClose(1008);
  assert.equal(h.client.entities.size, 0);
});

test("canonical records handed to consumers cannot be mutated", async () => {
  const h = harness();
  await live(h, [cube("entity:a")]);
  const entity = h.client.entities.get("entity:a") as any;
  assert.throws(() => { entity.components["hvtp.material@1"].state.baseColor[0] = 0; }, TypeError);
});

test("host frames that are not valid P1 JSON close the connection", async () => {
  for (const frame of ["{not json", JSON.stringify({ hvtp: "0.2", id: "x", type: "realm.mystery", body: {} }),
    '{"hvtp":"0.2","id":"a","id":"b","type":"error","body":{"ref":null,"code":"x","message":"x"}}']) {
    const h = harness();
    await live(h);
    h.socket.deliver(frame);
    assert.equal(h.client.phase, "disconnected");
    assert.equal(h.socket.closed?.code, 4002);
  }
});
