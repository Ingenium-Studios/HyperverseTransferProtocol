import assert from "node:assert/strict";
import test from "node:test";
import { parseJsonRequest, parseRealmJoin, parseSessionHello, parseSubscriptionSet } from "./index.js";

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


test("parseRealmJoin accepts an empty subscription selector", () => {
  const result = parseRealmJoin(JSON.stringify({
    hvtp: "0.2",
    id: "req-join-empty",
    type: "realm.join",
    body: {
      realm: "urn:hvtp:realm:prototype-world",
      subscription: {},
    },
  }));
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value.body.subscription, {});
});

test("parseRealmJoin accepts spatial and explicit selectors together", () => {
  const result = parseRealmJoin(JSON.stringify({
    hvtp: "0.2",
    id: "req-join-selectors",
    type: "realm.join",
    body: {
      realm: "urn:hvtp:realm:prototype-world",
      subscription: {
        spatial: { center: [0, 1, 2], radius: 100 },
        entities: ["entity:known"],
      },
    },
  }));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value.body.subscription.spatial, { center: [0, 1, 2], radius: 100 });
    assert.deepEqual(result.value.body.subscription.entities, ["entity:known"]);
  }
});

test("parseRealmJoin rejects a different realm", () => {
  const result = parseRealmJoin(JSON.stringify({
    hvtp: "0.2",
    id: "req-join-wrong-realm",
    type: "realm.join",
    body: {
      realm: "urn:hvtp:realm:elsewhere",
      subscription: {},
    },
  }));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "realm_not_found");
    assert.equal(result.error.ref, "req-join-wrong-realm");
  }
});

test("parseRealmJoin rejects invalid spatial values and over-limit radius", () => {
  const negative = parseRealmJoin(JSON.stringify({
    hvtp: "0.2",
    id: "req-negative-radius",
    type: "realm.join",
    body: {
      realm: "urn:hvtp:realm:prototype-world",
      subscription: { spatial: { center: [0, 0, 0], radius: -1 } },
    },
  }));
  assert.equal(negative.ok, false);
  if (!negative.ok) assert.equal(negative.error.code, "invalid_message");

  const tooLarge = parseRealmJoin(JSON.stringify({
    hvtp: "0.2",
    id: "req-large-radius",
    type: "realm.join",
    body: {
      realm: "urn:hvtp:realm:prototype-world",
      subscription: { spatial: { center: [0, 0, 0], radius: 501 } },
    },
  }));
  assert.equal(tooLarge.ok, false);
  if (!tooLarge.ok) assert.equal(tooLarge.error.code, "resource_limit");
});

test("parseRealmJoin enforces explicit entity ID count", () => {
  const result = parseRealmJoin(JSON.stringify({
    hvtp: "0.2",
    id: "req-many-ids",
    type: "realm.join",
    body: {
      realm: "urn:hvtp:realm:prototype-world",
      subscription: {
        entities: Array.from({ length: 257 }, (_, index) => `entity:${index}`),
      },
    },
  }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "resource_limit");
});

test("subscription.set reuses realm.join selector validation and preserves the closed wire envelope", () => {
  const request = { hvtp: "0.2", id: "replace", type: "subscription.set", realm: "urn:hvtp:realm:prototype-world", body: {} };
  for (const selector of [{}, { entities: [] }, { spatial: { center: [0, 0, 0], radius: 0 }, entities: ["E"] }]) {
    const parsed = parseSubscriptionSet(JSON.stringify({ ...request, body: selector }));
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.deepEqual(parsed.value.body, selector);
  }
  for (const selector of [null, [], { extra: true }, { entities: ["E", 3] }, { entities: Array(257).fill("E") },
    { spatial: { center: [0, 0], radius: 0 } }, { spatial: { center: [0, 0, 0], radius: -1 } },
    { spatial: { center: [0, 0, 0], radius: 501 } }]) {
    const replaced = parseSubscriptionSet(JSON.stringify({ ...request, body: selector }));
    const joined = parseRealmJoin(JSON.stringify({ hvtp: "0.2", id: "join", type: "realm.join", body: { realm: request.realm, subscription: selector } }));
    assert.equal(replaced.ok, false); assert.equal(joined.ok, false);
    if (!replaced.ok && !joined.ok) { assert.equal(replaced.error.code, joined.error.code); assert.equal(replaced.error.ref, "replace"); }
  }
  for (const [overrides, code] of [[{ unexpected: true }, "invalid_message"], [{ realm: "other" }, "realm_not_found"],
    [{ hvtp: "0.1" }, "unsupported_version"], [{ type: "other" }, "invalid_message"]] as const) {
    const result = parseSubscriptionSet(JSON.stringify({ ...request, ...overrides }));
    assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, code);
  }
});
