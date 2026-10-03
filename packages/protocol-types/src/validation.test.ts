import assert from "node:assert/strict";
import test from "node:test";
import { parseJsonRequest, parseSessionHello } from "./index.js";

const hello = {
  hvtp: "0.2",
  id: "req-hello-01",
  type: "session.hello",
  body: {
    versions: ["0.2"],
    client: { name: "test-client", version: "0.1.0" },
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
};

test("parseSessionHello accepts the closed P1 hello shape", () => {
  const result = parseSessionHello(JSON.stringify(hello));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.body.participant.kind, "human");
});

test("invalid JSON is uncorrelated", () => {
  const result = parseJsonRequest("{");
  assert.deepEqual(result, {
    ok: false,
    error: { code: "invalid_json", ref: null, message: "Message is not syntactically valid JSON." },
  });
});

test("valid non-object JSON is invalid_message with null ref", () => {
  const result = parseJsonRequest("[]");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "invalid_message");
    assert.equal(result.error.ref, null);
  }
});

test("duplicate decoded keys are rejected before shape validation", () => {
  const text = '{"hvtp":"0.2","id":"first","\\u0069d":"second","type":"session.hello","body":{}}';
  const result = parseJsonRequest(text);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "invalid_message");
    // The decoded duplicate makes the identifier ambiguous even though JSON.parse kept one value.
    assert.equal(result.error.ref, null);
  }
});

test("nested duplicate id preserves the unique top-level request id", () => {
  const text =
    '{"hvtp":"0.2","id":"req-top","type":"session.hello","body":{"id":"nested-first","\\u0069d":"nested-second"}}';
  const result = parseJsonRequest(text);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "invalid_message");
    assert.equal(result.error.ref, "req-top");
  }
});

test("closed-shape error preserves a unique request id", () => {
  const result = parseSessionHello(JSON.stringify({ ...hello, unexpected: true }));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "invalid_message");
    assert.equal(result.error.ref, "req-hello-01");
  }
});

test("P1 hello requires all required components", () => {
  const request = structuredClone(hello);
  request.body.capabilities.components.pop();
  const result = parseSessionHello(JSON.stringify(request));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "unsupported_component");
});
