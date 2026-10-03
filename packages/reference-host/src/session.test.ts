import assert from "node:assert/strict";
import test from "node:test";
import { P1Session } from "./session.js";

function hello(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hvtp: "0.2",
    id: "req-hello",
    type: "session.hello",
    body: {
      versions: ["0.2"],
      client: { name: "test", version: "0.1.0" },
      participant: { kind: "agent" },
      capabilities: {
        components: [
          "hvtp.transform@1",
          "hvtp.renderable@1",
          "hvtp.material@1",
          "hvtp.presence@1",
        ],
      },
    },
    ...extra,
  });
}

test("session.hello negotiates exactly once", () => {
  const session = new P1Session("http://127.0.0.1:8787/assets/p1/");
  const first = session.handleText(hello());
  assert.equal(first.type, "session.welcome");
  assert.equal(session.state, "NEGOTIATED");

  const second = session.handleText(hello());
  assert.equal(second.type, "error");
  if (second.type === "error") {
    assert.equal(second.body.code, "invalid_state");
    assert.equal(second.body.ref, "req-hello");
  }
});

test("realm message before welcome is invalid_state", () => {
  const session = new P1Session("http://127.0.0.1:8787/assets/p1/");
  const result = session.handleText(JSON.stringify({
    hvtp: "0.2",
    id: "req-join",
    type: "realm.join",
    body: { realm: "urn:hvtp:realm:prototype-world", subscription: {} },
  }));
  assert.equal(result.type, "error");
  if (result.type === "error") assert.equal(result.body.code, "invalid_state");
});

test("invalid closed shape preserves a unique request id", () => {
  const session = new P1Session("http://127.0.0.1:8787/assets/p1/");
  const result = session.handleText(hello({ unexpected: true }));
  assert.equal(result.type, "error");
  if (result.type === "error") {
    assert.equal(result.body.code, "invalid_message");
    assert.equal(result.body.ref, "req-hello");
  }
});
