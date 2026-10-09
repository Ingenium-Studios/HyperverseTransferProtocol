import assert from "node:assert/strict";
import test from "node:test";
import { runAgent, type P1AgentOptions, type P1AgentResult } from "./index.js";
import { ScriptedHost } from "./test-support.js";

const ID = "entity:cube";
const RED = [1, 0, 0, 1] as const;
const BLUE = [0, 0, 1, 1] as const;
const MATERIAL = "hvtp.material@1";
const HANDSHAKE = ["session.hello", "realm.join", "subscription.set"];

function hostWithCube(baseColor: number[] = [1, 1, 1, 1]): ScriptedHost {
  const host = new ScriptedHost();
  host.addCube(ID, { baseColor });
  return host;
}

function run(host: ScriptedHost, extra: Partial<P1AgentOptions> = {}): Promise<P1AgentResult> {
  let ids = 0;
  return runAgent({
    url: "ws://test/hvtp", entityId: ID, socketFactory: host.factory, delay: async () => {}, timeoutMs: 100, assetCheck: false,
    createId: (prefix) => `${prefix}:${++ids}`, intents: [{ kind: "material", baseColor: RED }], ...extra,
  });
}

const names = (result: P1AgentResult) => result.events.map((event) => event.event);
const find = (result: P1AgentResult, name: string) => result.events.filter((event) => event.event === name);
const componentFrames = (host: ScriptedHost) => host.received.map((entry) => entry.frame).filter((frame) => frame.type === "component.set" || frame.type === "component.patch");

test("U4: negotiates as agent, joins with {}, subscribes explicitly, then fences the mutation with the observed revision", async () => {
  const host = hostWithCube();
  const result = await run(host);
  assert.equal(result.exitCode, 0);
  assert.equal(result.outcome, "satisfied");
  assert.deepEqual(host.typesOf(1), [...HANDSHAKE, "component.set"]);
  const [hello, join, subscribe, mutation] = host.received.map((entry) => entry.frame);
  assert.equal(hello!.body.participant.kind, "agent");
  assert.deepEqual(join!.body.subscription, {});
  assert.deepEqual(subscribe!.body, { entities: [ID] });
  assert.deepEqual(
    { entityId: mutation!.body.entityId, component: mutation!.body.component, baseRevision: mutation!.body.baseRevision, authorityEpoch: mutation!.body.authorityEpoch, state: mutation!.body.state },
    { entityId: ID, component: MATERIAL, baseRevision: 1, authorityEpoch: 1, state: { baseColor: [1, 0, 0, 1] } },
  );
  assert.deepEqual(names(result), [
    "agent.start", "session.live", "subscription.applied", "entity.observed", "request.sent", "request.committed",
    "entity.observed", "intent.resolved", "session.closed", "result",
  ]);
  assert.equal(find(result, "session.live")[0]!.participantKind, "agent");
  assert.deepEqual(find(result, "entity.observed").map((event) => event.reason), ["subscribed", "after-ack"]);
  assert.equal(find(result, "intent.resolved")[0]!.resolution, "committed");
  assert.equal(host.entities.get(ID)!.components[MATERIAL].revision, 2);
  // ordinals are 1..n and the result event is last
  assert.deepEqual(result.events.map((event) => event.n), result.events.map((_, index) => index + 1));
  assert.equal(result.events.at(-1)!.event, "result");
  assert.deepEqual(result.finalEntity!.components["hvtp.material@1"].state.baseColor, [1, 0, 0, 1]);
});

test("position intents are sent as component.patch of the transform with its own revision", async () => {
  const host = hostWithCube();
  const result = await run(host, { intents: [{ kind: "position", position: [-2, 0.5, 0] }] });
  assert.equal(result.exitCode, 0);
  const [frame] = componentFrames(host);
  assert.equal(frame!.type, "component.patch");
  assert.deepEqual([frame!.body.component, frame!.body.baseRevision, frame!.body.patch], ["hvtp.transform@1", 1, { position: [-2, 0.5, 0] }]);
  assert.deepEqual(host.entities.get(ID)!.components["hvtp.transform@1"].state.position, [-2, 0.5, 0]);
});

test("observe-only runs send no mutation and exit 0", async () => {
  const host = hostWithCube();
  const result = await run(host, { intents: [] });
  assert.deepEqual([result.outcome, result.exitCode], ["observed", 0]);
  assert.deepEqual(host.typesOf(1), HANDSHAKE);
});

test("a target that is already met skips the mutation and says so", async () => {
  const host = hostWithCube([...RED]);
  const result = await run(host);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(host.typesOf(1), HANDSHAKE);
  assert.deepEqual(find(result, "intent.resolved")[0], { n: find(result, "intent.resolved")[0]!.n, event: "intent.resolved", intent: 0, resolution: "already-satisfied", attempts: 0 });
});

test("U5: revision_mismatch waits for the newer revision, then retries with a new request ID and the current revision", async () => {
  const host = hostWithCube();
  const result = await run(host, { hooks: { beforeSubmit: ({ attempt }) => { if (attempt === 1) host.external(ID, MATERIAL, { baseColor: [...BLUE] }); } } });
  assert.equal(result.exitCode, 0);
  const frames = componentFrames(host);
  assert.equal(frames.length, 2);
  assert.notEqual(frames[0]!.id, frames[1]!.id);
  assert.deepEqual(frames.map((frame) => frame.body.baseRevision), [1, 2]);
  const rejected = find(result, "request.rejected")[0]!;
  assert.deepEqual([rejected.code, rejected.currentRevision], ["revision_mismatch", 2]);
  assert.deepEqual(find(result, "entity.observed").map((event) => event.reason), ["subscribed", "after-conflict", "after-ack"]);
  assert.deepEqual([find(result, "intent.resolved")[0]!.resolution, find(result, "intent.resolved")[0]!.attempts], ["committed", 2]);
  assert.equal(host.entities.get(ID)!.components[MATERIAL].revision, 3);
});

test("U5: conflicts beyond maxAttempts exit 5 without further requests", async () => {
  const host = hostWithCube();
  const result = await run(host, { maxAttempts: 1, hooks: { beforeSubmit: () => host.external(ID, MATERIAL, { baseColor: [...BLUE] }) } });
  assert.deepEqual([result.outcome, result.exitCode], ["exhausted", 5]);
  assert.equal(componentFrames(host).length, 1);
});

test("U5: persistent conflicts stop after the default 3 attempts", async () => {
  const host = hostWithCube();
  const result = await run(host, { hooks: { beforeSubmit: () => host.external(ID, MATERIAL, { baseColor: [Math.random() / 2, 0, 1, 1] }) } });
  assert.equal(result.exitCode, 5);
  assert.equal(componentFrames(host).length, 3);
});

test("U6: a conflicting writer that already set the target means no second request", async () => {
  const host = hostWithCube();
  const result = await run(host, { hooks: { beforeSubmit: () => host.external(ID, MATERIAL, { baseColor: [...RED] }) } });
  assert.equal(result.exitCode, 0);
  assert.equal(componentFrames(host).length, 1);
  assert.equal(find(result, "intent.resolved")[0]!.resolution, "satisfied-after-conflict");
});

test("U7a (C12): lost reply after commit -> reconnect, fresh snapshot shows the target, the request is never re-sent", async () => {
  const host = hostWithCube();
  host.mutate = () => ({ kind: "commit-and-drop", code: 1011 });
  const result = await run(host);
  assert.equal(result.exitCode, 0);
  assert.equal(host.sockets.length, 2);
  assert.deepEqual(host.typesOf(2), HANDSHAKE);
  assert.equal(componentFrames(host).length, 1);
  const uncertain = find(result, "request.uncertain")[0]!;
  assert.equal(uncertain.requestId, componentFrames(host)[0]!.id);
  assert.equal(find(result, "intent.resolved")[0]!.resolution, "satisfied-after-uncertain");
  assert.deepEqual(find(result, "entity.observed").map((event) => event.reason), ["subscribed", "after-reconnect"]);
  assert.equal(host.entities.get(ID)!.components[MATERIAL].revision, 2);
  assert.deepEqual(find(result, "session.closed")[0]!.uncertainRequestIds, [uncertain.requestId]);
});

test("U7b (C12): request lost before the host -> reconnect, target unmet, a NEW request ID with the current revision", async () => {
  const host = hostWithCube();
  host.mutate = (_frame, index) => (index === 0 ? { kind: "drop", code: 1006 } : { kind: "commit" });
  const result = await run(host);
  assert.equal(result.exitCode, 0);
  const frames = componentFrames(host);
  assert.equal(frames.length, 2);
  assert.notEqual(frames[0]!.id, frames[1]!.id);
  assert.deepEqual(frames.map((frame) => frame.body.baseRevision), [1, 1]);
  assert.deepEqual(host.typesOf(2), [...HANDSHAKE, "component.set"]);
  assert.equal(host.received.filter((entry) => entry.frame.id === frames[0]!.id).length, 1);
  assert.equal(find(result, "intent.resolved")[0]!.resolution, "committed");
  assert.equal(host.entities.get(ID)!.components[MATERIAL].revision, 2);
});

test("U7: a reconnect uses the current revision when the world moved while the agent was away", async () => {
  const host = hostWithCube();
  host.mutate = (_frame, index) => {
    if (index === 0) { host.external(ID, "hvtp.transform@1", { position: [9, 0.5, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }); host.external(ID, MATERIAL, { baseColor: [...BLUE] }); return { kind: "drop" }; }
    return { kind: "commit" };
  };
  const result = await run(host);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(componentFrames(host).map((frame) => frame.body.baseRevision), [1, 2]);
});

test("U7: uncertainty that never resolves exhausts the attempts without replaying the request", async () => {
  const host = hostWithCube();
  host.mutate = () => ({ kind: "drop" });
  const result = await run(host);
  assert.deepEqual([result.outcome, result.exitCode], ["exhausted", 5]);
  const ids = componentFrames(host).map((frame) => frame.id);
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 3);
});

for (const code of ["entity_not_found", "not_authorized", "invalid_component_state"]) {
  test(`U8: terminal ${code} exits 4 without retry`, async () => {
    const host = hostWithCube();
    host.mutate = () => ({ kind: "error", code });
    const result = await run(host);
    assert.deepEqual([result.outcome, result.exitCode], ["rejected", 4]);
    assert.equal(componentFrames(host).length, 1);
    assert.equal(find(result, "request.rejected")[0]!.code, code);
  });
}

test("U9: an entity that never enters the view exits 3 and sends no mutation", async () => {
  const host = new ScriptedHost();
  const result = await run(host, { timeoutMs: 30 });
  assert.deepEqual([result.outcome, result.exitCode], ["entity-not-visible", 3]);
  assert.deepEqual(host.typesOf(1), HANDSHAKE);
});

test("U10: a protocol violation exits 7 and does not reconnect", async () => {
  const host = hostWithCube();
  host.garbageOnHello = "this is not json";
  const result = await run(host);
  assert.deepEqual([result.outcome, result.exitCode], ["protocol-violation", 7]);
  assert.equal(host.sockets.length, 1);
  assert.equal(find(result, "protocol.violation").length, 1);
});

test("U11: connection failures are bounded by the reconnect budget (exit 6)", async () => {
  const host = hostWithCube();
  host.refuseConnections = 100;
  const delays: number[] = [];
  let before = 0;
  const result = await run(host, {
    reconnect: { attempts: 2, delayMs: 7 }, delay: async (ms) => { delays.push(ms); },
    hooks: { beforeReconnect: () => { before++; } },
  });
  assert.deepEqual([result.outcome, result.exitCode], ["connection-failed", 6]);
  assert.equal(host.refuseConnections, 100 - 3);
  assert.deepEqual(delays, [7, 7]);
  assert.equal(before, 2);
});

test("a transient connection failure is retried within the budget", async () => {
  const host = hostWithCube();
  host.refuseConnections = 1;
  const result = await run(host);
  assert.equal(result.exitCode, 0);
});

const FIXTURE = JSON.stringify({ asset: { version: "2.0" }, nodes: [{ name: "UnitCube" }] });
const asset = (body: BodyInit | null, init: ResponseInit) => async () => new Response(body, init);
const GLTF = { "content-type": "model/gltf+json" };
const assetCases: Array<[string, NonNullable<P1AgentOptions["fetch"]>, RegExp]> = [
  ["redirect", asset(null, { status: 302, headers: { location: "http://elsewhere/x" } }), /redirect refused/],
  ["404", asset("nope", { status: 404 }), /status 404/],
  ["wrong media type", asset(FIXTURE, { status: 200, headers: { "content-type": "application/json" } }), /media type/],
  ["oversize", asset(FIXTURE, { status: 200, headers: { ...GLTF, "content-length": "99999999" } }), /exceeds maxAssetBytes/],
  ["external buffer", asset(JSON.stringify({ nodes: [{ name: "UnitCube" }], buffers: [{ uri: "x.bin" }] }), { status: 200, headers: GLTF }), /external resource/],
  ["missing node", asset(JSON.stringify({ nodes: [{ name: "Other" }] }), { status: 200, headers: GLTF }), /no node named/],
];
for (const [name, fetch, reason] of assetCases) {
  test(`U12: asset ${name} is a local failure only: frames and exit code are unchanged`, async () => {
    const host = hostWithCube();
    const result = await run(host, { assetCheck: true, fetch, intents: [] });
    assert.equal(result.exitCode, 0);
    const checked = find(result, "asset.checked")[0]!;
    assert.equal(checked.ok, false);
    assert.match(String(checked.reason), reason);
    assert.deepEqual(host.typesOf(1), HANDSHAKE);
  });
}

test("U12: a valid fixture is reported with the URL resolved against the advertised assetBaseUri", async () => {
  const host = hostWithCube();
  const urls: string[] = [];
  const result = await run(host, { assetCheck: true, intents: [], fetch: async (url) => { urls.push(url); return new Response(FIXTURE, { status: 200, headers: GLTF }); } });
  assert.deepEqual(urls, ["http://127.0.0.1:8787/assets/p1/unit-cube.gltf"]);
  const checked = find(result, "asset.checked")[0]!;
  assert.deepEqual([checked.ok, checked.url, checked.bytes], [true, urls[0], FIXTURE.length]);
});

test("--trace-wire emits every frame, including the agent kind in hello", async () => {
  const host = hostWithCube();
  const result = await run(host, { traceWire: true, intents: [] });
  const out = find(result, "wire.out").map((event) => (event.frame as { type: string }).type);
  assert.deepEqual(out, HANDSHAKE);
  const hello = find(result, "wire.out")[0]!.frame as { body: { participant: { kind: string } } };
  assert.equal(hello.body.participant.kind, "agent");
  assert.ok(find(result, "wire.in").length >= 5);
});

test("a throwing event sink never affects the run", async () => {
  const host = hostWithCube();
  const result = await run(host, { intents: [], onEvent: () => { throw new Error("sink failure"); } });
  assert.equal(result.exitCode, 0);
});

// --- bounded waits (every network step races timeoutMs) ---

test("T1 (C12): a never-answered mutation times out, becomes uncertain, reconnects, and is resolved from canonical state without a resend", async () => {
  const host = hostWithCube();
  host.mutate = (_frame, index) => (index === 0 ? { kind: "ignore" } : { kind: "commit" });
  const result = await run(host, { timeoutMs: 50 });
  assert.equal(result.exitCode, 0);
  const timeout = find(result, "step.timeout")[0]!;
  assert.deepEqual([timeout.step, timeout.requestId], ["request", componentFrames(host)[0]!.id]);
  assert.equal(find(result, "request.uncertain")[0]!.requestId, componentFrames(host)[0]!.id);
  const frames = componentFrames(host);
  assert.equal(frames.length, 2);
  assert.notEqual(frames[0]!.id, frames[1]!.id);
  assert.deepEqual(host.typesOf(2), [...HANDSHAKE, "component.set"]);
  assert.equal(host.received.filter((entry) => entry.frame.id === frames[0]!.id).length, 1);
});

test("T1: a never-answered mutation that did not commit exhausts the attempts without resending an ID", async () => {
  const host = hostWithCube();
  host.mutate = () => ({ kind: "ignore" });
  const result = await run(host, { timeoutMs: 30 });
  assert.deepEqual([result.outcome, result.exitCode], ["exhausted", 5]);
  assert.equal(new Set(componentFrames(host).map((frame) => frame.id)).size, 3);
});

test("T2: a host that never sends session.welcome is bounded and exits 6 after the reconnect budget", async () => {
  const host = hostWithCube();
  host.silentHellos = 100;
  const result = await run(host, { timeoutMs: 30, reconnect: { attempts: 2, delayMs: 0 } });
  assert.deepEqual([result.outcome, result.exitCode], ["connection-failed", 6]);
  assert.equal(host.sockets.length, 3);
  assert.deepEqual(find(result, "step.timeout").map((event) => event.step), ["connect", "connect", "connect"]);
});

test("T2: a handshake stall counts against the budget and a later attempt can succeed", async () => {
  const host = hostWithCube();
  host.silentHellos = 1;
  const result = await run(host, { timeoutMs: 30, intents: [] });
  assert.equal(result.exitCode, 0);
  assert.equal(host.sockets.length, 2);
});

test("T3: a never-answered subscription.set times out, reconnects, and succeeds on the next session", async () => {
  const host = hostWithCube();
  host.silentSubscriptions = 1;
  const result = await run(host, { timeoutMs: 50, intents: [] });
  assert.equal(result.exitCode, 0);
  assert.equal(find(result, "step.timeout")[0]!.step, "subscription.set");
  assert.equal(host.framesOf("subscription.set").length, 2);
  assert.deepEqual(new Set(host.framesOf("subscription.set").map((frame) => frame.id)).size, 2);
});

test("T4: a stalled asset body is a local failure and the run continues", async () => {
  const host = hostWithCube();
  const stalled = async () => new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) }), { status: 200, headers: GLTF });
  const result = await run(host, { assetCheck: true, fetch: stalled, timeoutMs: 50 });
  assert.equal(result.exitCode, 0);
  const checked = find(result, "asset.checked")[0]!;
  assert.equal(checked.ok, false);
  assert.match(String(checked.reason), /timed out/);
  assert.equal(componentFrames(host).length, 1);
});

test("m1: a local refusal while the session is still LIVE is terminal, not retried", async () => {
  const host = hostWithCube();
  host.limits = { maxMessageBytes: 200 };
  const result = await run(host);
  assert.deepEqual([result.outcome, result.exitCode], ["rejected", 4]);
  assert.match(String(find(result, "result")[0]!.message), /refused locally/);
  assert.equal(host.sockets.length, 1);
  assert.equal(componentFrames(host).length, 0);
});

test("m2: an ACK whose confirming publication never arrives is reported as entity.unconfirmed and stays committed", async () => {
  const host = hostWithCube();
  host.omitOwnPublication = true;
  const result = await run(host, { timeoutMs: 50 });
  assert.equal(result.exitCode, 0);
  const unconfirmed = find(result, "entity.unconfirmed")[0]!;
  assert.deepEqual([unconfirmed.revision, unconfirmed.reason], [2, "timeout"]);
  assert.equal(find(result, "intent.resolved")[0]!.resolution, "committed");
  assert.equal(componentFrames(host).length, 1);
});
