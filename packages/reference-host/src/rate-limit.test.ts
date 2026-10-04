import assert from "node:assert/strict";
import test from "node:test";
import { P1_LIMITS, type SessionServerMessage } from "@hvtp/protocol-types";
import { createReferenceHost } from "./server.js";
import { P1Session } from "./session.js";
import { SlidingWindowRateLimiter } from "./rate-limiter.js";
import { P1WorldStore } from "./world-store.js";
import {
  connect, createMessage, helloMessage, joinMessage, joinedPeer, manualClock, subscriptionMessage,
} from "./test-support.js";

const GENERAL = P1_LIMITS.maxClientRequestsPerSecond;
const MUTATION = P1_LIMITS.maxMutationRequestsPerSecond;

function only(messages: readonly SessionServerMessage[]) {
  assert.equal(messages.length, 1);
  return messages[0]!;
}
function code(message: SessionServerMessage): string | undefined {
  return message.type === "error" ? message.body.code : undefined;
}

function newSession(clock = manualClock()) {
  const store = new P1WorldStore(":memory:");
  const session = new P1Session("http://127.0.0.1:1/assets/p1/", "epoch:test", store, { now: clock.now });
  return { store, session, clock };
}
function joinedSession(clock = manualClock()) {
  const fixture = newSession(clock);
  assert.equal(only(fixture.session.handleText(JSON.stringify(helloMessage())).messages).type, "session.welcome");
  fixture.session.handleText(JSON.stringify(joinMessage())).afterEnqueue?.();
  assert.equal(fixture.session.state, "JOINED");
  return fixture;
}

test("sliding window admits exactly `limit` per window, expires at the window edge, and does not record refusals", () => {
  const limiter = new SlidingWindowRateLimiter(3, 1000);
  assert.deepEqual([0, 0, 500].map((t) => limiter.tryAcquire(t)), [true, true, true]);
  assert.equal(limiter.tryAcquire(999), false);
  assert.equal(limiter.tryAcquire(999), false);
  assert.equal(limiter.tryAcquire(1000), true); // the two t=0 admissions expire exactly at t=1000
  assert.equal(limiter.tryAcquire(1000), true);
  assert.equal(limiter.tryAcquire(1000), false); // 500, 1000, 1000 are inside (0, 1000]
  limiter.clear();
  assert.equal(limiter.tryAcquire(1000), true);
});

test("C21 general request rate: first limit requests are processed, the next is resource_limit, window expiry restores service", () => {
  const { session, clock } = joinedSession(); // hello + join consumed 2
  for (let i = 0; i < GENERAL - 2; i++) {
    const response = only(session.handleText(JSON.stringify(helloMessage(`dup-${i}`))).messages);
    assert.equal(code(response), "invalid_state"); // processed under normal semantics
  }
  const limited = only(session.handleText(JSON.stringify(helloMessage("over"))).messages);
  assert.equal(code(limited), "resource_limit");
  assert.equal(limited.type === "error" && limited.body.ref, "over");
  assert.equal(session.state, "JOINED");
  clock.advance(999);
  assert.equal(code(only(session.handleText(JSON.stringify(helloMessage("still"))).messages)), "resource_limit");
  clock.advance(1);
  assert.equal(code(only(session.handleText(JSON.stringify(helloMessage("again"))).messages)), "invalid_state");
});

test("C21 malformed and decodable-but-invalid requests spend general budget; rejected hello stays CONNECTED", () => {
  const { session, clock } = newSession();
  for (let i = 0; i < GENERAL; i++) assert.equal(code(only(session.handleText("{").messages)), "invalid_json");
  const limited = only(session.handleText("{").messages);
  assert.equal(code(limited), "resource_limit");
  assert.equal(limited.type === "error" && limited.body.ref, null);
  assert.equal(session.state, "CONNECTED");
  clock.advance(1000);
  for (let i = 0; i < GENERAL; i++) {
    assert.equal(code(only(session.handleText(JSON.stringify({ hvtp: "0.2", id: `bad-${i}`, type: "no.such" })).messages)), "unsupported_message");
  }
  const decodable = only(session.handleText(JSON.stringify({ hvtp: "0.2", id: "bad-over", type: "no.such" })).messages);
  assert.equal(code(decodable), "resource_limit");
  assert.equal(decodable.type === "error" && decodable.body.ref, "bad-over");
  clock.advance(1000);
  assert.equal(only(session.handleText(JSON.stringify(helloMessage())).messages).type, "session.welcome");
});

test("C21 durable mutation rate: new request above the limit executes nothing, reserves no ID, and succeeds after expiry", () => {
  const { session, store, clock } = joinedSession();
  const acks: SessionServerMessage[] = [];
  for (let i = 0; i < MUTATION; i++) {
    acks.push(only(session.handleText(JSON.stringify(createMessage(`req-${i}`, `E${i}`))).messages));
    assert.equal(acks[i]!.type, "ack");
  }
  assert.equal(store.getRealmSeq(), MUTATION);

  const limited = only(session.handleText(JSON.stringify(createMessage("req-over", "over"))).messages);
  assert.equal(code(limited), "resource_limit");
  assert.equal(limited.type === "error" && limited.body.ref, "req-over");
  assert.equal(store.getEntity("over"), null);
  assert.equal(store.isTombstoned("over"), false);
  assert.equal(store.getRealmSeq(), MUTATION);

  // Not reserved: an identical retry is limited again, never request_id_conflict, even with different content.
  assert.equal(code(only(session.handleText(JSON.stringify(createMessage("req-over", "over"))).messages)), "resource_limit");
  assert.equal(code(only(session.handleText(JSON.stringify(createMessage("req-over", "other-entity"))).messages)), "resource_limit");

  // Existing-ID lookup precedes the mutation bucket: cached ACK replays, differing content conflicts, no re-execution.
  assert.deepEqual(only(session.handleText(JSON.stringify(createMessage("req-0", "E0"))).messages), acks[0]);
  assert.equal(code(only(session.handleText(JSON.stringify(createMessage("req-0", "E-different"))).messages)), "request_id_conflict");
  assert.equal(store.getRealmSeq(), MUTATION);

  // subscription.set is state-changing but does not draw from the durable-mutation bucket.
  assert.notEqual(code(only(session.handleText(JSON.stringify(subscriptionMessage("sub", {}))).messages)), "resource_limit");

  clock.advance(1000);
  assert.equal(only(session.handleText(JSON.stringify(createMessage("req-over", "over"))).messages).type, "ack");
  assert.equal(store.getRealmSeq(), MUTATION + 1);
  assert.notEqual(store.getEntity("over"), null);
});

test("C21 wire: flooding connection A does not limit connection B; refused requests do not change the view or reserve IDs", async () => {
  const clock = manualClock();
  const host = await createReferenceHost({ databasePath: ":memory:", clock: clock.now });
  try {
    const flooder = await connect(host);
    flooder.send(helloMessage("h0"));
    for (let i = 1; i < GENERAL + 5; i++) flooder.send(helloMessage(`h${i}`));
    const replies = await flooder.take(GENERAL + 5);
    assert.equal(replies[0]!.type, "session.welcome");
    assert.ok(replies.slice(1, GENERAL).every((reply) => reply.body.code === "invalid_state"));
    assert.ok(replies.slice(GENERAL).every((reply) => reply.body.code === "resource_limit"));
    assert.equal(replies[GENERAL]!.body.ref, `h${GENERAL}`);
    assert.equal(flooder.socket.readyState, flooder.socket.OPEN); // healthy connection stays open

    const bystander = await connect(host); // same host, same frozen clock
    assert.equal((await bystander.request(helloMessage())).type, "session.welcome");

    const subscriber = await joinedPeer(host); // hello + join = 2 requests
    const joinedSubscription = (await (async () => { subscriber.send(subscriptionMessage("probe", {})); return subscriber.next(); })());
    assert.equal(joinedSubscription.type, "subscription.applied"); // 3rd request
    for (let i = 0; i < GENERAL - 3; i++) subscriber.send(helloMessage(`pad-${i}`));
    await subscriber.take(GENERAL - 3);
    subscriber.send(subscriptionMessage("S1", { entities: ["x"] }));
    const refused = await subscriber.next();
    assert.equal(refused.body.code, "resource_limit");
    assert.equal(refused.body.ref, "S1");
    clock.advance(1000);
    subscriber.send(subscriptionMessage("S1", { entities: ["x"] }));
    const applied = await subscriber.next();
    assert.equal(applied.type, "subscription.applied"); // not request_id_conflict / cached refusal
    assert.equal(applied.body.previousSubscriptionId, joinedSubscription.body.subscriptionId);
    for (const peer of [flooder, bystander, subscriber]) peer.socket.close();
  } finally {
    await host.close();
  }
});
