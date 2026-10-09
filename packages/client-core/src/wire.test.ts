import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalPublicationMessage } from "@hvtp/protocol-types";
import { P1ProtocolViolationError } from "./errors.js";
import { hasDuplicateJsonKey, parseJsonObject } from "./json.js";
import { parseHostMessage } from "./wire.js";
import { created, cube, enter, hostError, leave } from "./test-support.js";

const violates = (pattern: RegExp) => (error: unknown) => error instanceof P1ProtocolViolationError && pattern.test(error.message);

// ---------------------------------------------------------------------------------------------------------------
// Host JSON object parsing (Profile §14.0)
// ---------------------------------------------------------------------------------------------------------------

test("hasDuplicateJsonKey compares decoded keys per object at any depth and ignores string contents", () => {
  assert.equal(hasDuplicateJsonKey('{"a":1,"a":2}'), true);
  assert.equal(hasDuplicateJsonKey('{"id":"x","\\u0069d":"y"}'), true, "escaped spelling of the same key");
  assert.equal(hasDuplicateJsonKey('{"a\\/b":1,"a/b":2}'), true, "escaped solidus decodes to the same key");
  assert.equal(hasDuplicateJsonKey('{"a":{"b":{"c":[{"d":1,"d":2}]}}}'), true, "deep, inside an array element");
  assert.equal(hasDuplicateJsonKey('[{"a":1},{"a":2},[{"a":3}]]'), false, "equal keys in different objects are not duplicates");
  assert.equal(hasDuplicateJsonKey('{"a":{"a":1},"b":{"a":1}}'), false, "same key in nested and sibling scopes");
  assert.equal(hasDuplicateJsonKey('{"a":"{\\"x\\":1,\\"x\\":2}","b":"\\\\","c":"}]"}'), false, "braces, quotes, and escapes inside string values");
  assert.equal(hasDuplicateJsonKey('{"a":"v","b":["a","a"]}'), false, "repeated array strings are values, not keys");
  assert.equal(hasDuplicateJsonKey('{"a":1,"b":{},"c":[],"a":3}'), true, "empty containers do not reset the enclosing scope");
  assert.equal(hasDuplicateJsonKey("{}"), false);
});

test("hasDuplicateJsonKey needs no call stack for deeply nested hostile input", () => {
  const depth = 50_000;
  const text = `${"[".repeat(depth)}${"]".repeat(depth)}`;
  assert.equal(hasDuplicateJsonKey(text), false);
  const nested = `${'{"a":'.repeat(depth)}1${"}".repeat(depth)}`;
  assert.equal(hasDuplicateJsonKey(nested), false);
  assert.equal(hasDuplicateJsonKey(`{"a":1,"a":${nested}}`), true);
});

test("parseJsonObject requires one syntactically valid JSON object and nothing else", () => {
  assert.deepEqual(parseJsonObject('{"id":"x"}'), { id: "x" });
  for (const text of ["", "{not json", "[]", '"text"', "7", "null", "true"]) {
    assert.throws(() => parseJsonObject(text), P1ProtocolViolationError, text);
  }
  assert.throws(() => parseJsonObject('{"id":"a","id":"b"}'), violates(/duplicate JSON object key/i));
  assert.throws(() => parseJsonObject('{"id":"a","\\u0069d":"b"}'), violates(/duplicate JSON object key/i));
  assert.throws(() => parseJsonObject('{"a":{"b":1,"b":2}}'), violates(/duplicate JSON object key/i));
});

// ---------------------------------------------------------------------------------------------------------------
// Host IDs are opaque: only non-emptiness is assumed (the 128-byte rule is for client-generated IDs)
// ---------------------------------------------------------------------------------------------------------------

test("parseHostMessage accepts non-empty host IDs of any UTF-8 length and rejects empty or non-string ones", () => {
  for (const id of ["h".repeat(129), "é".repeat(100), "\u{1F600}".repeat(40), "é".repeat(100_000)]) {
    const message = parseHostMessage(JSON.stringify({ ...created(cube("entity:b"), 11), id }));
    assert.equal(message.id, id);
    assert.equal(parseHostMessage(JSON.stringify({ ...hostError(null, "x"), id })).id, id);
  }
  for (const id of ["", 5, null, ["a"], { a: 1 }, true]) {
    assert.throws(() => parseHostMessage(JSON.stringify({ ...created(cube("entity:b"), 11), id })), violates(/non-empty opaque ID/), JSON.stringify(id));
  }
  const { id: _omitted, ...withoutId } = created(cube("entity:b"), 11);
  assert.throws(() => parseHostMessage(JSON.stringify(withoutId)), violates(/message id/));
});

test("parseHostMessage still rejects duplicate decoded keys in host frames", () => {
  const frame = JSON.stringify(created(cube("entity:b"), 11));
  assert.throws(() => parseHostMessage(frame.replace('"id":', '"\\u0069d":"other","id":')), violates(/duplicate JSON object key/i));
  assert.throws(() => parseHostMessage(frame.replace('"body":{', '"body":{"subscriptionId":"subscription:other",')), violates(/duplicate JSON object key/i));
  assert.throws(() => parseHostMessage("[]"), violates(/JSON object/));
  assert.throws(() => parseHostMessage("{nope"), violates(/valid JSON/));
});

// ---------------------------------------------------------------------------------------------------------------
// View transition reasons (Profile §14.14, §14.15)
// ---------------------------------------------------------------------------------------------------------------

type PublicationBody<T extends CanonicalPublicationMessage["type"]> = Extract<CanonicalPublicationMessage, { type: T }>["body"];
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

test("type level: view.entity.leave allows subscription | interest | authorization; view.entity.enter only subscription | interest", () => {
  // These assignments only compile while the protocol types are exactly the profile's reason sets.
  const leaveReasonsAreExact: Equal<PublicationBody<"view.entity.leave">["reason"], "subscription" | "interest" | "authorization"> = true;
  const enterReasonsAreExact: Equal<PublicationBody<"view.entity.enter">["reason"], "subscription" | "interest"> = true;
  assert.deepEqual([leaveReasonsAreExact, enterReasonsAreExact], [true, true]);
});

test("parseHostMessage accepts leave reasons subscription, interest, and authorization", () => {
  for (const reason of ["subscription", "interest", "authorization"]) {
    const message = parseHostMessage(JSON.stringify(leave("entity:a", 12, "subscription:s0", reason)));
    assert.equal(message.type, "view.entity.leave");
    assert.equal(message.type === "view.entity.leave" && message.body.reason, reason);
  }
});

test("parseHostMessage accepts enter reasons subscription and interest but rejects authorization", () => {
  for (const reason of ["subscription", "interest"]) {
    assert.equal(parseHostMessage(JSON.stringify(enter(cube("entity:a"), 12, "subscription:s0", reason))).type, "view.entity.enter");
  }
  assert.throws(() => parseHostMessage(JSON.stringify(enter(cube("entity:a"), 12, "subscription:s0", "authorization"))), violates(/enter reason/));
});

test("parseHostMessage rejects unknown or non-string transition reasons on both enter and leave", () => {
  for (const reason of ["", "Authorization", "eviction", 3, null, ["interest"]]) {
    assert.throws(() => parseHostMessage(JSON.stringify(leave("entity:a", 12, "subscription:s0", reason as never))), violates(/leave reason/), JSON.stringify(reason));
    assert.throws(() => parseHostMessage(JSON.stringify(enter(cube("entity:a"), 12, "subscription:s0", reason as never))), violates(/enter reason/), JSON.stringify(reason));
  }
  const missing = leave("entity:a", 12) as { body: Record<string, unknown> };
  delete missing.body.reason;
  assert.throws(() => parseHostMessage(JSON.stringify(missing)), violates(/closed P1 shape/));
});
