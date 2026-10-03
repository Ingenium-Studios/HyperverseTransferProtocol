import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { createReferenceHost } from "./server.js";

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

test("reference host negotiates hello over WebSocket", async () => {
  const host = await createReferenceHost();
  try {
    const socket = new WebSocket(`ws://${host.host}:${host.port}/hvtp`);
    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.once("open", () => socket.send(hello));
      socket.once("message", (data) => resolve(JSON.parse(data.toString()) as Record<string, unknown>));
      socket.once("error", reject);
    });
    assert.equal(response.type, "session.welcome");
    const body = response.body as Record<string, unknown>;
    assert.match(body.assetBaseUri as string, /^http:\/\/127\.0\.0\.1:\d+\/assets\/p1\/$/);
    socket.close();
  } finally {
    await host.close();
  }
});
