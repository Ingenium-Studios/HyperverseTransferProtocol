import assert from "node:assert/strict";
import test from "node:test";
import { P1_REALM_ID } from "@hvtp/protocol-types";
import {
  connect, connectedPeer, createMessage, cubeInput, joinCollect, setTransformMessage, withHost,
} from "./test-support.js";
import type { ReferenceHost } from "./server.js";

const ACCEPTABLE = ["not_authorized", "presence_binding_violation"];
const transformState = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };

const mutation = (id: string, type: "component.set" | "component.patch", entityId: string, component: string, payload: unknown) => ({
  hvtp: "0.2", id, type, realm: P1_REALM_ID,
  body: { entityId, component, authorityEpoch: 1, baseRevision: 1, ...(type === "component.set" ? { state: payload } : { patch: payload }) },
});

async function twoParticipants(host: ReferenceHost) {
  host.worldStore.createEntity(cubeInput("shared"));
  const a = await connectedPeer(host);
  const aJoin = await joinCollect(a, { spatial: { center: [0, 0, 0], radius: 100 } });
  const b = await connectedPeer(host);
  const bJoin = await joinCollect(b, { spatial: { center: [0, 0, 0], radius: 100 } });
  return {
    a, b,
    aPresence: aJoin[0]!.body.presenceEntityId as string,
    bPresence: bJoin[0]!.body.presenceEntityId as string,
    bParticipant: bJoin[0]!.body.participantId as string,
  };
}

test("C14/C27 presence matrix: every impersonation, presence mutation and renderable mutation is rejected without any change", () => withHost(async (host) => {
  const { a, b, aPresence, bPresence, bParticipant } = await twoParticipants(host);
  const seq = host.worldStore.getRealmSeq();
  const sharedBefore = JSON.stringify(host.worldStore.getEntity("shared"));

  const presenceState = { participantId: bParticipant, kind: "human" };
  const requests: Array<[string, unknown]> = [
    ["create entity containing presence bound to B", (() => {
      const request = createMessage("create-bound", "entity:bound-to-b", 0) as any;
      request.body.entity.components["hvtp.presence@1"] = { state: presenceState };
      return request;
    })()],
  ];
  for (const [label, entityId] of [["B", bPresence], ["own", aPresence]] as const) {
    for (const type of ["component.set", "component.patch"] as const) {
      const short = type.split(".")[1];
      requests.push([`${short} ${label} presence component`, mutation(`${short}-${label}-presence`, type, entityId, "hvtp.presence@1",
        type === "component.set" ? presenceState : { kind: "agent" })]);
      requests.push([`${short} ${label} presence transform`, mutation(`${short}-${label}-transform`, type, entityId, "hvtp.transform@1",
        type === "component.set" ? transformState : { position: [1, 1, 1] })]);
    }
    requests.push([`delete ${label} presence entity`, { hvtp: "0.2", id: `delete-${label}`, type: "entity.delete", realm: P1_REALM_ID, body: { entityId } }]);
  }
  for (const type of ["component.set", "component.patch"] as const) {
    const short = type.split(".")[1];
    requests.push([`${short} shared renderable`, mutation(`${short}-shared-renderable`, type, "shared", "hvtp.renderable@1",
      type === "component.set" ? cubeInput("shared").renderable : { visible: false })]);
    requests.push([`${short} presence component on shared entity`, mutation(`${short}-shared-presence`, type, "shared", "hvtp.presence@1",
      type === "component.set" ? presenceState : { kind: "agent" })]);
  }

  for (const [label, request] of requests) {
    const reply = await a.request(request);
    assert.equal(reply.type, "error", label);
    assert.ok(ACCEPTABLE.includes(reply.body.code!), `${label}: got ${reply.body.code}`);
    assert.equal(reply.body.ref, (request as { id: string }).id, label);
    assert.equal(host.worldStore.getRealmSeq(), seq, `${label}: seq advanced`);
  }
  assert.equal(JSON.stringify(host.worldStore.getEntity("shared")), sharedBefore, "shared entity untouched (all revisions stay 1)");
  for (const id of [aPresence, bPresence, "entity:bound-to-b"]) {
    assert.equal(host.worldStore.getEntity(id), null, `${id} never becomes durable`);
    assert.equal(host.worldStore.isTombstoned(id), false, `${id} never tombstoned`);
  }
  assert.deepEqual(await a.fence(host), [], "A saw no publication");
  assert.deepEqual(await b.fence(host), [], "B saw no publication; its presence state did not change");
  // B's presence is still host-protected afterwards: the attack did not unregister it.
  assert.equal(host.realmCoordinator.isPrivatePresenceEntity(bPresence), true);
  assert.equal(host.realmCoordinator.isPrivatePresenceEntity(aPresence), true);
}));

test("C14 when B disconnects its presence disappears silently: no tombstone, no seq advance, nothing sent to A", () => withHost(async (host) => {
  const { a, b, bPresence } = await twoParticipants(host);
  const seq = host.worldStore.getRealmSeq();
  assert.equal(host.realmCoordinator.privatePresenceCount, 2);
  b.socket.close();
  await b.closed;
  // The host observes the close on its own event loop turn; wait on the observable condition, not a timer.
  while (host.realmCoordinator.privatePresenceCount > 1) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(host.realmCoordinator.subscriberCount, 1);
  assert.equal(host.realmCoordinator.isPrivatePresenceEntity(bPresence), false);
  assert.equal(host.worldStore.isTombstoned(bPresence), false);
  assert.equal(host.worldStore.getEntity(bPresence), null);
  assert.equal(host.worldStore.getRealmSeq(), seq);
  assert.deepEqual(await a.fence(host), [], "A never learns of B's presence or its removal");
}));

test("C15 component.ephemeral is rejected in every session state and never mutates or publishes", () => withHost(async (host) => {
  host.worldStore.createEntity(cubeInput("shared"));
  const peer = await connect(host);
  const ephemeral = (id: string) => ({
    hvtp: "0.2", id, type: "component.ephemeral", realm: P1_REALM_ID,
    body: { entityId: "shared", component: "hvtp.transform@1", state: { position: [9, 9, 9], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } },
  });

  // Before hello and before join the state machine answers first (profile 14.1: realm-scoped traffic is invalid_state).
  const connectedReply = await peer.request(ephemeral("eph-connected"));
  assert.equal(connectedReply.body.code, "invalid_state");
  await peer.hello();
  const negotiatedReply = await peer.request(ephemeral("eph-negotiated"));
  assert.equal(negotiatedReply.body.code, "invalid_state");

  const observer = await connectedPeer(host);
  await joinCollect(observer, { entities: ["shared"] });
  await joinCollect(peer, {});
  const seq = host.worldStore.getRealmSeq();
  const before = JSON.stringify(host.worldStore.getEntity("shared"));

  const joinedReply = await peer.request(ephemeral("eph-joined"));
  assert.equal(joinedReply.type, "error");
  assert.equal(joinedReply.body.code, "unsupported_message");
  assert.equal(joinedReply.body.ref, "eph-joined");
  // A minimal envelope with only the type (and a request id) is rejected the same way.
  const minimal = await peer.request({ hvtp: "0.2", id: "eph-minimal", type: "component.ephemeral" });
  assert.equal(minimal.body.code, "unsupported_message");
  assert.equal(minimal.body.ref, "eph-minimal");

  assert.equal(host.worldStore.getRealmSeq(), seq);
  assert.equal(JSON.stringify(host.worldStore.getEntity("shared")), before);
  assert.deepEqual(await observer.fence(host), []);
  // The session stays JOINED and usable.
  assert.equal((await peer.request(setTransformMessage("after-eph", "shared", 1, 3))).type, "ack");
}));

test("C15 the literal abbreviated example (no request id) is rejected as invalid_message with a null ref", () => withHost(async (host) => {
  // Profile 14.0 closes the wire shape: a request without a valid top-level id is a shape violation whose
  // correlation is null. The conformance example is an abbreviation; with no id there is nothing to correlate and
  // the shape check precedes type dispatch. The request is rejected, mutates nothing, and the session survives.
  const peer = await connectedPeer(host);
  await joinCollect(peer, {});
  const reply = await peer.request(JSON.stringify({ type: "component.ephemeral" }));
  assert.equal(reply.type, "error");
  assert.equal(reply.body.code, "invalid_message");
  assert.equal(reply.body.ref, null);
  assert.equal(host.worldStore.getRealmSeq(), 0);
}));

