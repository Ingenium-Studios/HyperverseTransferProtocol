import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import type { P1SharedEntity, SubscriptionSelector } from "@hvtp/protocol-types";
import { createReferenceHost, type ReferenceHost, type ReferenceHostOptions } from "@hvtp/reference-host";
import { P1Client, P1OutcomeUncertainError, type P1Socket } from "./index.js";

/** Real `ws` sockets; every client frame is recorded so tests can prove no request ID is replayed. */
function clientFor(host: ReferenceHost, subscription: SubscriptionSelector, sent: string[] = []): P1Client {
  return new P1Client({
    url: `ws://${host.host}:${host.port}/hvtp`,
    subscription,
    clientName: "client-core-integration",
    socketFactory: (url) => {
      const socket = new WebSocket(url);
      const send = socket.send.bind(socket);
      (socket as { send: (data: string) => void }).send = (data: string) => { sent.push(data); send(data); };
      return socket as unknown as P1Socket;
    },
  });
}

/** Resolves once `predicate` holds, re-checking after every client event. */
function until(client: P1Client, predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error(`Timed out waiting for ${label}`)); }, timeoutMs);
    const off = client.on(() => {
      if (!predicate()) return;
      clearTimeout(timer);
      off();
      resolve();
    });
  });
}

const shared = (client: P1Client, id: string) => client.entities.get(id) as P1SharedEntity | undefined;
const nearOrigin: SubscriptionSelector = { spatial: { center: [0, 0, 0], radius: 100 } };
const cubeInput = (id: string, x = 0) => ({
  id,
  transform: { position: [x, 0.5, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] },
  material: { baseColor: [1, 1, 1, 1] as [number, number, number, number] },
});

async function withHost(options: ReferenceHostOptions, run: (host: ReferenceHost) => Promise<void>): Promise<void> {
  const host = await createReferenceHost({ databasePath: ":memory:", ...options });
  try {
    await run(host);
  } finally {
    await host.close();
  }
}

test("two real clients share create, move, and recolor through the reference host (happy path 1–9)", async () => {
  await withHost({}, async (host) => {
    const a = clientFor(host, nearOrigin);
    const b = clientFor(host, nearOrigin);
    await a.connect();
    await b.connect();
    try {
      assert.equal(a.phase, "live");
      assert.equal(a.realmEpoch, host.realmEpoch);
      assert.equal(a.assetBaseUri, `http://${host.host}:${host.port}/assets/p1/`);
      // Each client sees only its own presence.
      assert.deepEqual([...a.entities.keys()], [a.presenceEntityId]);
      assert.deepEqual([...b.entities.keys()], [b.presenceEntityId]);

      const created = await a.createEntity(cubeInput("entity:int-cube"));
      assert.deepEqual([created.status, created.entityId], ["committed", "entity:int-cube"]);
      await until(b, () => b.entities.has("entity:int-cube"), "B materializes creation");
      const seenByB = shared(b, "entity:int-cube")!;
      assert.deepEqual(seenByB.components["hvtp.renderable@1"].state,
        { asset: { uri: "unit-cube.gltf", mediaType: "model/gltf+json" }, node: "UnitCube", visible: true });
      assert.equal(seenByB.components["hvtp.transform@1"].revision, 1);

      await until(a, () => a.entities.has("entity:int-cube"), "A sees its own creation");
      const moved = await a.patchComponent("entity:int-cube", "hvtp.transform@1", { position: [2, 0.5, 0] });
      assert.equal(moved.revision, 2);
      await until(b, () => shared(b, "entity:int-cube")?.components["hvtp.transform@1"].revision === 2, "B sees move");
      assert.deepEqual(shared(b, "entity:int-cube")!.components["hvtp.transform@1"].state.position, [2, 0.5, 0]);

      const recolored = await b.setComponent("entity:int-cube", "hvtp.material@1", { baseColor: [0.25, 0.5, 0.75, 1] });
      assert.equal(recolored.revision, 2);
      await until(a, () => shared(a, "entity:int-cube")?.components["hvtp.material@1"].revision === 2, "A sees recolor");
      const final = shared(a, "entity:int-cube")!;
      assert.deepEqual(final.components["hvtp.material@1"].state.baseColor, [0.25, 0.5, 0.75, 1]);
      assert.equal(final.components["hvtp.transform@1"].revision, 2);
      assert.equal(final.components["hvtp.renderable@1"].revision, 1);
      assert.deepEqual(final, shared(b, "entity:int-cube"));

      await b.deleteEntity("entity:int-cube");
      await until(a, () => !a.entities.has("entity:int-cube"), "A sees deletion");
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });
});

test("C13: a move that evicts the requester's own view resolves from the ack; the other view keeps it", async () => {
  await withHost({}, async (host) => {
    const a = clientFor(host, { spatial: { center: [0, 0, 0], radius: 10 } });
    const b = clientFor(host, nearOrigin);
    await a.connect();
    await b.connect();
    try {
      await a.createEntity(cubeInput("entity:wander"));
      await until(a, () => a.entities.has("entity:wander"), "A sees creation");
      await until(b, () => b.entities.has("entity:wander"), "B sees creation");
      const left = until(a, () => !a.entities.has("entity:wander"), "A view leave");
      const ackBody = await a.patchComponent("entity:wander", "hvtp.transform@1", { position: [50, 0.5, 0] });
      assert.equal(ackBody.revision, 2);
      await left;
      await until(b, () => shared(b, "entity:wander")?.components["hvtp.transform@1"].revision === 2, "B sees move");
      assert.equal(a.phase, "live");
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });
});

test("C28: serialized subscription replacements on the real host end on the newest generation", async () => {
  await withHost({}, async (host) => {
    const a = clientFor(host, nearOrigin);
    await a.connect();
    try {
      await a.createEntity(cubeInput("entity:e"));
      await until(a, () => a.entities.has("entity:e"), "E visible");
      const s0 = a.subscriptionId;
      const [s1, s2] = await Promise.all([a.setSubscription({}), a.setSubscription({ entities: ["entity:e"] })]);
      assert.deepEqual([s1.activated, s2.activated], [true, true]);
      assert.equal(s1.body.previousSubscriptionId, s0);
      assert.equal(s2.body.previousSubscriptionId, s1.body.subscriptionId);
      await until(a, () => a.entities.has("entity:e"), "E re-entered under S2");
      assert.equal(a.subscriptionId, s2.body.subscriptionId);
      assert.deepEqual(a.effectiveSubscription, { entities: ["entity:e"] });
    } finally {
      a.disconnect();
    }
  });
});

test("host restart: fresh sessions take fresh snapshots in a new epoch; an uncertain write is never replayed", async () => {
  const dir = mkdtempSync(joinPath(tmpdir(), "hvtp-client-restart-"));
  const databasePath = joinPath(dir, "world.sqlite");
  const sentByA: string[] = [];
  let dropAfterCommit = false;
  let first: ReferenceHost | null = await createReferenceHost({
    databasePath,
    // Lost-reply seam: after the durable commit but before the ACK, kill every connection.
    afterDurableCommit: () => { if (dropAfterCommit) for (const socket of first!.wsServer.clients) socket.terminate(); },
  });
  const port = first.port;
  let second: ReferenceHost | null = null;
  try {
    const a = clientFor(first, nearOrigin, sentByA);
    const b = clientFor(first, nearOrigin);
    await a.connect();
    await b.connect();
    const firstEpoch = a.realmEpoch;

    await a.createEntity(cubeInput("entity:durable"));
    await until(b, () => b.entities.has("entity:durable"), "B sees creation");
    await a.patchComponent("entity:durable", "hvtp.transform@1", { position: [3, 0.5, 0] }, { baseRevision: 1, authorityEpoch: 1 });
    await b.setComponent("entity:durable", "hvtp.material@1", { baseColor: [0.25, 0.5, 0.75, 1] }, { baseRevision: 1, authorityEpoch: 1 });
    await until(a, () => shared(a, "entity:durable")?.components["hvtp.material@1"].revision === 2, "A sees recolor");

    // C12: the host commits revision 3 but the connection dies before A receives the ACK.
    dropAfterCommit = true;
    const lostMove = a.patchComponent("entity:durable", "hvtp.transform@1", { position: [4, 0.5, 0] });
    const lostRequestId = (JSON.parse(sentByA.at(-1)!) as { id: string }).id;
    await assert.rejects(lostMove, (error: unknown) => error instanceof P1OutcomeUncertainError && error.requestId === lostRequestId);
    await until(b, () => b.phase === "disconnected", "B disconnected");
    assert.equal(a.entities.size, 0);
    assert.equal(b.entities.size, 0);

    await first.close();
    first = null;
    second = await createReferenceHost({ databasePath, port });
    const sentBefore = sentByA.length;
    await a.connect();
    await b.connect();
    try {
      assert.notEqual(a.realmEpoch, firstEpoch);
      assert.equal(a.realmEpoch, second.realmEpoch);
      assert.equal(b.realmEpoch, second.realmEpoch);
      for (const client of [a, b]) {
        const cube = shared(client, "entity:durable")!;
        // The uncertain move did commit; only the fresh snapshot reveals it.
        assert.equal(cube.components["hvtp.transform@1"].revision, 3);
        assert.deepEqual(cube.components["hvtp.transform@1"].state.position, [4, 0.5, 0]);
        assert.equal(cube.components["hvtp.material@1"].revision, 2);
        assert.deepEqual(cube.components["hvtp.material@1"].state.baseColor, [0.25, 0.5, 0.75, 1]);
      }
      const newFrames = sentByA.slice(sentBefore).map((text) => JSON.parse(text) as { id: string; type: string });
      assert.deepEqual(newFrames.map((frame) => frame.type), ["session.hello", "realm.join"]);
      assert.equal(sentByA.filter((text) => text.includes(lostRequestId)).length, 1);

      // A new mutation needs a new ID and the current revision.
      const next = await a.patchComponent("entity:durable", "hvtp.transform@1", { position: [5, 0.5, 0] });
      assert.equal(next.revision, 4);
      assert.notEqual(next.ref, lostRequestId);
      await until(b, () => shared(b, "entity:durable")?.components["hvtp.transform@1"].revision === 4, "B sees new move");
    } finally {
      a.disconnect();
      b.disconnect();
    }
  } finally {
    await first?.close();
    await second?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
