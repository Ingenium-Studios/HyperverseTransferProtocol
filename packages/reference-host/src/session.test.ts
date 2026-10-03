import assert from "node:assert/strict";
import test from "node:test";
import { P1Session, type SessionDispatch } from "./session.js";

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

function join(subscription: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hvtp: "0.2",
    id: "req-join",
    type: "realm.join",
    body: {
      realm: "urn:hvtp:realm:prototype-world",
      subscription,
    },
  });
}

function only(dispatch: SessionDispatch) {
  assert.equal(dispatch.messages.length, 1);
  return dispatch.messages[0]!;
}

test("session.hello negotiates exactly once", () => {
  const session = new P1Session("http://127.0.0.1:8787/assets/p1/", "epoch:test");
  const first = only(session.handleText(hello()));
  assert.equal(first.type, "session.welcome");
  assert.equal(session.state, "NEGOTIATED");

  const second = only(session.handleText(hello()));
  assert.equal(second.type, "error");
  if (second.type === "error") {
    assert.equal(second.body.code, "invalid_state");
    assert.equal(second.body.ref, "req-hello");
  }
});

test("realm message before welcome is invalid_state", () => {
  const session = new P1Session("http://127.0.0.1:8787/assets/p1/", "epoch:test");
  const result = only(session.handleText(join()));
  assert.equal(result.type, "error");
  if (result.type === "error") assert.equal(result.body.code, "invalid_state");
});

test("invalid closed shape preserves a unique request id", () => {
  const session = new P1Session("http://127.0.0.1:8787/assets/p1/", "epoch:test");
  const result = only(session.handleText(hello({ unexpected: true })));
  assert.equal(result.type, "error");
  if (result.type === "error") {
    assert.equal(result.body.code, "invalid_message");
    assert.equal(result.body.ref, "req-hello");
  }
});

test("realm.join enqueues joined + one private presence snapshot before JOINED", () => {
  const session = new P1Session("http://127.0.0.1:8787/assets/p1/", "epoch:test");
  const welcome = only(session.handleText(hello()));
  assert.equal(welcome.type, "session.welcome");
  if (welcome.type !== "session.welcome") return;

  const dispatch = session.handleText(join({
    spatial: { center: [0, 0, 0], radius: 100 },
    entities: [],
  }));

  assert.equal(session.state, "JOINING");
  assert.deepEqual(dispatch.messages.map((message) => message.type), [
    "realm.joined",
    "realm.snapshot.begin",
    "entity.snapshot",
    "realm.snapshot.end",
  ]);

  const [joined, begin, entity, end] = dispatch.messages;
  assert.equal(joined?.type, "realm.joined");
  assert.equal(begin?.type, "realm.snapshot.begin");
  assert.equal(entity?.type, "entity.snapshot");
  assert.equal(end?.type, "realm.snapshot.end");
  if (
    joined?.type !== "realm.joined" ||
    begin?.type !== "realm.snapshot.begin" ||
    entity?.type !== "entity.snapshot" ||
    end?.type !== "realm.snapshot.end"
  ) {
    return;
  }

  assert.equal(joined.realmEpoch, "epoch:test");
  assert.equal(begin.realmEpoch, "epoch:test");
  assert.equal(entity.realmEpoch, "epoch:test");
  assert.equal(end.realmEpoch, "epoch:test");

  assert.equal(joined.body.snapshotId, begin.body.snapshotId);
  assert.equal(joined.body.snapshotId, entity.body.snapshotId);
  assert.equal(joined.body.snapshotId, end.body.snapshotId);
  assert.equal(joined.body.snapshotBaseSeq, 0);
  assert.equal(begin.body.snapshotBaseSeq, 0);
  assert.equal(entity.body.snapshotBaseSeq, 0);
  assert.equal(end.body.snapshotBaseSeq, 0);
  assert.equal(end.body.entityCount, 1);

  assert.equal(joined.body.participantId, welcome.body.participantId);
  assert.equal(joined.body.presenceEntityId, entity.body.entity.id);
  assert.ok("hvtp.presence@1" in entity.body.entity.components);
  if ("hvtp.presence@1" in entity.body.entity.components) {
    assert.equal(
      entity.body.entity.components["hvtp.presence@1"].state.participantId,
      welcome.body.participantId,
    );
    assert.equal(entity.body.entity.components["hvtp.presence@1"].state.kind, "agent");
  }
  assert.deepEqual(Object.keys(entity.body.entity.components).sort(), ["hvtp.presence@1", "hvtp.transform@1"]);
  assert.deepEqual(joined.body.effectiveSubscription, {
    spatial: { center: [0, 0, 0], radius: 100 },
    entities: [],
  });

  const duringJoin = only(session.handleText(join()));
  assert.equal(duringJoin.type, "error");
  if (duringJoin.type === "error") {
    assert.equal(duringJoin.body.code, "invalid_state");
    assert.equal(duringJoin.realm, "urn:hvtp:realm:prototype-world");
    assert.equal(duringJoin.realmEpoch, "epoch:test");
  }

  dispatch.afterEnqueue?.();
  assert.equal(session.state, "JOINED");

  const secondJoin = only(session.handleText(join()));
  assert.equal(secondJoin.type, "error");
  if (secondJoin.type === "error") {
    assert.equal(secondJoin.body.code, "invalid_state");
    assert.equal(secondJoin.realm, "urn:hvtp:realm:prototype-world");
    assert.equal(secondJoin.realmEpoch, "epoch:test");
  }
});

test("invalid realm.join leaves the session NEGOTIATED", () => {
  const session = new P1Session("http://127.0.0.1:8787/assets/p1/", "epoch:test");
  only(session.handleText(hello()));

  const result = only(session.handleText(JSON.stringify({
    hvtp: "0.2",
    id: "req-invalid-join",
    type: "realm.join",
    body: {
      realm: "urn:hvtp:realm:prototype-world",
      subscription: { spatial: { center: [0, 0, 0], radius: 999 } },
    },
  })));

  assert.equal(result.type, "error");
  if (result.type === "error") assert.equal(result.body.code, "resource_limit");
  assert.equal(session.state, "NEGOTIATED");
});
