import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createReferenceHost, type ReferenceHost } from "@hvtp/reference-host";
import { runAgent, type P1AgentOptions, type P1AgentResult } from "./index.js";
import {
  ID, MATERIAL, recordingFactory, seedObserver, shared, tempDatabase, TRANSFORM, until, withHost, wsUrl, type RecordedSocket,
} from "./test-host.js";

const RED = [1, 0, 0, 1] as const;
const BLUE = [0, 0, 1, 1] as const;
const HANDSHAKE = ["session.hello", "realm.join", "subscription.set"];

const run = (host: ReferenceHost, extra: Partial<P1AgentOptions> = {}): Promise<P1AgentResult> =>
  runAgent({ url: wsUrl(host), entityId: ID, intents: [{ kind: "material", baseColor: RED }], timeoutMs: 5_000, ...extra });
const find = (result: P1AgentResult, name: string) => result.events.filter((event) => event.event === name);
const types = (socket: RecordedSocket) => socket.frames.map((frame) => frame.type as string);
const mutationFrames = (sockets: RecordedSocket[]) => sockets.flatMap((socket) => socket.frames).filter((frame) => String(frame.type).startsWith("component."));

test("I1: the agent subscribes, reads structured state, mutates, and a second client observes it", async () => {
  await withHost({}, async (host) => {
    const observer = await seedObserver(host);
    try {
      const { factory, sockets } = recordingFactory();
      const result = await run(host, { socketFactory: factory, traceWire: true });
      assert.equal(result.exitCode, 0, JSON.stringify(result.events.at(-1)));
      const live = find(result, "session.live")[0]!;
      assert.deepEqual([live.participantKind, live.snapshotEntityCount, live.realmEpoch], ["agent", 1, host.realmEpoch]);
      assert.equal(live.assetBaseUri, `http://${host.host}:${host.port}/assets/p1/`);
      assert.deepEqual(types(sockets[0]!), [...HANDSHAKE, "component.set"]);
      assert.deepEqual(sockets[0]!.frames[1]!.body.subscription, {});
      assert.deepEqual(sockets[0]!.frames[2]!.body, { entities: [ID] });
      const enter = find(result, "wire.in").map((event) => event.frame as { type: string; body: { reason?: string } }).find((frame) => frame.type === "view.entity.enter");
      assert.equal(enter?.body.reason, "subscription");
      const observed = find(result, "entity.observed")[0]!.entity as { components: Record<string, { revision: number; authorityEpoch: number }> };
      assert.equal(observed.components[MATERIAL]!.revision, 1);
      assert.equal(find(result, "asset.checked")[0]!.ok, true);
      assert.equal(find(result, "asset.checked")[0]!.url, `http://${host.host}:${host.port}/assets/p1/unit-cube.gltf`);
      const committed = find(result, "request.committed")[0]!;
      assert.equal(committed.revision, 2);
      await until(observer.client, () => shared(observer.client, ID)?.components[MATERIAL].revision === 2, "observer sees the agent's change");
      assert.deepEqual(shared(observer.client, ID)!.components[MATERIAL].state.baseColor, [1, 0, 0, 1]);
      assert.deepEqual(host.worldStore.getEntity(ID)!.components[MATERIAL].state.baseColor, [1, 0, 0, 1]);
    } finally {
      observer.client.disconnect();
    }
  });
});

test("I2: a concurrent writer causes revision_mismatch; the agent retries with a new request ID and the current revision", async () => {
  await withHost({}, async (host) => {
    const observer = await seedObserver(host);
    try {
      const { factory, sockets } = recordingFactory();
      const result = await run(host, {
        socketFactory: factory,
        hooks: { beforeSubmit: async ({ attempt }) => { if (attempt === 1) await observer.client.setComponent(ID, MATERIAL, { baseColor: [...BLUE] }); } },
      });
      assert.equal(result.exitCode, 0);
      const frames = mutationFrames(sockets);
      assert.equal(frames.length, 2);
      assert.notEqual(frames[0]!.id, frames[1]!.id);
      assert.deepEqual(frames.map((frame) => frame.body.baseRevision), [1, 2]);
      const rejected = find(result, "request.rejected")[0]!;
      assert.deepEqual([rejected.code, rejected.currentRevision], ["revision_mismatch", 2]);
      assert.equal(find(result, "request.committed")[0]!.revision, 3);
      assert.deepEqual(host.worldStore.getEntity(ID)!.components[MATERIAL].state.baseColor, [1, 0, 0, 1]);
    } finally {
      observer.client.disconnect();
    }
  });
});

test("I2: when the concurrent writer already set the target, the agent sends nothing further", async () => {
  await withHost({}, async (host) => {
    const observer = await seedObserver(host);
    try {
      const { factory, sockets } = recordingFactory();
      const result = await run(host, {
        socketFactory: factory,
        hooks: { beforeSubmit: async () => { await observer.client.setComponent(ID, MATERIAL, { baseColor: [...RED] }); } },
      });
      assert.equal(result.exitCode, 0);
      assert.equal(mutationFrames(sockets).length, 1);
      assert.equal(find(result, "intent.resolved")[0]!.resolution, "satisfied-after-conflict");
    } finally {
      observer.client.disconnect();
    }
  });
});

test("I3 (C12): lost reply after a durable commit -> reconnect, target already met, the request is NOT re-sent", async () => {
  let armed = false;
  await withHost({ afterDurableCommit: () => { if (armed) { armed = false; throw new Error("injected lost reply"); } } }, async (host) => {
    const observer = await seedObserver(host);
    try {
      const seqBefore = host.worldStore.getRealmSeq();
      const { factory, sockets } = recordingFactory();
      const result = await run(host, { socketFactory: factory, hooks: { beforeSubmit: () => { armed = true; } }, reconnect: { attempts: 3, delayMs: 0 } });
      assert.equal(result.exitCode, 0, JSON.stringify(result.events.at(-1)));
      const [first, second] = find(result, "session.live");
      assert.equal(first!.realmEpoch, second!.realmEpoch);
      assert.equal(find(result, "session.closed")[0]!.code, 1011);
      const sent = find(result, "request.sent")[0]!;
      assert.equal(find(result, "request.uncertain")[0]!.requestId, sent.requestId);
      assert.equal(find(result, "request.committed").length, 0);
      assert.equal(find(result, "intent.resolved")[0]!.resolution, "satisfied-after-uncertain");
      const reobserved = find(result, "entity.observed").at(-1)!;
      assert.equal(reobserved.reason, "after-reconnect");
      assert.equal((reobserved.entity as { components: Record<string, { revision: number }> }).components[MATERIAL]!.revision, 2);
      assert.equal(sockets.length, 2);
      assert.deepEqual(types(sockets[1]!), HANDSHAKE);
      assert.equal(mutationFrames(sockets).length, 1);
      assert.equal(sockets.flatMap((socket) => socket.frames).filter((frame) => frame.id === sent.requestId).length, 1);
      assert.equal(host.worldStore.getRealmSeq(), seqBefore + 1);
      assert.equal(host.worldStore.getEntity(ID)!.components[MATERIAL].revision, 2);
      await until(observer.client, () => shared(observer.client, ID)?.components[MATERIAL].revision === 2, "observer sees the commit");
      assert.equal(observer.updates(), 1);
    } finally {
      observer.client.disconnect();
    }
  });
});

test("I4 (C12): request lost before reaching the host -> reconnect, target unmet, a NEW request ID with the current revision", async () => {
  await withHost({}, async (host) => {
    const observer = await seedObserver(host);
    try {
      const seqBefore = host.worldStore.getRealmSeq();
      let dropped = false;
      const { factory, sockets } = recordingFactory({ swallow: (frame) => !dropped && String(frame.type).startsWith("component.") && (dropped = true) });
      const result = await run(host, { socketFactory: factory, reconnect: { attempts: 3, delayMs: 0 } });
      assert.equal(result.exitCode, 0, JSON.stringify(result.events.at(-1)));
      const frames = mutationFrames(sockets);
      assert.equal(frames.length, 2);
      assert.notEqual(frames[0]!.id, frames[1]!.id);
      assert.deepEqual(frames.map((frame) => frame.body.baseRevision), [1, 1]);
      assert.equal(find(result, "request.uncertain")[0]!.requestId, frames[0]!.id);
      assert.equal(find(result, "intent.resolved")[0]!.resolution, "committed");
      assert.equal(host.worldStore.getRealmSeq(), seqBefore + 1);
      assert.equal(host.worldStore.getEntity(ID)!.components[MATERIAL].revision, 2);
      await until(observer.client, () => shared(observer.client, ID)?.components[MATERIAL].revision === 2, "observer sees the commit");
      assert.equal(observer.updates(), 1);
    } finally {
      observer.client.disconnect();
    }
  });
});

test("I5 (C12 + C20): the host restarts while the outcome is uncertain -> new epoch, no replay, durable state recovered", async () => {
  const database = tempDatabase();
  let armed = false;
  let first = (await createReferenceHost({
    databasePath: database.path,
    afterDurableCommit: () => { if (armed) { armed = false; throw new Error("injected lost reply"); } },
  })) as ReferenceHost | null;
  const port = first!.port;
  const firstEpoch = first!.realmEpoch;
  let second = null as ReferenceHost | null;
  try {
    const observer = await seedObserver(first!);
    observer.client.disconnect();
    const { factory, sockets } = recordingFactory();
    const result = await runAgent({
      url: wsUrl(first!), entityId: ID, intents: [{ kind: "material", baseColor: RED }], timeoutMs: 5_000, socketFactory: factory,
      reconnect: { attempts: 5, delayMs: 0 },
      hooks: {
        beforeSubmit: () => { armed = true; },
        beforeReconnect: async () => {
          if (second !== null) return;
          await first!.close();
          first = null;
          second = await createReferenceHost({ databasePath: database.path, port });
        },
      },
    });
    assert.equal(result.exitCode, 0, JSON.stringify(result.events.at(-1)));
    const [one, two] = find(result, "session.live");
    assert.equal(one!.realmEpoch, firstEpoch);
    assert.equal(two!.realmEpoch, second!.realmEpoch);
    assert.notEqual(two!.realmEpoch, firstEpoch);
    assert.notEqual(one!.participantId, two!.participantId);
    assert.equal(find(result, "intent.resolved")[0]!.resolution, "satisfied-after-uncertain");
    assert.equal(mutationFrames(sockets).length, 1);
    assert.deepEqual(types(sockets[1]!), HANDSHAKE);
    assert.deepEqual(second!.worldStore.getEntity(ID)!.components[MATERIAL].state.baseColor, [1, 0, 0, 1]);
    assert.equal(second!.worldStore.getEntity(ID)!.components[MATERIAL].revision, 2);
  } finally {
    await first?.close();
    await second?.close();
    database.remove();
  }
});

test("I6: a host that stays down exhausts the reconnect budget (exit 6)", async () => {
  const host = await createReferenceHost({ databasePath: ":memory:" });
  const url = wsUrl(host);
  await host.close();
  const result = await runAgent({ url, entityId: ID, reconnect: { attempts: 2, delayMs: 5 }, timeoutMs: 1_000 });
  assert.deepEqual([result.outcome, result.exitCode], ["connection-failed", 6]);
});

test("I7: an absent entity exits 3 after the explicit subscription and sends no mutation", async () => {
  await withHost({}, async (host) => {
    const { factory, sockets } = recordingFactory();
    const result = await run(host, { socketFactory: factory, timeoutMs: 300 });
    assert.deepEqual([result.outcome, result.exitCode], ["entity-not-visible", 3]);
    assert.deepEqual(types(sockets[0]!), HANDSHAKE);
  });
});

test("I8: an entity deleted inside the submit window is a terminal rejection (exit 4), not retried", async () => {
  await withHost({}, async (host) => {
    const observer = await seedObserver(host);
    try {
      const { factory, sockets } = recordingFactory();
      const result = await run(host, { socketFactory: factory, hooks: { beforeSubmit: async () => { await observer.client.deleteEntity(ID); } } });
      assert.deepEqual([result.outcome, result.exitCode], ["rejected", 4]);
      assert.equal(find(result, "request.rejected")[0]!.code, "entity_not_found");
      assert.equal(mutationFrames(sockets).length, 1);
    } finally {
      observer.client.disconnect();
    }
  });
});

test("position intent: component.patch of the transform is observed by the second client", async () => {
  await withHost({}, async (host) => {
    const observer = await seedObserver(host);
    try {
      const result = await run(host, { intents: [{ kind: "position", position: [-2, 0.5, 0] }] });
      assert.equal(result.exitCode, 0);
      await until(observer.client, () => shared(observer.client, ID)?.components[TRANSFORM].revision === 2, "observer sees the move");
      assert.deepEqual(shared(observer.client, ID)!.components[TRANSFORM].state.position, [-2, 0.5, 0]);
    } finally {
      observer.client.disconnect();
    }
  });
});

// --- C34: the fixture is resolved against the host-advertised assetBaseUri and fetched under the shared policy ---

function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

async function assetScenario(handler: Parameters<typeof createServer>[1], expectedReason: RegExp): Promise<void> {
  await withHost({}, async (host) => {
    const observer = await seedObserver(host);
    const { server, port } = await listen(handler);
    try {
      const requested: string[] = [];
      const { factory, sockets } = recordingFactory();
      const result = await run(host, {
        socketFactory: factory, intents: [],
        // Redirect only the network location; the URL the agent resolved is recorded first.
        fetch: (url, init) => { requested.push(url); return globalThis.fetch(`http://127.0.0.1:${port}/assets/p1/unit-cube.gltf`, init); },
      });
      assert.equal(result.exitCode, 0);
      assert.deepEqual(requested, [`http://${host.host}:${host.port}/assets/p1/unit-cube.gltf`]);
      const checked = find(result, "asset.checked")[0]!;
      assert.equal(checked.ok, false);
      assert.match(String(checked.reason), expectedReason);
      assert.deepEqual(types(sockets[0]!), HANDSHAKE);
    } finally {
      observer.client.disconnect();
      server.closeAllConnections();
      server.close();
    }
  });
}

test("C34: a real HTTP redirect for the fixture is refused locally and mutates nothing", async () => {
  await assetScenario((_req, res) => { res.writeHead(302, { location: "http://127.0.0.1:9/elsewhere" }); res.end(); }, /redirect refused \(status 302\)/);
});

test("C34: a fixture whose declared size exceeds the host-advertised maxAssetBytes is refused", async () => {
  await assetScenario((_req, res) => { res.writeHead(200, { "content-type": "model/gltf+json", "content-length": "6000000" }); res.flushHeaders(); }, /declared size 6000000 exceeds maxAssetBytes 5242880/);
});

test("C34: a streamed fixture that exceeds maxAssetBytes is cut off at the bound", async () => {
  await assetScenario((_req, res) => {
    res.writeHead(200, { "content-type": "model/gltf+json" });
    const chunk = Buffer.alloc(256 * 1024);
    const pump = () => { while (!res.destroyed && res.write(chunk)) { /* fill the socket buffer */ } if (!res.destroyed) res.once("drain", pump); };
    pump();
  }, /body exceeds maxAssetBytes 5242880/);
});
