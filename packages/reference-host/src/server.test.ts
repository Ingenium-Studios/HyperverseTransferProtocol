import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
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
  const host = await createReferenceHost();
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
  const host = await createReferenceHost();
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
  const host = await createReferenceHost();
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
    const onMessage = (data: WebSocket.RawData): void => {
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
