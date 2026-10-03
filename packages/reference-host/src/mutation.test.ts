import assert from "node:assert/strict";
import test from "node:test";
import WebSocket, { type RawData } from "ws";
import { randomUUID } from "node:crypto";
import { createReferenceHost, type ReferenceHost } from "./server.js";

const realm = "urn:hvtp:realm:prototype-world";
const hello = JSON.stringify({
  hvtp: "0.2", id: "req-hello-test", type: "session.hello",
  body: {
    versions: ["0.2"], client: { name: "test", version: "1" }, participant: { kind: "agent" },
    capabilities: { components: ["hvtp.transform@1", "hvtp.renderable@1", "hvtp.material@1", "hvtp.presence@1"] },
  },
});

test("real WebSocket mutations deduplicate, publish visibility transitions, and preserve sequence", async () => {
  const host = await createReferenceHost({ databasePath: ":memory:" });
  const sockets: WebSocket[] = [];
  try {
    const observer = await join(host, { spatial: { center: [0, 0, 0], radius: 10 } }, sockets);
    const requester = await join(host, {}, sockets);
    const createAck = (await sendAndCollect(requester, create("req-create", "entity:wire", 20), 1))[0]!;
    assert.equal(createAck.type, "ack");
    assert.deepEqual(host.worldStore.getEntity("entity:wire")?.components["hvtp.transform@1"].state.position, [20, 0, 0]);

    const enteringPublication = receiveOne(observer);
    const enterRequest = await sendAndCollect(requester, setTransform("req-enter", "entity:wire", 1, 5), 1);
    assert.equal(enterRequest[0]?.type, "ack");
    const enter = await enteringPublication;
    assert.equal(enter.type, "view.entity.enter");
    const enterBody = enter.body as Record<string, unknown>;
    assert.equal(typeof enterBody.subscriptionId, "string");
    const enteredEntity = enterBody.entity as { id: string; components: Record<string, { revision: number; state: Record<string, unknown> }> };
    assert.equal(enteredEntity.id, "entity:wire");
    assert.equal(enteredEntity.components["hvtp.transform@1"]?.revision, 2);
    assert.deepEqual(enteredEntity.components["hvtp.transform@1"]?.state.position, [5, 0, 0]);

    const updatePublication = receiveOne(observer);
    const staying = await sendAndCollect(requester, setTransform("req-stay", "entity:wire", 2, 6), 1);
    assert.equal(staying[0]?.type, "ack");
    const update = await updatePublication;
    assert.equal(update.type, "component.updated");
    assert.equal((update.body as Record<string, unknown>).subscriptionId, enterBody.subscriptionId);
    const updatedValue = (update.body as Record<string, unknown>).value as { revision: number; state: Record<string, unknown> };
    assert.equal(updatedValue.revision, 3);
    assert.deepEqual(updatedValue.state.position, [6, 0, 0]);

    const leavePublication = receiveOne(observer);
    const leaving = await sendAndCollect(requester, setTransform("req-leave", "entity:wire", 3, 20), 1);
    assert.equal(leaving[0]?.type, "ack");
    const leave = await leavePublication;
    assert.equal(leave.type, "view.entity.leave");
    assert.equal((leave.body as Record<string, unknown>).subscriptionId, enterBody.subscriptionId);

    let replayedPublicationCount = 0;
    observer.on("message", () => { replayedPublicationCount += 1; });
    const reorderedRetry = JSON.stringify({
      body: { state: { scale: [1, 1, 1], rotation: [0, 0, 0, 1], position: [20, 0, 0] }, baseRevision: 3,
        authorityEpoch: 1, component: "hvtp.transform@1", entityId: "entity:wire" },
      realm, type: "component.set", id: "req-leave", hvtp: "0.2",
    });
    const duplicate = (await sendAndCollect(requester, reorderedRetry, 1))[0]!;
    assert.equal(duplicate.type, "ack");
    assert.deepEqual(duplicate, leaving[0]);
    await host.realmCoordinator.drain();
    assert.equal(replayedPublicationCount, 0);
    assert.equal(host.worldStore.getRealmSeq(), 4);

    const conflict = (await sendAndCollect(requester, setTransform("req-leave", "entity:wire", 3, 21), 1))[0]!;
    assert.equal((conflict.body as Record<string, unknown>).code, "request_id_conflict");
    assert.equal(host.worldStore.getRealmSeq(), 4);
    assert.ok(observer.readyState === WebSocket.OPEN);
  } finally {
    sockets.forEach((socket) => socket.close());
    await host.close();
  }
});

test("wire validation rejects merge-patch deletion, immutable renderable, and stale revisions", async () => {
  const host = await createReferenceHost({ databasePath: ":memory:" });
  const sockets: WebSocket[] = [];
  try {
    host.worldStore.createEntity(cube("entity:validation", 0));
    const socket = await join(host, { entities: ["entity:validation"] }, sockets);
    const invalid = (await sendAndCollect(socket, JSON.stringify({
      hvtp: "0.2", id: "req-patch-null", type: "component.patch", realm,
      body: { entityId: "entity:validation", component: "hvtp.transform@1", authorityEpoch: 1, baseRevision: 1, patch: { position: null } },
    }), 1))[0]!;
    assert.equal((invalid.body as Record<string, unknown>).code, "invalid_component_state");

    const immutable = (await sendAndCollect(socket, JSON.stringify({
      hvtp: "0.2", id: "req-renderable", type: "component.set", realm,
      body: { entityId: "entity:validation", component: "hvtp.renderable@1", authorityEpoch: 1, baseRevision: 1, state: {} },
    }), 1))[0]!;
    assert.equal((immutable.body as Record<string, unknown>).code, "not_authorized");

    const stale = (await sendAndCollect(socket, setTransform("req-stale", "entity:validation", 2, 1), 1))[0]!;
    assert.equal((stale.body as Record<string, unknown>).code, "revision_mismatch");
    assert.equal((stale.body as Record<string, unknown>).currentRevision, 1);
    assert.equal(host.worldStore.getRealmSeq(), 1);
  } finally {
    sockets.forEach((socket) => socket.close());
    await host.close();
  }
});

test("two WebSocket clients racing the same revision produce one commit and one revision conflict", async () => {
  const host = await createReferenceHost({ databasePath: ":memory:" });
  const sockets: WebSocket[] = [];
  try {
    host.worldStore.createEntity(cube("entity:race", 0));
    const a = await join(host, { entities: ["entity:race"] }, sockets);
    const b = await join(host, { entities: ["entity:race"] }, sockets);
    const aMessages = receiveMany(a, 2);
    const bMessages = receiveMany(b, 2);
    a.send(setTransform("req-race-a", "entity:race", 1, 1));
    b.send(setTransform("req-race-b", "entity:race", 1, 2));
    const [aResult, bResult] = await Promise.all([aMessages, bMessages]);
    for (const results of [aResult, bResult]) {
      assert.equal(results.filter((message) => message.type === "component.updated").length, 1);
      assert.equal(results.filter((message) => message.type === "ack" || message.type === "error").length, 1);
    }
    const outcomes = [aResult, bResult].flat().filter((message) => message.type === "ack" || message.type === "error");
    assert.equal(outcomes.filter((message) => message.type === "ack").length, 1);
    const conflict = outcomes.find((message) => message.type === "error")!;
    assert.equal((conflict.body as Record<string, unknown>).code, "revision_mismatch");
    assert.equal(host.worldStore.getRealmSeq(), 2);
  } finally {
    sockets.forEach((socket) => socket.close());
    await host.close();
  }
});

test("valid JSON Merge Patch preserves omitted required state and presence remains private", async () => {
  const host = await createReferenceHost({ databasePath: ":memory:" });
  const sockets: WebSocket[] = [];
  try {
    host.worldStore.createEntity(cube("entity:patch", 0));
    const socket = await join(host, { entities: ["entity:patch"] }, sockets);
    const mutationMessages = await sendAndCollect(socket, JSON.stringify({
      hvtp: "0.2", id: "req-valid-patch", type: "component.patch", realm,
      body: { entityId: "entity:patch", component: "hvtp.transform@1", authorityEpoch: 1, baseRevision: 1, patch: { position: [4, 2, 1] } },
    }), 2);
    const result = mutationMessages.find((message) => message.type === "ack")!;
    assert.equal(result.type, "ack");
    const publication = mutationMessages.find((message) => message.type === "component.updated")!;
    assert.equal(publication.type, "component.updated");
    const value = (publication.body as Record<string, unknown>).value as { state: Record<string, unknown> };
    assert.deepEqual(value.state, { position: [4, 2, 1], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });

    const presenceId = (socket as WebSocket & { presenceEntityId?: string }).presenceEntityId;
    assert.ok(presenceId);
    const ownPresence = (await sendAndCollect(socket, JSON.stringify({
      hvtp: "0.2", id: "req-own-presence", type: "component.set", realm,
      body: { entityId: presenceId, component: "hvtp.transform@1", authorityEpoch: 1, baseRevision: 1,
        state: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } },
    }), 1))[0]!;
    assert.equal((ownPresence.body as Record<string, unknown>).code, "presence_binding_violation");
    assert.equal(host.worldStore.getRealmSeq(), 2);
  } finally {
    sockets.forEach((socket) => socket.close());
    await host.close();
  }
});

test("failed durable create returns error and leaves no state, tombstone, sequence, or publication", async () => {
  let fail = true;
  const host = await createReferenceHost({ databasePath: ":memory:", worldStoreOptions: {
    beforeCommit: () => { if (fail) throw new Error("private storage detail"); },
  } });
  const sockets: WebSocket[] = [];
  try {
    const observer = await join(host, { entities: ["entity:faulted"] }, sockets);
    const requester = await join(host, {}, sockets);
    const failed = (await sendAndCollect(requester, create("req-fault", "entity:faulted", 0), 1))[0]!;
    assert.equal(failed.type, "error");
    assert.equal((failed.body as Record<string, unknown>).code, "resource_limit");
    assert.equal(JSON.stringify(failed).includes("private storage detail"), false);
    assert.equal(host.worldStore.getEntity("entity:faulted"), null);
    assert.equal(host.worldStore.isTombstoned("entity:faulted"), false);
    assert.equal(host.worldStore.getRealmSeq(), 0);

    fail = false;
    assert.equal((await sendAndCollect(requester, create("req-retry", "entity:faulted", 0), 1))[0]?.type, "ack");
    assert.equal((await receiveOne(observer)).type, "entity.created");
    assert.equal(host.worldStore.getRealmSeq(), 1);
  } finally {
    sockets.forEach((socket) => socket.close());
    await host.close();
  }
});

test("response failure after commit closes the session and a fresh snapshot reveals committed state", async () => {
  const host = await createReferenceHost({ databasePath: ":memory:", afterDurableCommit: () => { throw new Error("response failure"); } });
  const sockets: WebSocket[] = [];
  try {
    const observer = await join(host, { entities: ["entity:committed"] }, sockets);
    let publications = 0;
    observer.on("message", () => { publications += 1; });
    const requester = await join(host, {}, sockets);
    const closed = new Promise<number>((resolve) => requester.once("close", (code) => resolve(code)));
    requester.send(create("req-response-fails", "entity:committed", 0));
    assert.equal(await closed, 1011);
    assert.equal(host.worldStore.getRealmSeq(), 1);
    assert.ok(host.worldStore.getEntity("entity:committed"));
    await host.realmCoordinator.drain();
    assert.equal(publications, 0);
    const recovered = await join(host, { entities: ["entity:committed"] }, sockets);
    assert.equal(recovered.readyState, WebSocket.OPEN);
    const snapshot = (recovered as WebSocket & { snapshotMessages?: Array<Record<string, unknown>> }).snapshotMessages!;
    const recoveredEntity = snapshot
      .filter((message) => message.type === "entity.snapshot")
      .map((message) => (message.body as Record<string, unknown>).entity as { id: string })
      .find((entity) => entity.id === "entity:committed");
    assert.ok(recoveredEntity);
  } finally {
    sockets.forEach((socket) => socket.close());
    await host.close();
  }
});

test("component mutation matches authority epoch, accepts no-op once, and deletion has global precedence", async () => {
  const host = await createReferenceHost({ databasePath: ":memory:" });
  const sockets: WebSocket[] = [];
  try {
    host.worldStore.createEntity(cube("entity:no-op", 5));
    const observer = await join(host, { entities: ["entity:no-op"] }, sockets);
    const requester = await join(host, {}, sockets);
    const badEpoch = (await sendAndCollect(requester, JSON.stringify({
      hvtp: "0.2", id: "req-epoch-mismatch", type: "component.set", realm,
      body: { entityId: "entity:no-op", component: "hvtp.transform@1", authorityEpoch: 2, baseRevision: 1,
        state: { position: [5, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } },
    }), 1))[0]!;
    assert.equal((badEpoch.body as Record<string, unknown>).code, "authority_epoch_mismatch");
    assert.equal(host.worldStore.getRealmSeq(), 1);

    const noopPublication = receiveOne(observer);
    const noop = (await sendAndCollect(requester, setTransform("req-no-op", "entity:no-op", 1, 5), 1))[0]!;
    assert.equal(noop.type, "ack");
    assert.equal((await noopPublication).type, "component.updated");
    assert.equal(host.worldStore.getRealmSeq(), 2);
    assert.deepEqual(await sendAndCollect(requester, setTransform("req-no-op", "entity:no-op", 1, 5), 1), [noop]);
    assert.equal(host.worldStore.getRealmSeq(), 2);

    const deletionPublication = receiveOne(observer);
    const deletion = (await sendAndCollect(requester, remove("req-delete", "entity:no-op"), 1))[0]!;
    assert.equal(deletion.type, "ack");
    assert.equal((await deletionPublication).type, "entity.deleted");
    const missing = (await sendAndCollect(requester, remove("req-delete-again", "entity:no-op"), 1))[0]!;
    assert.equal((missing.body as Record<string, unknown>).code, "entity_not_found");
    assert.equal(host.worldStore.getRealmSeq(), 3);
    assert.equal(host.worldStore.isTombstoned("entity:no-op"), true);
    const recreate = (await sendAndCollect(requester, create("req-recreate-tombstone", "entity:no-op", 5), 1))[0]!;
    assert.equal((recreate.body as Record<string, unknown>).code, "entity_exists");
    assert.equal(host.worldStore.getRealmSeq(), 3);
  } finally {
    sockets.forEach((socket) => socket.close());
    await host.close();
  }
});

test("subscriber sequence gaps are sparse and legal", async () => {
  const host = await createReferenceHost({ databasePath: ":memory:" });
  const sockets: WebSocket[] = [];
  try {
    host.worldStore.createEntity(cube("entity:visible-sequence", 0));
    host.worldStore.createEntity(cube("entity:hidden-sequence", 50));
    const observer = await join(host, { entities: ["entity:visible-sequence"] }, sockets);
    const requester = await join(host, {}, sockets);
    const publication = receiveOne(observer);
    assert.equal((await sendAndCollect(requester, setTransform("req-hidden-first", "entity:hidden-sequence", 1, 51), 1))[0]?.type, "ack");
    assert.equal((await sendAndCollect(requester, setTransform("req-visible-next", "entity:visible-sequence", 1, 1), 1))[0]?.type, "ack");
    const message = await publication;
    assert.equal(message.type, "component.updated");
    assert.equal(message.seq, 4);
    assert.equal(host.worldStore.getRealmSeq(), 4);
  } finally {
    sockets.forEach((socket) => socket.close());
    await host.close();
  }
});

test("ordered publications keep create N before delete N+1 across delayed enqueue", async () => {
  const gate = deferred();
  let paused = false;
  const host = await createReferenceHost({ databasePath: ":memory:", realmCoordinatorOptions: {
    beforeMutationEnqueue: async (seq) => { if (seq === 1 && !paused) { paused = true; await gate.promise; } },
  } });
  const sockets: WebSocket[] = [];
  try {
    const observer = await join(host, { entities: ["entity:ordered"] }, sockets);
    const requester = await join(host, {}, sockets);
    assert.equal((await sendAndCollect(requester, create("req-create-ordered", "entity:ordered", 0), 1))[0]?.type, "ack");
    assert.equal((await sendAndCollect(requester, remove("req-delete-ordered", "entity:ordered"), 1))[0]?.type, "ack");
    gate.release();
    const messages = await receiveMany(observer, 2);
    assert.deepEqual(messages.map((message) => [message.type, message.seq]), [["entity.created", 1], ["entity.deleted", 2]]);
  } finally {
    gate.release();
    sockets.forEach((socket) => socket.close());
    await host.close();
  }
});

test("ordered publications keep leave N before enter N+1 across delayed enqueue", async () => {
  const gate = deferred();
  let paused = false;
  const host = await createReferenceHost({ databasePath: ":memory:", realmCoordinatorOptions: {
    beforeMutationEnqueue: async (seq) => { if (seq === 2 && !paused) { paused = true; await gate.promise; } },
  } });
  const sockets: WebSocket[] = [];
  try {
    host.worldStore.createEntity(cube("entity:crossing", 5));
    const observer = await join(host, { spatial: { center: [0, 0, 0], radius: 10 } }, sockets);
    const requester = await join(host, {}, sockets);
    assert.equal((await sendAndCollect(requester, setTransform("req-leave-first", "entity:crossing", 1, 20), 1))[0]?.type, "ack");
    assert.equal((await sendAndCollect(requester, setTransform("req-enter-second", "entity:crossing", 2, 5), 1))[0]?.type, "ack");
    gate.release();
    const messages = await receiveMany(observer, 2);
    assert.deepEqual(messages.map((message) => [message.type, message.seq]), [["view.entity.leave", 2], ["view.entity.enter", 3]]);
    const entity = (messages[1]?.body as { entity: { components: Record<string, { revision: number }> } }).entity;
    assert.equal(entity.components["hvtp.transform@1"]?.revision, 3);
  } finally {
    gate.release();
    sockets.forEach((socket) => socket.close());
    await host.close();
  }
});

async function join(host: ReferenceHost, subscription: Record<string, unknown>, sockets: WebSocket[]): Promise<WebSocket> {
  const socket = new WebSocket(`ws://${host.host}:${host.port}/hvtp`);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  await sendAndCollect(socket, hello, 1);
  const id = `req-join-${randomUUID()}`;
  const request = JSON.stringify({ hvtp: "0.2", id, type: "realm.join", body: { realm, subscription } });
  const entityCount = host.worldStore.snapshot(subscription as never).entities.length + 1;
  const messages = await sendAndCollect(socket, request, entityCount + 3);
  assert.equal(messages.at(-1)?.type, "realm.snapshot.end");
  const joinedBody = messages[0]?.body as Record<string, unknown>;
  (socket as WebSocket & { presenceEntityId?: string }).presenceEntityId = joinedBody.presenceEntityId as string;
  (socket as WebSocket & { snapshotMessages?: Array<Record<string, unknown>> }).snapshotMessages = messages;
  return socket;
}

function create(id: string, entityId: string, x: number): string {
  return JSON.stringify({ hvtp: "0.2", id, type: "entity.create", realm, body: { entity: {
    id: entityId,
    components: {
      "hvtp.transform@1": { state: { position: [x, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } },
      "hvtp.renderable@1": { state: { asset: { uri: "unit-cube.gltf", mediaType: "model/gltf+json" }, node: "UnitCube", visible: true } },
      "hvtp.material@1": { state: { baseColor: [1, 1, 1, 1] } },
    },
  } } });
}

function setTransform(id: string, entityId: string, baseRevision: number, x: number): string {
  return JSON.stringify({ hvtp: "0.2", id, type: "component.set", realm, body: {
    entityId, component: "hvtp.transform@1", authorityEpoch: 1, baseRevision,
    state: { position: [x, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
  } });
}

function remove(id: string, entityId: string): string {
  return JSON.stringify({ hvtp: "0.2", id, type: "entity.delete", realm, body: { entityId } });
}

function cube(id: string, x: number) {
  return {
    id,
    transform: { position: [x, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] },
    renderable: { asset: { uri: "unit-cube.gltf" as const, mediaType: "model/gltf+json" as const }, node: "UnitCube" as const, visible: true },
    material: { baseColor: [1, 1, 1, 1] as [number, number, number, number] },
  };
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function receiveOne(socket: WebSocket): Promise<Record<string, unknown>> {
  return (await receiveMany(socket, 1))[0]!;
}

async function receiveMany(socket: WebSocket, count: number): Promise<Array<Record<string, unknown>>> {
  return await new Promise((resolve, reject) => {
    const messages: Array<Record<string, unknown>> = [];
    const onMessage = (data: RawData): void => {
      messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
      if (messages.length === count) {
        socket.off("message", onMessage);
        socket.off("error", onError);
        resolve(messages);
      }
    };
    const onError = (error: Error): void => {
      socket.off("message", onMessage);
      reject(error);
    };
    socket.on("message", onMessage);
    socket.once("error", onError);
  });
}

async function sendAndCollect(socket: WebSocket, text: string, count: number): Promise<Array<Record<string, unknown>>> {
  const received = receiveMany(socket, count);
  socket.send(text);
  return await received;
}
