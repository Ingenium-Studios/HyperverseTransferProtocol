import assert from "node:assert/strict";
import test from "node:test";
import { P1_REALM_ID } from "@hvtp/protocol-types";
import {
  connect, connectedPeer, createMessage, cubeInput, deleteMessage, helloMessage, joinCollect, joinMessage, subscriptionMessage,
  withHost,
} from "./test-support.js";

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

test("C25 explicit correlation fixture: unknown top-level field is invalid_message correlated to the request id, with no mutation", () =>
  withHost(async (host) => {
    host.worldStore.createEntity(cubeInput("entity:example"));
    const observer = await connectedPeer(host);
    await joinCollect(observer, { entities: ["entity:example"] });
    const peer = await connectedPeer(host);
    await joinCollect(peer, {});
    const fixture = {
      hvtp: "0.2",
      id: "b4448cc1-04ed-4e8f-bcc5-20a4df4b7d19",
      type: "entity.delete",
      realm: "urn:hvtp:realm:prototype-world",
      body: { entityId: "entity:example" },
      unexpected: true,
    };
    const reply = await peer.request(JSON.stringify(fixture));
    assert.equal(reply.type, "error");
    assert.equal(reply.body.code, "invalid_message");
    assert.equal(reply.body.ref, "b4448cc1-04ed-4e8f-bcc5-20a4df4b7d19");
    assert.notEqual(host.worldStore.getEntity("entity:example"), null);
    assert.equal(host.worldStore.isTombstoned("entity:example"), false);
    assert.equal(host.worldStore.getRealmSeq(), 1);
    assert.deepEqual(await observer.fence(host), []);
    // The error is the cached terminal result of that request id: an identical retry replays it and still mutates nothing.
    const retry = await peer.request(JSON.stringify(fixture));
    assert.deepEqual(retry, reply);
    assert.notEqual(host.worldStore.getEntity("entity:example"), null);
  }));

test("C25 unknown top-level and body fields are rejected for every state-changing message without mutation", () => withHost(async (host) => {
  host.worldStore.createEntity(cubeInput("target"));
  const peer = await connectedPeer(host);
  await joinCollect(peer, { entities: ["target"] });
  const before = JSON.stringify(host.worldStore.getEntity("target"));
  const transform = cubeInput("target").transform;
  const valid: Record<string, any> = {
    create: createMessage("x", "entity:new"),
    delete: deleteMessage("x", "target"),
    set: { hvtp: "0.2", id: "x", type: "component.set", realm: P1_REALM_ID,
      body: { entityId: "target", component: "hvtp.transform@1", authorityEpoch: 1, baseRevision: 1, state: transform } },
    patch: { hvtp: "0.2", id: "x", type: "component.patch", realm: P1_REALM_ID,
      body: { entityId: "target", component: "hvtp.transform@1", authorityEpoch: 1, baseRevision: 1, patch: { position: [1, 0, 0] } } },
    subscription: subscriptionMessage("x", { entities: ["target"] }),
  };
  let n = 0;
  for (const [name, template] of Object.entries(valid)) {
    const topLevel = { ...template, id: `top-${name}-${++n}`, unexpected: true };
    const bodyField = { ...template, id: `body-${name}-${++n}`, body: { ...template.body, unexpected: true } };
    const nested = name === "create"
      ? { ...template, id: `nested-${name}-${++n}`, body: { entity: { ...template.body.entity, unexpected: 1 } } }
      : null;
    for (const request of [topLevel, bodyField, ...(nested === null ? [] : [nested])]) {
      const reply = await peer.request(request);
      assert.equal(reply.type, "error", request.id);
      assert.equal(reply.body.code, "invalid_message", request.id);
      assert.equal(reply.body.ref, request.id, request.id);
    }
  }
  assert.equal(JSON.stringify(host.worldStore.getEntity("target")), before);
  assert.equal(host.worldStore.getEntity("entity:new"), null);
  assert.equal(host.worldStore.getRealmSeq(), 1);
  assert.deepEqual(await peer.fence(host), []);
}));

test("C25 missing, empty, non-string and decoded-duplicate request ids are invalid_message with a null ref", () => withHost(async (host) => {
  const peer = await connectedPeer(host);
  await joinCollect(peer, {});
  const base = deleteMessage("ignored", "nothing");
  const { id: _omit, ...withoutId } = base;
  const inputs: Array<[string, string]> = [
    ["missing id", JSON.stringify(withoutId)],
    ["empty id", JSON.stringify({ ...base, id: "" })],
    ["numeric id", JSON.stringify({ ...base, id: 7 })],
    ["null id", JSON.stringify({ ...base, id: null })],
    ["object id", JSON.stringify({ ...base, id: {} })],
    ["decoded duplicate id", '{"hvtp":"0.2","id":"a","\\u0069d":"b","type":"entity.delete","realm":"urn:hvtp:realm:prototype-world","body":{"entityId":"nothing"}}'],
    ["duplicate nested key keeps the id", '{"hvtp":"0.2","id":"dup-nested","type":"entity.delete","realm":"urn:hvtp:realm:prototype-world","body":{"entityId":"a","entityId":"b"}}'],
  ];
  for (const [label, wire] of inputs) {
    peer.send(wire);
    const reply = await peer.next();
    assert.equal(reply.type, "error", label);
    assert.equal(reply.body.code, "invalid_message", label);
    // A duplicate key below the top level does not destroy a usable top-level id.
    assert.equal(reply.body.ref, label === "duplicate nested key keeps the id" ? "dup-nested" : null, label);
  }
  assert.equal(host.worldStore.getRealmSeq(), 0);
}));

test("C25 ids longer than 128 UTF-8 bytes are rejected (multibyte counted in bytes); 128 bytes is accepted", () => withHost(async (host) => {
  const peer = await connectedPeer(host);
  await joinCollect(peer, {});
  const tooLongAscii = "a".repeat(129);
  const tooLongTwoByte = "é".repeat(65); // 130 bytes, 65 characters
  const tooLongThreeByte = "€".repeat(43); // 129 bytes, 43 characters
  const exactTwoByte = "é".repeat(64); // 128 bytes
  const exactThreeByte = `${"€".repeat(42)}ab`; // 128 bytes
  assert.deepEqual([tooLongAscii, tooLongTwoByte, tooLongThreeByte, exactTwoByte, exactThreeByte].map(bytes), [129, 130, 129, 128, 128]);

  // Request ids: no usable id remains, so the correlation is null.
  for (const id of [tooLongAscii, tooLongTwoByte, tooLongThreeByte]) {
    const reply = await peer.request(createMessage(id, "entity:ok"));
    assert.equal(reply.body.code, "invalid_message");
    assert.equal(reply.body.ref, null);
  }
  // Entity ids: the request id is valid and is echoed.
  const mutations = (id: string, entityId: string) => [
    createMessage(id, entityId),
    deleteMessage(id, entityId),
    { hvtp: "0.2", id, type: "component.set", realm: P1_REALM_ID,
      body: { entityId, component: "hvtp.transform@1", authorityEpoch: 1, baseRevision: 1, state: cubeInput(entityId).transform } },
  ];
  let n = 0;
  for (const entityId of [tooLongAscii, tooLongTwoByte, tooLongThreeByte]) {
    for (const request of mutations(`long-entity-${++n}`, entityId).map((r, i) => ({ ...r, id: `long-entity-${n}-${i}` }))) {
      const reply = await peer.request(request);
      assert.equal(reply.body.code, "invalid_message", request.type);
      assert.equal(reply.body.ref, request.id);
    }
  }
  const subscription = await peer.request(subscriptionMessage("long-sub", { entities: [tooLongTwoByte] }));
  assert.equal(subscription.body.code, "invalid_message");
  assert.equal(subscription.body.ref, "long-sub");
  assert.equal(host.worldStore.getRealmSeq(), 0);

  // Exactly 128 bytes is legal as both a request id and an entity id.
  assert.equal((await peer.request(createMessage(exactTwoByte, exactThreeByte))).type, "ack");
  assert.notEqual(host.worldStore.getEntity(exactThreeByte), null);
  const echoed = await peer.request(deleteMessage(exactThreeByte, exactThreeByte));
  assert.equal(echoed.type, "ack");
  assert.equal(echoed.body.ref, exactThreeByte);
}));

test("C25 participant kind other than human or agent is rejected and the session stays CONNECTED", () => withHost(async (host) => {
  const peer = await connect(host);
  for (const kind of ["robot", "", "Human", "AGENT", null, 1, ["human"], {}]) {
    const request = helloMessage(`hello-${JSON.stringify(kind)}`) as any;
    request.body.participant = { kind };
    const reply = await peer.request(request);
    assert.equal(reply.body.code, "invalid_message", JSON.stringify(kind));
    assert.equal(reply.body.ref, request.id);
  }
  const noKind = helloMessage("hello-no-kind") as any;
  noKind.body.participant = {};
  assert.equal((await peer.request(noKind)).body.code, "invalid_message");
  const extra = helloMessage("hello-extra") as any;
  extra.body.participant = { kind: "human", role: "admin" };
  assert.equal((await peer.request(extra)).body.code, "invalid_message");
  for (const kind of ["human", "agent"]) {
    const other = await connect(host);
    const request = helloMessage(`hello-${kind}`) as any;
    request.body.participant = { kind };
    assert.equal((await other.request(request)).type, "session.welcome");
  }
  // Still CONNECTED after every rejection: a valid hello now succeeds.
  assert.equal((await peer.request(helloMessage("hello-ok"))).type, "session.welcome");
}));

test("C25 host-publication types sent client-to-host are rejected with the request id and mutate nothing", () => withHost(async (host) => {
  host.worldStore.createEntity(cubeInput("E"));
  const peer = await connect(host);
  const hostTypes = [
    "entity.created", "entity.deleted", "component.updated", "view.entity.enter", "view.entity.leave", "entity.snapshot",
    "realm.snapshot.begin", "realm.snapshot.end", "realm.joined", "session.welcome", "subscription.applied", "ack", "error",
  ];
  const publication = (type: string, id: string) => ({
    hvtp: "0.2", id, type, realm: P1_REALM_ID, realmEpoch: host.realmEpoch, seq: 1,
    body: { subscriptionId: "s", entityId: "E", entity: createMessage("x", "entity:forged").body.entity },
  });
  const accepted = ["invalid_message", "unsupported_message"];
  // Rejected in every session state (the type is never a client request).
  for (const stage of ["connected", "negotiated", "joined"]) {
    if (stage === "negotiated") await peer.hello();
    if (stage === "joined") await joinCollect(peer, { entities: ["E"] });
    for (const type of hostTypes) {
      const id = `${stage}-${type}`;
      const reply = await peer.request(publication(type, id));
      assert.equal(reply.type, "error", id);
      assert.ok(accepted.includes(reply.body.code!), `${id}: ${reply.body.code}`);
      assert.equal(reply.body.ref, id);
    }
  }
  assert.equal(host.worldStore.getRealmSeq(), 1, "no mutation beyond the seeded entity");
  assert.equal(host.worldStore.getEntity("entity:forged"), null);
  assert.deepEqual(await peer.fence(host), []);
}));

const selectors: Array<[string, Record<string, unknown>]> = [
  ["empty selector", {}],
  ["entities only", { entities: ["a", "b"] }],
  ["empty entities list", { entities: [] }],
  ["spatial only", { spatial: { center: [1, 2, 3], radius: 4 } }],
  ["spatial and entities", { spatial: { center: [0, 0, 0], radius: 0 }, entities: ["a"] }],
];

test("C25 SubscriptionSelector positive shapes are accepted by realm.join and subscription.set and echoed", () => withHost(async (host) => {
  for (const [label, selector] of selectors) {
    const joiner = await connectedPeer(host);
    const joined = await joinCollect(joiner, selector, `join-${label}`);
    assert.equal(joined[0]!.type, "realm.joined", label);
    assert.deepEqual(joined[0]!.body.effectiveSubscription, selector, label);

    const replacer = await connectedPeer(host);
    await joinCollect(replacer, {});
    replacer.send(subscriptionMessage(`set-${label}`, selector));
    const applied = await replacer.next();
    assert.equal(applied.type, "subscription.applied", label);
    assert.deepEqual(applied.body.effectiveSubscription, selector, label);
    assert.equal(applied.body.ref, `set-${label}`);
  }
}));

test("C25 required selector fields and closed selector shapes are enforced", () => withHost(async (host) => {
  const peer = await connectedPeer(host);
  const bad: Array<[string, unknown]> = [
    ["join without subscription", { hvtp: "0.2", id: "j1", type: "realm.join", body: { realm: P1_REALM_ID } }],
    ["join without realm", { hvtp: "0.2", id: "j2", type: "realm.join", body: { subscription: {} } }],
    ["join with null subscription", joinMessage("j3", null as never)],
    ["join with array subscription", joinMessage("j4", [] as never)],
    ["join with unknown selector field", joinMessage("j5", { radius: 3 })],
    ["join with non-array entities", joinMessage("j6", { entities: "a" })],
    ["join with non-string entity", joinMessage("j7", { entities: [1] })],
    ["join with empty entity id", joinMessage("j8", { entities: [""] })],
    ["join with extra body field", { ...joinMessage("j9"), body: { realm: P1_REALM_ID, subscription: {}, extra: 1 } }],
    ["join with spatial missing radius", joinMessage("j10", { spatial: { center: [0, 0, 0] } })],
  ];
  for (const [label, request] of bad) {
    const reply = await peer.request(request);
    assert.equal(reply.body.code, "invalid_message", label);
    assert.equal(reply.body.ref, (request as { id: string }).id, label);
  }
  await joinCollect(peer, {});
  const badSet: Array<[string, unknown]> = [
    ["set with unknown field", subscriptionMessage("s1", { filter: 1 })],
    ["set with non-array entities", subscriptionMessage("s2", { entities: {} })],
    ["set with null body", subscriptionMessage("s3", null as never)],
  ];
  for (const [label, request] of badSet) {
    const reply = await peer.request(request);
    assert.equal(reply.body.code, "invalid_message", label);
    assert.equal(reply.body.ref, (request as { id: string }).id, label);
  }
}));
