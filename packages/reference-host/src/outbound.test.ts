import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { P1_LIMITS, P1_REALM_ID, type ErrorMessage, type SessionServerMessage } from "@hvtp/protocol-types";
import { P1OutboundChannel, type OutboundTransport } from "./outbound.js";
import { P1RealmCoordinator } from "./realm-coordinator.js";
import { createReferenceHost, type ReferenceConnection, type ReferenceHostOptions } from "./server.js";
import { connect, cubeInput, helloMessage, joinMessage, subscriptionMessage } from "./test-support.js";

const LIMIT = P1_LIMITS.maxQueuedOutboundBytes;

const BASE: ErrorMessage = { hvtp: "0.2", id: "t", type: "error", realm: P1_REALM_ID, realmEpoch: "epoch:test", body: { ref: null, code: "resource_limit", message: "" } };
/** Smallest serialized error message in bytes. */
const MIN = Buffer.byteLength(JSON.stringify(BASE));

/** Error message whose serialized UTF-8 size is exactly `bytes`. */
function sized(bytes: number): ErrorMessage {
  assert.ok(bytes >= MIN);
  const message = { ...BASE, body: { ...BASE.body, message: "x".repeat(bytes - MIN) } };
  assert.equal(Buffer.byteLength(JSON.stringify(message)), bytes);
  return message;
}

/** Transport whose send completion is held until the test releases it. */
class HeldTransport implements OutboundTransport {
  open = true;
  readonly pending: Array<{ data: string; done: (error?: Error | null) => void }> = [];
  failSynchronously = false;
  isOpen(): boolean { return this.open; }
  send(data: string, done: (error?: Error | null) => void): void {
    if (this.failSynchronously) throw new Error("synchronous transport failure");
    this.pending.push({ data, done });
  }
  completeAll(): void { for (const entry of this.pending.splice(0)) entry.done(); }
}

test("outbound budget: exact limit is admitted, one more byte is refused, completion releases the reservation", () => {
  const transport = new HeldTransport();
  const channel = new P1OutboundChannel(transport);
  const tail = MIN + 50;
  assert.equal(channel.trySend(sized(LIMIT - tail)), true);
  assert.equal(channel.queuedBytes, LIMIT - tail);
  assert.equal(channel.trySend(sized(tail + 1)), false, "one byte over the limit");
  assert.equal(transport.pending.length, 1, "refused message is never handed to the transport");
  assert.equal(channel.trySend(sized(tail)), true, "exactly the limit");
  assert.equal(channel.queuedBytes, LIMIT);
  assert.equal(channel.trySend(sized(MIN)), false);
  assert.equal(channel.reserve(1), false);
  transport.completeAll();
  assert.equal(channel.queuedBytes, 0);
  assert.equal(channel.inFlightCount, 0);
  assert.equal(channel.trySend(sized(LIMIT)), true);
});

test("outbound budget: release is exactly-once, failure callback fires once, synchronous failure releases", () => {
  const transport = new HeldTransport();
  const failures: Error[] = [];
  const channel = new P1OutboundChannel(transport, (error) => failures.push(error));
  assert.equal(channel.trySend(sized(1000)), true);
  assert.equal(channel.trySend(sized(2000)), true);
  const [first, second] = transport.pending;
  first!.done(); first!.done(new Error("late duplicate"));
  assert.equal(channel.queuedBytes, 2000);
  assert.deepEqual(failures, []);
  second!.done(new Error("write failed")); second!.done(new Error("again"));
  assert.equal(channel.queuedBytes, 0);
  assert.equal(failures.length, 1);

  transport.failSynchronously = true;
  assert.throws(() => channel.trySend(sized(500)), /synchronous transport failure/);
  assert.equal(channel.queuedBytes, 0);
  transport.open = false;
  assert.throws(() => channel.trySend(sized(500)), /Transport is closed/);
  assert.equal(channel.queuedBytes, 0);
});

test("outbound budget: dispose drops all accounting and late completions are inert", () => {
  const transport = new HeldTransport();
  const failures: Error[] = [];
  const channel = new P1OutboundChannel(transport, (error) => failures.push(error));
  channel.trySend(sized(4000)); channel.reserve(7000);
  channel.dispose();
  assert.equal(channel.queuedBytes, 0);
  assert.equal(channel.inFlightCount, 0);
  transport.pending[0]!.done(new Error("after close"));
  channel.release(7000); // coordinator releasing after close is a no-op, never an underflow
  assert.deepEqual(failures, []);
  assert.equal(channel.queuedBytes, 0);
  assert.equal(channel.reserve(1), false);
});

test("one budget: coordinator reservation and transport-pending bytes are each counted once and compete with direct output", async () => {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const coordinator = new P1RealmCoordinator("epoch:test", { beforeSnapshotEnqueue: () => barrier });
  const transport = new HeldTransport();
  const channel = new P1OutboundChannel(transport);
  const direct = MIN + 100;
  const messages: SessionServerMessage[] = [sized(1_000_000), sized(1_000_000), sized(LIMIT - 2_000_000 - direct)];
  const total = messages.reduce((sum, message) => sum + Buffer.byteLength(JSON.stringify(message)), 0);
  const subscriber = coordinator.subscribe({}, "S0", { baseSeq: 0, entities: [] }, messages, channel, () => assert.fail("no close expected"), () => {});

  assert.equal(channel.queuedBytes, total, "coordinator-held batch is reserved on the connection budget");
  assert.equal(channel.trySend(sized(direct + 1)), false, "direct output cannot exceed the shared remainder");
  assert.equal(channel.trySend(sized(direct)), true, "direct output may use exactly the remainder");
  assert.equal(channel.queuedBytes, LIMIT);
  const afterDirect = transport.pending.length; // the direct message only

  release(); await coordinator.drain();
  assert.equal(transport.pending.length, afterDirect + messages.length);
  assert.equal(channel.queuedBytes, LIMIT, "handoff to the transport neither frees nor double-counts bytes");
  transport.completeAll();
  assert.equal(channel.queuedBytes, 0);
  subscriber.unsubscribe();
  assert.equal(channel.queuedBytes, 0);
});

test("coordinator releases its undelivered reservation when the connection unsubscribes", async () => {
  const coordinator = new P1RealmCoordinator("epoch:test", { beforeSnapshotEnqueue: () => new Promise(() => {}) });
  const transport = new HeldTransport();
  const channel = new P1OutboundChannel(transport);
  const subscriber = coordinator.subscribe({}, "S0", { baseSeq: 0, entities: [] }, [sized(1_500_000)], channel, () => {}, () => {});
  assert.equal(channel.queuedBytes, 1_500_000);
  subscriber.unsubscribe();
  assert.equal(channel.queuedBytes, 0);
  assert.equal(coordinator.subscriberCount, 0);
  await coordinator.drain();
});

// ---- wire-level behavior through the host's transport seam ----

interface Seam {
  connections: ReferenceConnection[];
  peak: number;
  held: Array<(error?: Error | null) => void>;
  mode: "hold" | "pass" | "fail";
}

function seamOptions(seam: Seam): ReferenceHostOptions {
  let tick = 0;
  return {
    databasePath: ":memory:",
    clock: () => (tick += 20),
    onConnection: (connection) => { seam.connections.push(connection); },
    sendTransport: (socket, data, done) => {
      const channel = seam.connections.find((connection) => connection.socket === socket)!.channel;
      seam.peak = Math.max(seam.peak, channel.queuedBytes);
      if (seam.mode === "hold") seam.held.push(done);
      else if (seam.mode === "fail") queueMicrotask(() => done(new Error("write failed")));
      else socket.send(data, (error) => done(error));
    },
  };
}
const newSeam = (): Seam => ({ connections: [], peak: 0, held: [], mode: "pass" });
const spatial = { spatial: { center: [0, 0, 0], radius: 10 } };

test("C21 outbound exhaustion: transport-pending bytes count against the same 4 MiB budget and overflow closes only that connection", async () => {
  const seam = newSeam();
  const host = await createReferenceHost(seamOptions(seam));
  try {
    for (let i = 0; i < P1_LIMITS.maxVisibleEntitiesPerConnection - 1; i++) host.worldStore.createEntity(cubeInput(`E${i}`));
    const bystander = await connect(host);
    await bystander.hello(); await bystander.join({});
    const peer = await connect(host);
    await peer.hello(); await peer.join({});
    const channel = seam.connections[1]!.channel;
    seam.mode = "hold"; // from now on the socket never completes a write
    for (let i = 0; i < 16; i++) peer.send(subscriptionMessage(`S${i}`, i % 2 === 0 ? spatial : {}));
    assert.equal(await peer.closed, 1011);
    assert.ok(seam.peak <= LIMIT, `admitted bytes never exceed the budget (peak ${seam.peak})`);
    assert.ok(seam.peak > LIMIT / 2, "bytes handed to the transport stayed counted while its writes were incomplete");
    assert.equal(channel.queuedBytes, 0, "close released every reservation");
    assert.equal(channel.inFlightCount, 0);
    await host.realmCoordinator.drain();
    assert.equal(host.realmCoordinator.subscriberCount, 1, "only the bystander remains subscribed");
    assert.equal(bystander.socket.readyState, WebSocket.OPEN);
    assert.equal(host.worldStore.getRealmSeq(), P1_LIMITS.maxVisibleEntitiesPerConnection - 1, "overflow does not roll back durable state");
    seam.mode = "pass";
    bystander.socket.close();
  } finally {
    await host.close();
  }
});

test("transport send failure closes the connection once, releases bytes once, and cancels queued coordinator work", async () => {
  const seam = newSeam();
  let transitions = 0;
  let releaseSecond!: () => void;
  const second = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const host = await createReferenceHost({
    ...seamOptions(seam),
    realmCoordinatorOptions: { beforeTransitionEnqueue: async () => { if (++transitions === 2) await second; } },
  });
  try {
    host.worldStore.createEntity(cubeInput("E"));
    const peer = await connect(host);
    await peer.hello(); await peer.join({});
    const connection = seam.connections[0]!;
    seam.mode = "fail";
    peer.send(subscriptionMessage("S1", { entities: ["E"] }));
    peer.send(subscriptionMessage("S2", {})); // queued behind the first, blocked at its barrier
    assert.equal(await peer.closed, 1011);
    assert.equal(connection.channel.queuedBytes, 0);
    assert.equal(connection.channel.inFlightCount, 0);
    assert.equal(connection.session.state, "CLOSED");
    assert.equal(host.realmCoordinator.subscriberCount, 0, "no generation remains live");
    releaseSecond();
    await host.realmCoordinator.drain();
    assert.equal(connection.channel.queuedBytes, 0);
  } finally {
    releaseSecond();
    await host.close();
  }
});

test("connection close releases reservations, coordinator work, subscription state and private presence", async () => {
  const seam = newSeam();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const host = await createReferenceHost({
    ...seamOptions(seam),
    realmCoordinatorOptions: { beforeSnapshotEnqueue: () => barrier },
  });
  try {
    for (let i = 0; i < 500; i++) host.worldStore.createEntity(cubeInput(`E${i}`));
    seam.mode = "hold";
    const peer = await connect(host);
    // hello's welcome is a direct response held by the seam; the join snapshot is reserved by the coordinator.
    peer.send(helloMessage());
    await new Promise<void>((resolve) => seam.connections[0]!.socket.once("message", () => resolve()));
    peer.send(joinMessage("join", spatial));
    const connection = seam.connections[0]!;
    const serverClosed = new Promise<void>((resolve) => connection.socket.once("close", () => resolve()));
    await new Promise<void>((resolve) => connection.socket.once("message", () => resolve()));
    assert.ok(connection.channel.queuedBytes > 100_000, "snapshot batch and held welcome are reserved");
    assert.equal(host.realmCoordinator.subscriberCount, 1);
    assert.equal(host.realmCoordinator.privatePresenceCount, 1);
    peer.socket.terminate();
    await serverClosed;
    assert.equal(connection.channel.queuedBytes, 0);
    assert.equal(connection.channel.inFlightCount, 0);
    assert.equal(connection.session.state, "CLOSED");
    assert.equal(host.realmCoordinator.subscriberCount, 0);
    assert.equal(host.realmCoordinator.privatePresenceCount, 0);
    release();
    await host.realmCoordinator.drain();
    assert.equal(connection.channel.queuedBytes, 0);
  } finally {
    release();
    await host.close();
  }
});

test("B1: if the exact session.welcome cannot be admitted the connection closes; no substitute error, never left NEGOTIATED", async () => {
  const seam = newSeam();
  const host = await createReferenceHost({
    ...seamOptions(seam),
    // Exhaust the connection budget before the first request is handled.
    onConnection: (connection) => { seam.connections.push(connection); assert.equal(connection.channel.reserve(LIMIT), true); },
  });
  try {
    const peer = await connect(host);
    peer.send(helloMessage());
    assert.equal(await peer.closed, 1011);
    assert.deepEqual(peer.messages, [], "nothing, in particular no substitute resource_limit, was sent");
    const connection = seam.connections[0]!;
    assert.equal(connection.session.state, "CLOSED");
    assert.equal(connection.channel.queuedBytes, 0);
  } finally {
    await host.close();
  }
});

test("B1: a computed terminal error or committed ACK that cannot fit closes the connection and is never replaced", async () => {
  const seam = newSeam();
  const host = await createReferenceHost(seamOptions(seam));
  try {
    const bad = JSON.stringify({ ...subscriptionMessage("sub", {}), body: { extra: true } });
    const peers = [];
    for (let i = 0; i < 2; i++) {
      const peer = await connect(host);
      await peer.hello(); await peer.join({});
      peers.push(peer);
    }
    // Peer 0: admitted request whose terminal is an error that no longer fits.
    const first = seam.connections[0]!.channel;
    assert.equal(first.reserve(LIMIT - first.queuedBytes), true);
    peers[0]!.send(bad);
    assert.equal(await peers[0]!.closed, 1011);
    assert.deepEqual(peers[0]!.messages, []);
    assert.equal(seam.connections[0]!.session.state, "CLOSED");

    // Peer 1: committed durable mutation whose exact ACK no longer fits. State stays committed.
    const second = seam.connections[1]!.channel;
    assert.equal(second.reserve(LIMIT - second.queuedBytes), true);
    peers[1]!.send(JSON.stringify({
      hvtp: "0.2", id: "req-ack", type: "entity.create", realm: P1_REALM_ID,
      body: { entity: { id: "E-ack", components: {
        "hvtp.transform@1": { state: cubeInput("E-ack").transform },
        "hvtp.renderable@1": { state: cubeInput("E-ack").renderable },
        "hvtp.material@1": { state: cubeInput("E-ack").material },
      } } },
    }));
    assert.equal(await peers[1]!.closed, 1011);
    assert.deepEqual(peers[1]!.messages, []);
    assert.notEqual(host.worldStore.getEntity("E-ack"), null);
    assert.equal(host.worldStore.getRealmSeq(), 1);
  } finally {
    await host.close();
  }
});
