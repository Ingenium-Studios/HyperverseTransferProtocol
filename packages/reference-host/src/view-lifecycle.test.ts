import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { P1_LIMITS, P1_REALM_ID, type P1SharedEntity, type SubscriptionSelector } from "@hvtp/protocol-types";
import { createReferenceHost, type ReferenceHostOptions } from "./server.js";

interface Wire {
  type: string; seq?: number; realmEpoch?: string;
  body: {
    ref?: string | null; code?: string; subscriptionId?: string; previousSubscriptionId?: string;
    baseRealmSeq?: number; snapshotBaseSeq?: number; snapshotId?: string; entityCount?: number;
    presenceEntityId?: string; entityId?: string; entity?: P1SharedEntity; reason?: string;
    value?: { revision: number; state: { position?: number[]; baseColor?: number[] } };
    effectiveSubscription?: SubscriptionSelector;
  };
}
const hello = { hvtp: "0.2", id: "hello", type: "session.hello", body: {
  versions: ["0.2"], client: { name: "test", version: "1" }, participant: { kind: "agent" },
  capabilities: { components: ["hvtp.transform@1", "hvtp.renderable@1", "hvtp.material@1", "hvtp.presence@1"] },
} };
function subscription(id: string, body: SubscriptionSelector) { return { hvtp: "0.2", id, type: "subscription.set", realm: P1_REALM_ID, body }; }
function cube(id: string, x = 0) {
  return { id, transform: { position: [x, 0, 0] as const, rotation: [0, 0, 0, 1] as const, scale: [1, 1, 1] as const },
    renderable: { asset: { uri: "unit-cube.gltf" as const, mediaType: "model/gltf+json" as const }, node: "UnitCube" as const, visible: true },
    material: { baseColor: [1, 1, 1, 1] as const } };
}
function create(id: string, entityId: string, x = 0) {
  const entity = cube(entityId, x);
  return { hvtp: "0.2", id, type: "entity.create", realm: P1_REALM_ID, body: { entity: { id: entityId, components: {
    "hvtp.transform@1": { state: entity.transform }, "hvtp.renderable@1": { state: entity.renderable }, "hvtp.material@1": { state: entity.material },
  } } } };
}
function move(id: string, entityId: string, baseRevision: number, x: number) {
  return { hvtp: "0.2", id, type: "component.set", realm: P1_REALM_ID,
    body: { entityId, component: "hvtp.transform@1", authorityEpoch: 1, baseRevision, state: cube(entityId, x).transform } };
}
function remove(id: string, entityId: string) { return { hvtp: "0.2", id, type: "entity.delete", realm: P1_REALM_ID, body: { entityId } }; }
function gate() {
  let release!: () => void;
  let reached!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { reached = resolve; });
  return { release, entered, wait: async () => { reached(); await blocked; } };
}
class Peer {
  readonly messages: Wire[] = [];
  readonly waiters: Array<(message: Wire) => void> = [];
  readonly closed: Promise<number>;
  constructor(readonly socket: WebSocket) {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Wire;
      const waiter = this.waiters.shift();
      if (waiter) waiter(message); else this.messages.push(message);
    });
    this.closed = new Promise((resolve) => socket.once("close", resolve));
  }
  send(request: unknown) { this.socket.send(JSON.stringify(request)); }
  next(): Promise<Wire> {
    const message = this.messages.shift();
    return message ? Promise.resolve(message) : new Promise((resolve) => this.waiters.push(resolve));
  }
  async take(count: number) { const result: Wire[] = []; for (let i = 0; i < count; i++) result.push(await this.next()); return result; }
  async join(selector: SubscriptionSelector): Promise<Wire[]> {
    this.send({ hvtp: "0.2", id: "join", type: "realm.join", body: { realm: P1_REALM_ID, subscription: selector } });
    const result: Wire[] = [];
    do { result.push(await this.next()); } while (result.at(-1)!.type !== "realm.snapshot.end" && result.at(-1)!.type !== "error");
    return result;
  }
  async request(request: unknown): Promise<Wire> { this.send(request); return await this.next(); }
  // A transport round-trip proves all earlier enqueued frames reached this peer, without sleeps.
  async fence(): Promise<Wire[]> {
    this.send({ ...hello, id: "fence" });
    const events: Wire[] = [];
    for (;;) { const message = await this.next(); if (message.body.ref === "fence") return events; events.push(message); }
  }
}
async function fixture(options: ReferenceHostOptions = {}) {
  const host = await createReferenceHost({ ...options, databasePath: ":memory:" });
  const peers: Peer[] = [];
  return {
    host,
    async peer() {
      const socket = new WebSocket(`ws://${host.host}:${host.port}/hvtp`);
      const peer = new Peer(socket); peers.push(peer);
      await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
      assert.equal((await peer.request(hello)).type, "session.welcome");
      return peer;
    },
    async close() { peers.forEach((peer) => peer.socket.close()); await host.close(); await host.realmCoordinator.drain(); },
  };
}
const spatial = { spatial: { center: [0, 0, 0] as const, radius: 10 } };

test("C07/C24 replacement evicts without deletion and later global deletion reaches only visible subscribers", async () => {
  const f = await fixture();
  try {
    f.host.worldStore.createEntity(cube("E"));
    const a = await f.peer(); const initial = await a.join({ entities: ["E"] });
    const b = await f.peer(); await b.join({ entities: ["E"] });
    a.send(subscription("S1", {}));
    const [applied, leave] = await a.take(2);
    assert.equal(applied!.type, "subscription.applied");
    assert.equal(applied!.body.previousSubscriptionId, initial[0]!.body.subscriptionId);
    assert.equal(applied!.body.baseRealmSeq, 1);
    assert.deepEqual(applied!.body.effectiveSubscription, {});
    assert.equal(leave!.type, "view.entity.leave"); assert.equal(leave!.body.reason, "subscription");
    assert.equal(leave!.body.subscriptionId, applied!.body.subscriptionId); assert.equal(leave!.seq, 1);
    assert.ok(f.host.worldStore.getEntity("E")); assert.equal(f.host.worldStore.isTombstoned("E"), false);
    assert.equal(f.host.worldStore.getRealmSeq(), 1);
    b.send(remove("delete", "E"));
    const deleted = await b.take(2);
    assert.deepEqual(deleted.map((m) => m.type).sort(), ["ack", "entity.deleted"]);
    await f.host.realmCoordinator.drain(); assert.deepEqual(await a.fence(), []);
    assert.equal(f.host.worldStore.isTombstoned("E"), true);
  } finally { await f.close(); }
});

test("C28/C31 overlapping generations serialize; pending and historical retries do not replay batches", async () => {
  const transition = gate(); let first = true;
  const f = await fixture({ realmCoordinatorOptions: { beforeTransitionEnqueue: async () => { if (first) { first = false; await transition.wait(); } } } });
  try {
    f.host.worldStore.createEntity(cube("E"));
    const a = await f.peer(); const initial = await a.join({ entities: ["E"] });
    const s1 = subscription("S1", {});
    a.send(s1); await transition.entered;
    a.send(s1); a.send(subscription("S1", { entities: ["E"] }));
    const conflict = await a.next(); assert.equal(conflict.body.code, "request_id_conflict");
    a.send(subscription("S2", { entities: ["E"] }));
    // Fence response proves S2 was admitted while S1 remained blocked.
    assert.deepEqual(await a.fence(), []);
    transition.release();
    const [applied1, leave, applied2, enter] = await a.take(4);
    assert.deepEqual([applied1, leave, applied2, enter].map((m) => m!.type), ["subscription.applied", "view.entity.leave", "subscription.applied", "view.entity.enter"]);
    assert.equal(applied1!.body.previousSubscriptionId, initial[0]!.body.subscriptionId);
    assert.equal(applied2!.body.previousSubscriptionId, applied1!.body.subscriptionId);
    assert.notEqual(applied1!.body.subscriptionId, applied2!.body.subscriptionId);
    assert.equal(leave!.body.subscriptionId, applied1!.body.subscriptionId);
    assert.equal(enter!.body.subscriptionId, applied2!.body.subscriptionId);
    assert.equal(enter!.body.entity!.id, "E"); assert.equal(enter!.body.reason, "subscription");
    assert.equal(leave!.seq, enter!.seq); assert.equal(f.host.worldStore.getRealmSeq(), 1);
    assert.deepEqual(await a.request(s1), applied1);
    await f.host.realmCoordinator.drain(); assert.deepEqual(await a.fence(), []);
    const b = await f.peer(); await b.join({});
    assert.equal((await b.request(move("later", "E", 1, 1))).type, "ack");
    const update = await a.next(); assert.equal(update.type, "component.updated");
    assert.equal(update.body.subscriptionId, applied2!.body.subscriptionId);
  } finally { transition.release(); await f.close(); }
});

test("C28 replacement captures exact canonical cut and later mutation uses the queued generation", async () => {
  const transition = gate();
  const f = await fixture({ realmCoordinatorOptions: { beforeTransitionEnqueue: () => transition.wait() } });
  try {
    f.host.worldStore.createEntity(cube("E"));
    const a = await f.peer(); const initial = await a.join({});
    const b = await f.peer(); await b.join({});
    assert.equal((await b.request(move("before", "E", 1, 2))).type, "ack");
    // A has no relevant publication for seq 2; B2 remains canonical and S1 captures it synchronously.
    a.send(subscription("S1", { entities: ["E"] })); await transition.entered;
    assert.equal((await b.request(move("after", "E", 2, 3))).type, "ack");
    assert.deepEqual(await a.fence(), []);
    transition.release();
    const [applied, enter, update] = await a.take(3);
    assert.equal(applied!.body.baseRealmSeq, 2); assert.equal(applied!.body.previousSubscriptionId, initial[0]!.body.subscriptionId);
    assert.equal(enter!.body.entity!.components["hvtp.transform@1"].revision, 2);
    assert.deepEqual(enter!.body.entity!.components["hvtp.transform@1"].state.position, [2, 0, 0]);
    assert.equal(enter!.seq, 2); assert.equal(update!.seq, 3);
    assert.equal(update!.body.subscriptionId, applied!.body.subscriptionId);
    assert.equal(update!.body.value!.revision, 3);
  } finally { transition.release(); await f.close(); }
});

test("C28 queued old-view publication finishes before subscription.applied", async () => {
  const publication = gate();
  const f = await fixture({ realmCoordinatorOptions: { beforeMutationEnqueue: () => publication.wait() } });
  try {
    f.host.worldStore.createEntity(cube("E"));
    const a = await f.peer(); const initial = await a.join({ entities: ["E"] });
    const b = await f.peer(); await b.join({});
    await b.request(move("before", "E", 1, 1)); await publication.entered;
    a.send(subscription("S1", {})); assert.deepEqual(await a.fence(), []);
    publication.release();
    const messages = await a.take(3);
    assert.deepEqual(messages.map((m) => m.type), ["component.updated", "subscription.applied", "view.entity.leave"]);
    assert.equal(messages[0]!.body.subscriptionId, initial[0]!.body.subscriptionId);
    assert.equal(messages[1]!.body.baseRealmSeq, 2);
    assert.equal(messages[2]!.body.subscriptionId, messages[1]!.body.subscriptionId);
  } finally { publication.release(); await f.close(); }
});

for (const kind of ["update", "create", "delete", "interest"] as const) {
  test(`C08/C30 snapshot cut buffers ${kind} exactly once after complete metadata batch`, async () => {
    const snapshot = gate(); let snapshots = 0;
    const f = await fixture({ realmCoordinatorOptions: { beforeSnapshotEnqueue: async () => { if (++snapshots === 2) await snapshot.wait(); } } });
    try {
      f.host.worldStore.createEntity(cube("E", kind === "interest" ? 20 : 0));
      const b = await f.peer(); await b.join({});
      const a = await f.peer(); const joining = a.join(spatial); await snapshot.entered;
      const request = kind === "create" ? create("postcut", "new") : kind === "delete" ? remove("postcut", "E") : move("postcut", "E", 1, 1);
      assert.equal((await b.request(request)).type, "ack"); assert.equal(a.messages.length, 0);
      snapshot.release();
      const records = await joining;
      const joined = records[0]!;
      assert.deepEqual(records.map((m) => m.type), kind === "interest"
        ? ["realm.joined", "realm.snapshot.begin", "entity.snapshot", "realm.snapshot.end"]
        : ["realm.joined", "realm.snapshot.begin", "entity.snapshot", "entity.snapshot", "realm.snapshot.end"]);
      for (const record of records) {
        assert.equal(record.realmEpoch, f.host.realmEpoch);
        assert.equal(record.body.snapshotBaseSeq, 1);
        assert.equal(record.body.snapshotId, joined.body.snapshotId);
      }
      assert.equal(records.at(-1)!.body.entityCount, records.filter((m) => m.type === "entity.snapshot").length);
      const initialE = records.find((m) => m.type === "entity.snapshot" && m.body.entity!.id === "E");
      if (kind !== "interest") assert.equal(initialE!.body.entity!.components["hvtp.transform@1"].revision, 1);
      const event = await a.next();
      assert.equal(event.type, { update: "component.updated", create: "entity.created", delete: "entity.deleted", interest: "view.entity.enter" }[kind]);
      assert.equal(event.seq, 2); assert.equal(event.body.subscriptionId, joined.body.subscriptionId);
      await f.host.realmCoordinator.drain(); assert.deepEqual(await a.fence(), []);
    } finally { snapshot.release(); await f.close(); }
  });
}

test("C30 buffered publication cannot be overtaken by later live publication or its ACK", async () => {
  const snapshot = gate(); const buffered = gate(); let snapshots = 0;
  const f = await fixture({ realmCoordinatorOptions: {
    beforeSnapshotEnqueue: async () => { if (++snapshots === 2) await snapshot.wait(); },
    beforeMutationEnqueue: async (seq) => { if (seq === 2) await buffered.wait(); },
  } });
  try {
    f.host.worldStore.createEntity(cube("E"));
    const b = await f.peer(); await b.join({}); const a = await f.peer(); const joining = a.join({ entities: ["E"] });
    await snapshot.entered; await b.request(move("buffered", "E", 1, 1));
    snapshot.release(); await joining; await buffered.entered;
    assert.equal((await b.request(move("ordinary", "E", 2, 2))).type, "ack");
    assert.deepEqual(await a.fence(), []);
    buffered.release(); const events = await a.take(2);
    assert.deepEqual(events.map((m) => [m.type, m.seq, m.body.value!.revision]), [["component.updated", 2, 2], ["component.updated", 3, 3]]);
  } finally { snapshot.release(); buffered.release(); await f.close(); }
});

test("C22 replacement interest never reveals another participant's private presence", async () => {
  const f = await fixture();
  try {
    const a = await f.peer(); const own = await a.join({}); const b = await f.peer(); const other = await b.join({});
    for (const [id, selector] of [["explicit", { entities: [other[0]!.body.presenceEntityId!] }],
      ["combined", { ...spatial, entities: [other[0]!.body.presenceEntityId!] }]] as const) {
      const result = await a.request(subscription(id, selector)); assert.equal(result.type, "subscription.applied");
      await f.host.realmCoordinator.drain(); assert.deepEqual(await a.fence(), []);
    }
    assert.equal(own.filter((m) => m.type === "entity.snapshot").length, 1);
    assert.equal(own.find((m) => m.type === "entity.snapshot")!.body.entity!.id, own[0]!.body.presenceEntityId);
    assert.notEqual(own[0]!.body.presenceEntityId, other[0]!.body.presenceEntityId);
    const c = await f.peer();
    const authorized = await c.join({ ...spatial, entities: [other[0]!.body.presenceEntityId!] });
    assert.equal(authorized.filter((m) => m.type === "entity.snapshot").length, 1);
    assert.equal(authorized.find((m) => m.type === "entity.snapshot")!.body.entity!.id, authorized[0]!.body.presenceEntityId);
    assert.equal(f.host.worldStore.getRealmSeq(), 0);
  } finally { await f.close(); }
});

test("C21 replacement accepts exact view limit including own presence and rejects max+1 without changing generation", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < P1_LIMITS.maxVisibleEntitiesPerConnection - 1; i++) f.host.worldStore.createEntity(cube(`E${i}`));
    f.host.worldStore.createEntity(cube("outside", 20));
    const a = await f.peer(); await a.join({});
    a.send(subscription("exact", spatial));
    const batch = await a.take(P1_LIMITS.maxVisibleEntitiesPerConnection);
    assert.equal(batch[0]!.type, "subscription.applied");
    assert.equal(batch.slice(1).filter((m) => m.type === "view.entity.enter").length, P1_LIMITS.maxVisibleEntitiesPerConnection - 1);
    const rejected = await a.request(subscription("over", { ...spatial, entities: ["outside"] }));
    assert.equal(rejected.body.code, "resource_limit");
    assert.deepEqual(await a.request(subscription("over", { ...spatial, entities: ["outside"] })), rejected);
    await f.host.realmCoordinator.drain(); assert.deepEqual(await a.fence(), []);
    const b = await f.peer(); await b.join({}); await b.request(move("still-visible", "E0", 1, 1));
    const update = await a.next(); assert.equal(update.type, "component.updated");
    assert.equal(update.body.subscriptionId, batch[0]!.body.subscriptionId);
    assert.equal(f.host.worldStore.getRealmSeq(), P1_LIMITS.maxVisibleEntitiesPerConnection + 1);
  } finally { await f.close(); }
});

for (const kind of ["create", "move"] as const) {
  test(`C36 ${kind} commits while overflowing subscriber closes; narrower subscribers and rejoin remain correct`, async () => {
    const f = await fixture();
    try {
      for (let i = 0; i < P1_LIMITS.maxVisibleEntitiesPerConnection - 1; i++) f.host.worldStore.createEntity(cube(`E${i}`));
      if (kind === "move") f.host.worldStore.createEntity(cube("new", 20));
      const a = await f.peer(); await a.join(spatial);
      const b = await f.peer(); await b.join({ entities: ["new"] });
      b.send(kind === "create" ? create("growth", "new") : move("growth", "new", 1, 0));
      const bResults = await b.take(2);
      assert.equal(bResults.filter((m) => m.type === "ack").length, 1);
      assert.equal(bResults.filter((m) => m.type === (kind === "create" ? "entity.created" : "component.updated")).length, 1);
      const overflow = await a.next(); assert.equal(overflow.type, "error"); assert.equal(overflow.body.ref, null);
      assert.equal(overflow.body.code, "resource_limit"); assert.equal(await a.closed, 1011);
      assert.ok(f.host.worldStore.getEntity("new"));
      assert.equal(b.socket.readyState, WebSocket.OPEN);
      const rejoin = await f.peer(); const rejected = await rejoin.join(spatial);
      assert.equal(rejected[0]!.body.code, "resource_limit");
      const narrow = await rejoin.join({ entities: ["new"] });
      assert.equal(narrow.at(-1)!.type, "realm.snapshot.end");
      assert.ok(narrow.find((m) => m.type === "entity.snapshot" && m.body.entity!.id === "new"));
    } finally { await f.close(); }
  });
}

test("C31 pending-operation admission is bounded, duplicate lookup precedes pending capacity", async () => {
  const transition = gate();
  const f = await fixture({ realmCoordinatorOptions: { beforeTransitionEnqueue: () => transition.wait() } });
  try {
    const a = await f.peer(); await a.join({});
    for (let i = 0; i < P1_LIMITS.maxPendingStateChangingRequests; i++) a.send(subscription(`S${i}`, {}));
    await transition.entered;
    a.send(subscription("S0", {}));
    assert.deepEqual(await a.fence(), []);
    assert.equal((await a.request(subscription("S0", spatial))).body.code, "request_id_conflict");
    assert.equal((await a.request(subscription("overflow", {}))).body.code, "resource_limit");
    assert.equal((await a.request(create("pending-mutation", "blocked"))).body.code, "resource_limit");
    assert.equal(f.host.worldStore.getEntity("blocked"), null);
    transition.release();
    const terminals = await a.take(P1_LIMITS.maxPendingStateChangingRequests);
    assert.ok(terminals.every((m) => m.type === "subscription.applied"));
    assert.equal(new Set(terminals.map((m) => m.body.subscriptionId)).size, P1_LIMITS.maxPendingStateChangingRequests);
    // Refused pending-capacity ID was not reserved and can be admitted after capacity is released.
    assert.equal((await a.request(subscription("overflow", {}))).type, "subscription.applied");
    assert.equal((await a.request(create("pending-mutation", "blocked"))).type, "ack");
  } finally { transition.release(); await f.close(); }
});

test("C31 request-table lookup precedes capacity and cached subscriptions remain exact", async () => {
  const f = await fixture();
  try {
    const a = await f.peer(); await a.join({});
    const first = await a.request(subscription("S0", {}));
    // Cached validation errors are admitted terminal operations too.
    for (let i = 1; i < P1_LIMITS.maxRequestDedupEntries; i++) {
      const result = await a.request({ ...subscription(`bad${i}`, {}), body: { extra: true } });
      assert.equal(result.body.code, "invalid_message");
    }
    assert.deepEqual(await a.request(subscription("S0", {})), first);
    assert.equal((await a.request(subscription("S0", spatial))).body.code, "request_id_conflict");
    assert.equal((await a.request(subscription("overflow", {}))).body.code, "resource_limit");
    // Different content for the refused ID must still be a capacity refusal, not an ID conflict.
    assert.equal((await a.request(subscription("overflow", spatial))).body.code, "resource_limit");
    assert.equal((await a.request(create("mutation-overflow", "not-created"))).body.code, "resource_limit");
    assert.equal(f.host.worldStore.getEntity("not-created"), null);
    await f.host.realmCoordinator.drain(); assert.deepEqual(await a.fence(), []);
  } finally { await f.close(); }
});

test("C21 snapshot catch-up payload overflow disconnects only affected peer and releases blocked work", async () => {
  const snapshot = gate(); let snapshots = 0;
  const f = await fixture({ realmCoordinatorOptions: { beforeSnapshotEnqueue: async () => { if (++snapshots === 2) await snapshot.wait(); } } });
  try {
    f.host.worldStore.createEntity(cube("E"));
    const b = await f.peer(); await b.join({});
    const a = await f.peer();
    a.send({ hvtp: "0.2", id: "join", type: "realm.join", body: { realm: P1_REALM_ID, subscription: { entities: ["E"] } } });
    await snapshot.entered;
    // Drive canonical store commits directly to exercise the buffer without requester-table exhaustion.
    for (let revision = 1; revision <= 12_000; revision++) {
      const before = f.host.worldStore.getEntity("E")!;
      const result = f.host.worldStore.replaceMutableComponent("E", "hvtp.transform@1", cube("E", revision % 2).transform, revision, 1);
      f.host.realmCoordinator.publish({ kind: "updated", before, entity: result.entity, seq: result.seq, component: "hvtp.transform@1" });
    }
    assert.equal(await a.closed, 1011);
    const error = await a.next(); assert.equal(error.body.code, "resource_limit"); assert.equal(error.body.ref, null);
    assert.equal(b.socket.readyState, WebSocket.OPEN);
    // drain must finish despite an unreleased snapshot barrier on a closed connection.
    await f.host.realmCoordinator.drain();
  } finally { snapshot.release(); await f.close(); }
});

test("transition enqueue failure closes affected generation and preserves durable world state", async () => {
  const f = await fixture({ realmCoordinatorOptions: { beforeTransitionEnqueue: async () => { throw new Error("enqueue fault"); } } });
  try {
    f.host.worldStore.createEntity(cube("E"));
    const a = await f.peer(); await a.join({ entities: ["E"] });
    a.send(subscription("S1", {})); assert.equal(await a.closed, 1011);
    assert.equal(f.host.worldStore.getRealmSeq(), 1); assert.ok(f.host.worldStore.getEntity("E"));
    const b = await f.peer(); const snapshot = await b.join({ entities: ["E"] });
    assert.ok(snapshot.find((m) => m.type === "entity.snapshot" && m.body.entity!.id === "E"));
  } finally { await f.close(); }
});

test("C07 replacement sends every leave before every enter at one unchanged realm sequence", async () => {
  const f = await fixture();
  try {
    for (const id of ["old1", "old2", "new1", "new2"]) f.host.worldStore.createEntity(cube(id));
    const a = await f.peer(); await a.join({ entities: ["old1", "old2"] });
    a.send(subscription("replace", { entities: ["new1", "new2"] }));
    const messages = await a.take(5);
    assert.deepEqual(messages.map((m) => m.type), ["subscription.applied", "view.entity.leave", "view.entity.leave", "view.entity.enter", "view.entity.enter"]);
    assert.deepEqual(messages.slice(1, 3).map((m) => m.body.entityId).sort(), ["old1", "old2"]);
    assert.deepEqual(messages.slice(3).map((m) => m.body.entity!.id).sort(), ["new1", "new2"]);
    for (const message of messages.slice(1)) {
      assert.equal(message.seq, 4); assert.equal(message.body.reason, "subscription");
      assert.equal(message.body.subscriptionId, messages[0]!.body.subscriptionId);
    }
    assert.equal(messages[0]!.body.baseRealmSeq, 4); assert.equal(f.host.worldStore.getRealmSeq(), 4);
    assert.ok(["old1", "old2", "new1", "new2"].every((id) => !f.host.worldStore.isTombstoned(id)));
  } finally { await f.close(); }
});

test("C21 queued replacement payloads share one bounded buffer and close ambiguous generation", async () => {
  const transition = gate();
  const f = await fixture({ realmCoordinatorOptions: { beforeTransitionEnqueue: () => transition.wait() } });
  try {
    for (let i = 0; i < P1_LIMITS.maxVisibleEntitiesPerConnection - 1; i++) f.host.worldStore.createEntity(cube(`E${i}`));
    const a = await f.peer(); await a.join({});
    a.send(subscription("S0", spatial)); await transition.entered;
    for (let i = 1; i < 16; i++) a.send(subscription(`S${i}`, i % 2 === 0 ? spatial : {}));
    const error = await a.next(); assert.equal(error.type, "error"); assert.equal(error.body.code, "resource_limit");
    assert.equal(error.body.ref, null); assert.equal(await a.closed, 1011);
    assert.equal(f.host.worldStore.getRealmSeq(), P1_LIMITS.maxVisibleEntitiesPerConnection - 1);
    await f.host.realmCoordinator.drain();
    const b = await f.peer(); assert.equal((await b.join({})).at(-1)!.type, "realm.snapshot.end");
  } finally { transition.release(); await f.close(); }
});
