import assert from "node:assert/strict";
import test from "node:test";
import { P1_LIMITS, P1_REALM_ID } from "@hvtp/protocol-types";
import type { ReferenceHost } from "./server.js";
import {
  connectedPeer, createMessage, cubeInput, joinCollect, joinMessage, snapshotSharedIds, subscriptionMessage, withHost, withLiteral,
} from "./test-support.js";

type Vec3 = [number, number, number];
const spatial = (center: Vec3, radius: number) => ({ spatial: { center, radius } });

function place(host: ReferenceHost, id: string, position: Vec3, extra: { scale?: Vec3; visible?: boolean } = {}): void {
  const input = cubeInput(id);
  host.worldStore.createEntity({
    ...input,
    transform: { ...input.transform, position, scale: extra.scale ?? input.transform.scale },
    renderable: { ...input.renderable, visible: extra.visible ?? true },
  });
}

test("C29 membership is transform-origin Euclidean distance, inclusive at the radius, in all three axes", () => withHost(async (host) => {
  place(host, "on-x", [100, 0, 0]);
  place(host, "just-outside-x", [100.000001, 0, 0]);
  place(host, "on-y", [0, 100, 0]);
  place(host, "on-z", [0, 0, 100]);
  place(host, "outside-z", [0, 0, 100.000001]);
  place(host, "three-four-five", [60, 80, 0]);
  place(host, "diag-outside", [58, 82, 0]); // 58^2 + 82^2 = 10088 > 10000
  // Huge/nonuniform scale and visibility are unrelated to membership; geometry bounds are never used.
  place(host, "huge-scale-outside", [100.5, 0, 0], { scale: [1000, 1000, 1000] });
  place(host, "tiny-scale-inside", [100, 0, 0], { scale: [0.001, 1000, 1] });
  place(host, "invisible-inside", [10, 0, 0], { visible: false });
  place(host, "invisible-outside", [200, 0, 0], { visible: false });
  const selected = ["invisible-inside", "on-x", "on-y", "on-z", "three-four-five", "tiny-scale-inside"];

  const joiner = await connectedPeer(host);
  const joined = await joinCollect(joiner, spatial([0, 0, 0], 100));
  assert.deepEqual(snapshotSharedIds(joined), selected, "join snapshot");

  // The same predicate governs subscription replacement.
  const replacer = await connectedPeer(host);
  await joinCollect(replacer, {});
  replacer.send(subscriptionMessage("sub-1", spatial([0, 0, 0], 100)));
  const applied = await replacer.next();
  assert.equal(applied.type, "subscription.applied");
  const entered = (await replacer.take(selected.length)).map((m) => {
    assert.equal(m.type, "view.entity.enter");
    return (m.body.entity as { id: string }).id;
  });
  assert.deepEqual(entered.sort(), selected, "subscription.set enters");
  assert.deepEqual(await replacer.fence(host), [], "nothing else enters");
}));

test("C29 the live publication path uses the same inclusive boundary", () => withHost(async (host) => {
  const observer = await connectedPeer(host);
  await joinCollect(observer, spatial([0, 0, 0], 100));
  const creator = await connectedPeer(host);
  await joinCollect(creator, {});

  assert.equal((await creator.request(createMessage("c-on", "live-on", 100))).type, "ack");
  assert.equal((await creator.request(createMessage("c-off", "live-off", 100.000001))).type, "ack");
  const events = await observer.fence(host);
  assert.deepEqual(events.map((m) => [m.type, (m.body.entity as { id: string }).id]), [["entity.created", "live-on"]]);

  // Moving the outside entity exactly onto the boundary enters; one micro-unit beyond leaves again.
  const move = (id: string, base: number, x: number) => ({
    hvtp: "0.2", id, type: "component.patch", realm: P1_REALM_ID,
    body: { entityId: "live-off", component: "hvtp.transform@1", authorityEpoch: 1, baseRevision: base, patch: { position: [x, 0, 0] } },
  });
  assert.equal((await creator.request(move("m1", 1, 100))).type, "ack");
  assert.equal((await creator.request(move("m2", 2, 100.000001))).type, "ack");
  const crossing = await observer.fence(host);
  assert.deepEqual(crossing.map((m) => m.type), ["view.entity.enter", "view.entity.leave"]);
}));

test("C29 radius 0 selects exactly the center and nothing else", () => withHost(async (host) => {
  place(host, "at-center", [5, 6, 7]);
  place(host, "next-to-center", [5.000001, 6, 7]);
  const peer = await connectedPeer(host);
  assert.deepEqual(snapshotSharedIds(await joinCollect(peer, spatial([5, 6, 7], 0))), ["at-center"]);
}));

test("C29 the advertised maximum radius is accepted", () => withHost(async (host) => {
  place(host, "edge", [P1_LIMITS.maxSubscriptionRadiusMeters, 0, 0]);
  const peer = await connectedPeer(host);
  assert.deepEqual(snapshotSharedIds(await joinCollect(peer, spatial([0, 0, 0], P1_LIMITS.maxSubscriptionRadiusMeters))), ["edge"]);
}));

// [label, spatial value, expected code, placeholder to replace with the raw literal 1e400 (or null)]
const malformed: Array<[string, unknown, string, string | null]> = [
  ["center of length 2", { center: [0, 0], radius: 1 }, "invalid_message", null],
  ["center of length 4", { center: [0, 0, 0, 0], radius: 1 }, "invalid_message", null],
  ["center not an array", { center: "0,0,0", radius: 1 }, "invalid_message", null],
  ["string coordinate", { center: [0, "0", 0], radius: 1 }, "invalid_message", null],
  ["null coordinate", { center: [0, null, 0], radius: 1 }, "invalid_message", null],
  ["negative radius", { center: [0, 0, 0], radius: -1 }, "invalid_message", null],
  ["string radius", { center: [0, 0, 0], radius: "1" }, "invalid_message", null],
  ["missing radius", { center: [0, 0, 0] }, "invalid_message", null],
  ["unknown spatial field", { center: [0, 0, 0], radius: 1, shape: "box" }, "invalid_message", null],
  ["non-finite center (1e400)", { center: [7777777, 0, 0], radius: 1 }, "invalid_message", "7777777"],
  ["non-finite radius (1e400)", { center: [0, 0, 0], radius: 7777777 }, "invalid_message", "7777777"],
  ["radius above advertised maximum", { center: [0, 0, 0], radius: P1_LIMITS.maxSubscriptionRadiusMeters + 0.000001 }, "resource_limit", null],
];

test("C29 malformed spatial selectors are rejected on join and leave the session joinable", () => withHost(async (host) => {
  const peer = await connectedPeer(host);
  for (const [label, value, code, literal] of malformed) {
    const message = joinMessage(`join-${label}`, { spatial: value });
    peer.send(literal === null ? JSON.stringify(message) : withLiteral(message, literal, "1e400"));
    const reply = await peer.next();
    assert.equal(reply.type, "error", label);
    assert.equal(reply.body.code, code, label);
    assert.equal(reply.body.ref, `join-${label}`, label);
  }
  // Every rejected join left the session NEGOTIATED: a valid join still succeeds.
  const joined = await joinCollect(peer, spatial([0, 0, 0], 0));
  assert.equal(joined[0]!.type, "realm.joined");
}));

test("C29 malformed spatial selectors are rejected by subscription.set without changing the active subscription", () => withHost(async (host) => {
  const peer = await connectedPeer(host);
  const joined = await joinCollect(peer, spatial([0, 0, 0], 1));
  const active = joined[0]!.body.subscriptionId;
  for (const [label, value, code, literal] of malformed) {
    const message = subscriptionMessage(`set-${label}`, { spatial: value });
    peer.send(literal === null ? JSON.stringify(message) : withLiteral(message, literal, "1e400"));
    const reply = await peer.next();
    assert.equal(reply.type, "error", label);
    assert.equal(reply.body.code, code, label);
    assert.equal(reply.body.ref, `set-${label}`, label);
  }
  assert.deepEqual(await peer.fence(host), []);
  peer.send(subscriptionMessage("set-ok", spatial([1, 0, 0], 2)));
  const applied = await peer.next();
  assert.equal(applied.type, "subscription.applied");
  assert.equal(applied.body.previousSubscriptionId, active, "rejected requests did not replace the generation");
}));
