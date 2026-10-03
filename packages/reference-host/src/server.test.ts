import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import test from "node:test";
import WebSocket, { type RawData } from "ws";
import { createReferenceHost, type ReferenceHost } from "./server.js";

const hello = JSON.stringify({
  hvtp: "0.2",
  id: "req-hello-integration",
  type: "session.hello",
  body: {
    versions: ["0.2"],
    client: { name: "integration", version: "0.1.0" },
    participant: { kind: "human" },
    capabilities: {
      components: [
        "hvtp.transform@1",
        "hvtp.renderable@1",
        "hvtp.material@1",
        "hvtp.presence@1",
      ],
    },
  },
});

const join = JSON.stringify({
  hvtp: "0.2",
  id: "req-join-integration",
  type: "realm.join",
  body: {
    realm: "urn:hvtp:realm:prototype-world",
    subscription: {},
  },
});

test("reference host negotiates hello over WebSocket", async () => {
  const host = await createReferenceHost({ databasePath: ":memory:" });
  try {
    const socket = await connect(host);
    const [response] = await sendAndCollect(socket, hello, 1);
    assert.equal(response?.type, "session.welcome");
    const body = response?.body as Record<string, unknown>;
    assert.match(body.assetBaseUri as string, /^http:\/\/127\.0\.0\.1:\d+\/assets\/p1\/$/);
    socket.close();
  } finally {
    await host.close();
  }
});

test("reference host enqueues the initial presence snapshot in protocol order", async () => {
  const host = await createReferenceHost({ databasePath: ":memory:" });
  try {
    const socket = await connect(host);
    const [welcome] = await sendAndCollect(socket, hello, 1);
    assert.equal(welcome?.type, "session.welcome");
    const welcomeBody = welcome?.body as Record<string, unknown>;

    const messages = await sendAndCollect(socket, join, 4);
    assert.deepEqual(messages.map((message) => message.type), [
      "realm.joined",
      "realm.snapshot.begin",
      "entity.snapshot",
      "realm.snapshot.end",
    ]);

    const joined = messages[0]!;
    const begin = messages[1]!;
    const entity = messages[2]!;
    const end = messages[3]!;
    assert.equal(joined.realmEpoch, host.realmEpoch);
    assert.equal(begin.realmEpoch, host.realmEpoch);
    assert.equal(entity.realmEpoch, host.realmEpoch);
    assert.equal(end.realmEpoch, host.realmEpoch);

    const joinedBody = joined.body as Record<string, unknown>;
    const beginBody = begin.body as Record<string, unknown>;
    const entityBody = entity.body as Record<string, unknown>;
    const endBody = end.body as Record<string, unknown>;
    assert.equal(joinedBody.snapshotBaseSeq, 0);
    assert.equal(joinedBody.snapshotId, beginBody.snapshotId);
    assert.equal(joinedBody.snapshotId, entityBody.snapshotId);
    assert.equal(joinedBody.snapshotId, endBody.snapshotId);
    assert.equal(endBody.entityCount, 1);

    const snapshotEntity = entityBody.entity as {
      id: string;
      components: Record<string, { state: Record<string, unknown> }>;
    };
    assert.equal(snapshotEntity.id, joinedBody.presenceEntityId);
    assert.equal(
      snapshotEntity.components["hvtp.presence@1"]?.state.participantId,
      welcomeBody.participantId,
    );
    assert.equal(snapshotEntity.components["hvtp.presence@1"]?.state.kind, "human");
    assert.deepEqual(Object.keys(snapshotEntity.components).sort(), ["hvtp.presence@1", "hvtp.transform@1"]);

    socket.close();
  } finally {
    await host.close();
  }
});

test("reference host serves the checked-in P1 unit cube fixture", async () => {
  const host = await createReferenceHost({ databasePath: ":memory:" });
  try {
    const response = await fetch(`http://${host.host}:${host.port}/assets/p1/unit-cube.gltf`, {
      redirect: "manual",
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "model/gltf+json");

    const fixture = (await response.json()) as {
      nodes?: Array<{ name?: string }>;
      accessors?: Array<{ count?: number }>;
    };
    assert.equal(fixture.nodes?.[0]?.name, "UnitCube");
    assert.equal(fixture.accessors?.[0]?.count, 8);
    assert.equal(fixture.accessors?.[1]?.count, 36);
  } finally {
    await host.close();
  }
});

async function connect(host: ReferenceHost): Promise<WebSocket> {
  const socket = new WebSocket(`ws://${host.host}:${host.port}/hvtp`);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return socket;
}

async function sendAndCollect(
  socket: WebSocket,
  text: string,
  count: number,
): Promise<Array<Record<string, unknown>>> {
  const messages = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
    const collected: Array<Record<string, unknown>> = [];
    const onMessage = (data: RawData): void => {
      collected.push(JSON.parse(data.toString()) as Record<string, unknown>);
      if (collected.length === count) {
        socket.off("message", onMessage);
        socket.off("error", onError);
        resolve(collected);
      }
    };
    const onError = (error: Error): void => {
      socket.off("message", onMessage);
      reject(error);
    };
    socket.on("message", onMessage);
    socket.once("error", onError);
    socket.send(text);
  });
  return messages;
}


test("reference host recovers durable shared state into a fresh epoch snapshot", async () => {
  const dir = mkdtempSync(joinPath(tmpdir(), "hvtp-host-restart-"));
  const databasePath = joinPath(dir, "world.sqlite");
  let first: ReferenceHost | null = null;
  let second: ReferenceHost | null = null;

  try {
    first = await createReferenceHost({ databasePath });
    const firstEpoch = first.realmEpoch;

    first.worldStore.createEntity({
      id: "entity:persisted-cube",
      transform: {
        position: [10, 0.5, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
      renderable: {
        asset: { uri: "unit-cube.gltf", mediaType: "model/gltf+json" },
        node: "UnitCube",
        visible: true,
      },
      material: { baseColor: [1, 1, 1, 1] },
    });
    first.worldStore.replaceMutableComponent(
      "entity:persisted-cube",
      "hvtp.material@1",
      { baseColor: [0.25, 0.5, 0.75, 1] },
      1,
      1,
    );
    assert.equal(first.worldStore.getRealmSeq(), 2);

    await first.close();
    first = null;

    second = await createReferenceHost({ databasePath });
    assert.notEqual(second.realmEpoch, firstEpoch);
    assert.equal(second.worldStore.getRealmSeq(), 0);

    const socket = await connect(second);
    const [welcome] = await sendAndCollect(socket, hello, 1);
    assert.equal(welcome?.type, "session.welcome");

    const subscribedJoin = JSON.stringify({
      hvtp: "0.2",
      id: "req-restart-join",
      type: "realm.join",
      body: {
        realm: "urn:hvtp:realm:prototype-world",
        subscription: {
          spatial: { center: [0, 0, 0], radius: 100 },
        },
      },
    });

    const messages = await sendAndCollect(socket, subscribedJoin, 5);
    assert.deepEqual(messages.map((message) => message.type), [
      "realm.joined",
      "realm.snapshot.begin",
      "entity.snapshot",
      "entity.snapshot",
      "realm.snapshot.end",
    ]);

    const joined = messages[0]!;
    const end = messages[4]!;
    const joinedBody = joined.body as Record<string, unknown>;
    const endBody = end.body as Record<string, unknown>;
    assert.equal(joined.realmEpoch, second.realmEpoch);
    assert.equal(joinedBody.snapshotBaseSeq, 0);
    assert.equal(endBody.snapshotBaseSeq, 0);
    assert.equal(endBody.entityCount, 2);

    const entityMessages = messages.filter((message) => message.type === "entity.snapshot");
    const entities = entityMessages.map(
      (message) => ((message.body as Record<string, unknown>).entity as {
        id: string;
        components: Record<string, {
          revision: number;
          state: Record<string, unknown>;
        }>;
      }),
    );

    const persisted = entities.find((entity) => entity.id === "entity:persisted-cube");
    assert.ok(persisted);
    assert.equal(persisted.components["hvtp.material@1"]?.revision, 2);
    assert.deepEqual(
      persisted.components["hvtp.material@1"]?.state.baseColor,
      [0.25, 0.5, 0.75, 1],
    );

    const presence = entities.find((entity) => entity.id !== "entity:persisted-cube");
    assert.ok(presence);
    assert.ok(presence.components["hvtp.presence@1"]);

    socket.close();
  } finally {
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
