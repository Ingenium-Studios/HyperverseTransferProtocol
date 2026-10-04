import assert from "node:assert/strict";
import test from "node:test";
import { P1_LIMITS, P1_REALM_ID, type ErrorMessage, type SessionServerMessage } from "@hvtp/protocol-types";
import { P1RealmCoordinator } from "./realm-coordinator.js";

function batch(bytes: number): SessionServerMessage[] {
  const messages: ErrorMessage[] = [];
  const empty: ErrorMessage = { hvtp: "0.2", id: "test", type: "error", realm: P1_REALM_ID, realmEpoch: "epoch:test", body: { ref: null, code: "resource_limit", message: "" } };
  const overhead = Buffer.byteLength(JSON.stringify(empty));
  while (bytes > 0) {
    let size = Math.min(bytes, 130_000);
    if (bytes - size > 0 && bytes - size < overhead) size -= overhead;
    assert.ok(size >= overhead);
    messages.push({ ...empty, body: { ...empty.body, message: "x".repeat(size - overhead) } });
    bytes -= size;
  }
  return messages;
}

test("coordinator byte admission accepts exactly maxQueuedOutboundBytes and rejects one extra byte", async () => {
  for (const extra of [0, 1]) {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const coordinator = new P1RealmCoordinator("epoch:test", { beforeSnapshotEnqueue: () => barrier });
    const delivered: SessionServerMessage[] = []; const closed: number[] = [];
    const messages = batch(P1_LIMITS.maxQueuedOutboundBytes + extra);
    assert.equal(messages.reduce((total, message) => total + Buffer.byteLength(JSON.stringify(message)), 0), P1_LIMITS.maxQueuedOutboundBytes + extra);
    let completed = false;
    const subscriber = coordinator.subscribe({}, "S0", { baseSeq: 0, entities: [] }, messages,
      (message) => delivered.push(message), (code) => closed.push(code), () => { completed = true; });
    if (extra === 0) {
      assert.deepEqual(closed, []); assert.deepEqual(delivered, []);
      release(); await coordinator.drain();
      assert.deepEqual(delivered, messages); assert.equal(completed, true);
    } else {
      assert.deepEqual(closed, [1011]); assert.equal(completed, false);
      assert.equal(delivered.length, 1); assert.equal(delivered[0]!.type, "error");
      if (delivered[0]!.type === "error") { assert.equal(delivered[0]!.body.code, "resource_limit"); assert.equal(delivered[0]!.body.ref, null); }
      await coordinator.drain(); release();
    }
    subscriber.unsubscribe();
  }
});

test("coordinator unsubscribe cancels a blocked snapshot without waiting for its barrier", async () => {
  const coordinator = new P1RealmCoordinator("epoch:test", { beforeSnapshotEnqueue: () => new Promise(() => {}) });
  const delivered: SessionServerMessage[] = [];
  const subscriber = coordinator.subscribe({}, "S0", { baseSeq: 0, entities: [] }, batch(500),
    (message) => delivered.push(message), () => assert.fail("unsubscribe must not close transport again"), () => assert.fail("closed snapshot cannot complete"));
  // Let the worker enter the barrier before cancellation.
  await Promise.resolve();
  subscriber.unsubscribe(); await coordinator.drain();
  assert.deepEqual(delivered, []);
});

test("coordinator partial transition enqueue failure closes the connection and never completes its request", async () => {
  const coordinator = new P1RealmCoordinator("epoch:test");
  const delivered: SessionServerMessage[] = []; const closed: number[] = [];
  const entity = { id: "E", components: {
    "hvtp.transform@1": { revision: 1, authority: "host", authorityEpoch: 1, consistency: "authoritative", state: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } },
    "hvtp.renderable@1": { revision: 1, authority: "host", authorityEpoch: 1, consistency: "authoritative", state: { asset: { uri: "unit-cube.gltf", mediaType: "model/gltf+json" }, node: "UnitCube", visible: true } },
    "hvtp.material@1": { revision: 1, authority: "host", authorityEpoch: 1, consistency: "authoritative", state: { baseColor: [1, 1, 1, 1] } },
  } } as const;
  const subscriber = coordinator.subscribe({ entities: ["E"] }, "S0", { baseSeq: 1, entities: [entity] }, [],
    (message) => { if (message.type === "view.entity.leave") throw new Error("transport failure"); delivered.push(message); },
    (code) => closed.push(code), () => {});
  await coordinator.drain();
  subscriber.replace({}, { baseSeq: 1, entities: [] }, "S1", () => assert.fail("partially delivered batch must not complete"));
  await coordinator.drain();
  assert.deepEqual(delivered.map((message) => message.type), ["subscription.applied"]);
  assert.deepEqual(closed, [1011]);
  assert.throws(() => subscriber.replace({}, { baseSeq: 1, entities: [] }, "S2", () => {}),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "invalid_state");
});
