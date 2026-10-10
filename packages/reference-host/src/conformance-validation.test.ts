import assert from "node:assert/strict";
import test from "node:test";
import { P1_LIMITS, P1_REALM_ID } from "@hvtp/protocol-types";
import type { ReferenceHost } from "./server.js";
import {
  connectedPeer, createMessage, cubeInput, joinCollect, withHost, withLiteral, type Peer,
} from "./test-support.js";

const baseTransform = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const baseMaterial = { baseColor: [1, 1, 1, 1] };
const baseRenderable = { asset: { uri: "unit-cube.gltf", mediaType: "model/gltf+json" }, node: "UnitCube", visible: true };

interface Case { label: string; value: unknown; raw?: [string, string] }
const text = (request: unknown, raw?: [string, string]): string => raw === undefined ? JSON.stringify(request) : withLiteral(request, raw[0], raw[1]);

function createWith(id: string, entityId: string, parts: { transform?: unknown; renderable?: unknown; material?: unknown }) {
  return {
    hvtp: "0.2", id, type: "entity.create", realm: P1_REALM_ID,
    body: { entity: { id: entityId, components: {
      "hvtp.transform@1": { state: parts.transform ?? baseTransform },
      "hvtp.renderable@1": { state: parts.renderable ?? baseRenderable },
      "hvtp.material@1": { state: parts.material ?? baseMaterial },
    } } },
  };
}
const setRequest = (id: string, entityId: string, component: string, baseRevision: unknown, state: unknown, authorityEpoch: unknown = 1) => ({
  hvtp: "0.2", id, type: "component.set", realm: P1_REALM_ID, body: { entityId, component, authorityEpoch, baseRevision, state },
});
const patchRequest = (id: string, entityId: string, component: string, baseRevision: unknown, patch: unknown, authorityEpoch: unknown = 1) => ({
  hvtp: "0.2", id, type: "component.patch", realm: P1_REALM_ID, body: { entityId, component, authorityEpoch, baseRevision, patch },
});

async function fixture(host: ReferenceHost, watched: string[]) {
  for (const id of watched) host.worldStore.createEntity(cubeInput(id));
  const observer = await connectedPeer(host);
  await joinCollect(observer, { entities: watched });
  const requester = await connectedPeer(host);
  await joinCollect(requester, {});
  const state = () => JSON.stringify([host.worldStore.getRealmSeq(), ...watched.map((id) => host.worldStore.getEntity(id))]);
  return { observer, requester, state };
}

async function rejected(peer: Peer, request: unknown, code: string, label: string, state: () => string, raw?: [string, string]) {
  const before = state();
  const reply = await peer.request(text(request, raw));
  assert.equal(reply.type, "error", label);
  assert.equal(reply.body.code, code, `${label}: ${reply.body.message}`);
  assert.equal(reply.body.ref, (request as { id: string }).id, label);
  assert.equal(state(), before, `${label}: state or seq changed`);
  return reply;
}

// ---------------------------------------------------------------- C16 / C34 renderable validation

test("C16/C34 renderable fixture: every deviation is invalid_component_state, an over-long URI is resource_limit, nothing is created", () => withHost(async (host) => {
  const { observer, requester, state } = await fixture(host, []);
  const asset = (patch: object) => ({ ...baseRenderable, asset: { ...baseRenderable.asset, ...patch } });
  const deviations: Array<[string, unknown]> = [
    ["other uri", asset({ uri: "other.gltf" })],
    ["relative-escape uri", asset({ uri: "../unit-cube.gltf" })],
    ["case-variant uri", asset({ uri: "UNIT-CUBE.GLTF" })],
    ["absolute uri", asset({ uri: "https://example.invalid/unit-cube.gltf" })],
    ["empty uri", asset({ uri: "" })],
    ["non-string uri", asset({ uri: 7 })],
    ["wrong mediaType", asset({ mediaType: "model/gltf-binary" })],
    ["non-string mediaType", asset({ mediaType: null })],
    ["wrong node", { ...baseRenderable, node: "Cube" }],
    ["non-string node", { ...baseRenderable, node: 1 }],
    ["string visible", { ...baseRenderable, visible: "true" }],
    ["numeric visible", { ...baseRenderable, visible: 1 }],
    ["null visible", { ...baseRenderable, visible: null }],
    ["extra asset field", asset({ extra: true })],
    ["missing mediaType", { ...baseRenderable, asset: { uri: "unit-cube.gltf" } }],
    ["asset not an object", { ...baseRenderable, asset: "unit-cube.gltf" }],
    ["extra renderable field", { ...baseRenderable, extra: true }],
    ["missing node", { asset: baseRenderable.asset, visible: true }],
    // The size limit is in code points: this URI is 2200 UTF-16 units but only 1100 characters, so it is merely wrong.
    ["non-fixture uri within the code-point bound", asset({ uri: "\u{1F600}".repeat(1100) })],
    ["non-fixture uri at exactly the advertised bound", asset({ uri: "a".repeat(P1_LIMITS.maxAssetUriCharacters) })],
  ];
  for (const [label, renderable] of deviations) {
    await rejected(requester, createWith(`bad-${label}`, `entity:${label}`, { renderable }), "invalid_component_state", label, state);
    assert.equal(host.worldStore.getEntity(`entity:${label}`), null, label);
    assert.equal(host.worldStore.isTombstoned(`entity:${label}`), false, label);
  }
  // Over the advertised bound is a resource limit, decided before the exact-fixture comparison.
  const tooLong: Array<[string, string]> = [
    ["ascii", "a".repeat(P1_LIMITS.maxAssetUriCharacters + 1)],
    ["bound-plus-one fixture prefix", `unit-cube.gltf?${"q".repeat(P1_LIMITS.maxAssetUriCharacters)}`],
    ["multibyte", "é".repeat(P1_LIMITS.maxAssetUriCharacters + 1)],
    ["astral", "\u{1F600}".repeat(P1_LIMITS.maxAssetUriCharacters + 1)],
  ];
  for (const [label, uri] of tooLong) {
    await rejected(requester, createWith(`long-${label}`, `entity:long-${label}`, { renderable: asset({ uri }) }), "resource_limit", label, state);
    assert.equal(host.worldStore.getEntity(`entity:long-${label}`), null, label);
    assert.equal(host.worldStore.isTombstoned(`entity:long-${label}`), false, label);
  }
  assert.equal(host.worldStore.getRealmSeq(), 0);
  assert.deepEqual(await observer.fence(host), []);
  // None of those ids were burned: the exact fixture (visible:false is legal) still creates.
  const ok = await requester.request(createWith("good", "entity:bad-other uri", { renderable: { ...baseRenderable, visible: false } }));
  assert.equal(ok.type, "ack");
  assert.equal(host.worldStore.getEntity("entity:bad-other uri")?.components["hvtp.renderable@1"].state.visible, false);
}));

// ---------------------------------------------------------------- C17 / C18 numeric domains

const transformInvalid: Array<Case & { key: "position" | "rotation" | "scale" }> = [
  { key: "position", label: "position x above range", value: [1000000.5, 0, 0] },
  { key: "position", label: "position y below range", value: [0, -1000000.5, 0] },
  { key: "position", label: "position z above range", value: [0, 0, 1000001] },
  { key: "position", label: "position length 2", value: [0, 0] },
  { key: "position", label: "position length 4", value: [0, 0, 0, 0] },
  { key: "position", label: "position string element", value: ["0", 0, 0] },
  { key: "position", label: "position null element", value: [null, 0, 0] },
  { key: "position", label: "position not an array", value: "0,0,0" },
  { key: "position", label: "position 1e400", value: [123456789, 0, 0], raw: ["123456789", "1e400"] },
  { key: "position", label: "position -1e400", value: [0, -123456789, 0], raw: ["-123456789", "-1e400"] },
  { key: "rotation", label: "quaternion norm +2e-5", value: [0, 0, 0, 1.00002] },
  { key: "rotation", label: "quaternion norm +1.1e-5", value: [0, 0, 0, 1.000011] },
  { key: "rotation", label: "quaternion norm -1.1e-5", value: [0, 0, 0, 0.999989] },
  { key: "rotation", label: "zero quaternion", value: [0, 0, 0, 0] },
  { key: "rotation", label: "quaternion norm sqrt(2)", value: [1, 1, 0, 0] },
  { key: "rotation", label: "quaternion length 3", value: [0, 0, 1] },
  { key: "rotation", label: "quaternion length 5", value: [0, 0, 0, 1, 0] },
  { key: "rotation", label: "quaternion string element", value: [0, 0, 0, "1"] },
  { key: "rotation", label: "quaternion 1e400", value: [0, 0, 0, 123456789], raw: ["123456789", "1e400"] },
  { key: "scale", label: "scale zero", value: [0, 1, 1] },
  { key: "scale", label: "scale negative", value: [1, -1, 1] },
  { key: "scale", label: "scale above 1000", value: [1, 1, 1000.0001] },
  { key: "scale", label: "scale length 2", value: [1, 1] },
  { key: "scale", label: "scale length 4", value: [1, 1, 1, 1] },
  { key: "scale", label: "scale string element", value: ["1", 1, 1] },
  { key: "scale", label: "scale 1e400", value: [1, 123456789, 1], raw: ["123456789", "1e400"] },
];
const transformValid: Array<Case & { key: "position" | "rotation" | "scale" }> = [
  { key: "position", label: "position at +/-1e6 boundary", value: [1000000, -1000000, 1000000] },
  { key: "rotation", label: "quaternion norm +9e-6", value: [0, 0, 0, 1.000009] },
  { key: "rotation", label: "quaternion norm -9e-6", value: [0, 0, 0, 0.999991] },
  { key: "rotation", label: "unit quaternion off-axis", value: [0.5, 0.5, 0.5, 0.5] },
  { key: "scale", label: "scale exactly 1000", value: [1000, 1000, 1000] },
  { key: "scale", label: "tiny positive scale", value: [1e-9, 1, 1] },
];
const materialInvalid: Case[] = [
  { label: "channel above 1", value: [1.0000001, 0, 0, 1] },
  { label: "channel below 0", value: [0, -0.0000001, 0, 1] },
  { label: "alpha above 1", value: [0, 0, 0, 2] },
  { label: "length 3", value: [0, 0, 0] },
  { label: "length 5", value: [0, 0, 0, 1, 1] },
  { label: "string channel", value: [0, 0, 0, "1"] },
  { label: "null channel", value: [0, null, 0, 1] },
  { label: "not an array", value: "white" },
  { label: "1e400 channel", value: [123456789, 0, 0, 1], raw: ["123456789", "1e400"] },
  { label: "-1e400 channel", value: [0, -123456789, 0, 1], raw: ["-123456789", "-1e400"] },
];
const materialValid: Case[] = [
  { label: "all zeros", value: [0, 0, 0, 0] },
  { label: "all ones", value: [1, 1, 1, 1] },
];

test("C17 transform domain via create, component.set and component.patch: every violation is invalid_component_state with no state change", () =>
  withHost(async (host) => {
    const { observer, requester, state } = await fixture(host, ["target"]);
    for (const { key, label, value, raw } of transformInvalid) {
      const id = label.replaceAll(" ", "-");
      await rejected(requester, createWith(`create-${id}`, `entity:${id}`, { transform: { ...baseTransform, [key]: value } }), "invalid_component_state", `create ${label}`, state, raw);
      assert.equal(host.worldStore.getEntity(`entity:${id}`), null, `create ${label}`);
      assert.equal(host.worldStore.isTombstoned(`entity:${id}`), false, `create ${label}`);
      await rejected(requester, setRequest(`set-${id}`, "target", "hvtp.transform@1", 1, { ...baseTransform, [key]: value }), "invalid_component_state", `set ${label}`, state, raw);
      await rejected(requester, patchRequest(`patch-${id}`, "target", "hvtp.transform@1", 1, { [key]: value }), "invalid_component_state", `patch ${label}`, state, raw);
    }
    assert.equal(host.worldStore.getEntity("target")?.components["hvtp.transform@1"].revision, 1);
    assert.deepEqual(await observer.fence(host), []);
  }));

test("C17 transform boundaries that are inside the domain are accepted by create, set and patch", () => withHost(async (host) => {
  const { requester } = await fixture(host, []);
  for (const { key, label, value } of transformValid) {
    const id = `entity:${label.replaceAll(" ", "-")}`;
    const state = { ...baseTransform, [key]: value };
    assert.equal((await requester.request(createWith(`c-${id}`, id, { transform: state }))).type, "ack", `create ${label}`);
    assert.deepEqual(host.worldStore.getEntity(id)?.components["hvtp.transform@1"].state, state, label);
    assert.equal((await requester.request(setRequest(`s-${id}`, id, "hvtp.transform@1", 1, state))).type, "ack", `set ${label}`);
    assert.equal((await requester.request(patchRequest(`p-${id}`, id, "hvtp.transform@1", 2, { [key]: value }))).type, "ack", `patch ${label}`);
    assert.equal(host.worldStore.getEntity(id)?.components["hvtp.transform@1"].revision, 3, label);
  }
}));

test("C18 material domain via create, component.set and component.patch: every violation is invalid_component_state with no state change", () =>
  withHost(async (host) => {
    const { observer, requester, state } = await fixture(host, ["target"]);
    for (const { label, value, raw } of materialInvalid) {
      const id = label.replaceAll(" ", "-");
      await rejected(requester, createWith(`create-${id}`, `entity:${id}`, { material: { baseColor: value } }), "invalid_component_state", `create ${label}`, state, raw);
      assert.equal(host.worldStore.getEntity(`entity:${id}`), null, `create ${label}`);
      await rejected(requester, setRequest(`set-${id}`, "target", "hvtp.material@1", 1, { baseColor: value }), "invalid_component_state", `set ${label}`, state, raw);
      await rejected(requester, patchRequest(`patch-${id}`, "target", "hvtp.material@1", 1, { baseColor: value }), "invalid_component_state", `patch ${label}`, state, raw);
    }
    assert.equal(host.worldStore.getEntity("target")?.components["hvtp.material@1"].revision, 1);
    assert.deepEqual(await observer.fence(host), []);
  }));

test("C18 material channels at 0 and 1 are accepted", () => withHost(async (host) => {
  const { requester } = await fixture(host, []);
  for (const { label, value } of materialValid) {
    const id = `entity:${label.replaceAll(" ", "-")}`;
    assert.equal((await requester.request(createWith(`c-${id}`, id, { material: { baseColor: value } }))).type, "ack", label);
    assert.equal((await requester.request(setRequest(`s-${id}`, id, "hvtp.material@1", 1, { baseColor: value }))).type, "ack", label);
    assert.equal((await requester.request(patchRequest(`p-${id}`, id, "hvtp.material@1", 2, { baseColor: value }))).type, "ack", label);
    assert.deepEqual(host.worldStore.getEntity(id)?.components["hvtp.material@1"].state.baseColor, value, label);
  }
}));

// ---------------------------------------------------------------- C26 merge patch

test("C26 merge patches that would delete required state or are not valid patches are rejected atomically", () => withHost(async (host) => {
  const { observer, requester, state } = await fixture(host, ["target"]);
  for (let revision = 1; revision < 5; revision++) {
    host.worldStore.replaceMutableComponent("target", "hvtp.transform@1", { ...baseTransform, position: [revision, 0, 0] } as never, revision, 1);
  }
  assert.equal(host.worldStore.getEntity("target")?.components["hvtp.transform@1"].revision, 5);
  const before = JSON.stringify(host.worldStore.getEntity("target"));

  const transform = "hvtp.transform@1";
  const material = "hvtp.material@1";
  const patches: Array<[string, string, unknown]> = [
    ["spec example position:null", transform, { position: null }],
    ["rotation:null", transform, { rotation: null }],
    ["scale:null", transform, { scale: null }],
    ["null alongside a valid field", transform, { position: [9, 9, 9], scale: null }],
    ["empty patch", transform, {}],
    ["null patch", transform, null],
    ["array patch", transform, [{ position: [1, 1, 1] }]],
    ["string patch", transform, "position"],
    ["number patch", transform, 5],
    ["boolean patch", transform, true],
    ["unknown field", transform, { foo: 1 }],
    ["unknown field alongside a valid one", transform, { position: [9, 9, 9], foo: 1 }],
    ["position wrong length", transform, { position: [1, 2] }],
    ["position wrong type", transform, { position: "1,2,3" }],
    ["rotation wrong type", transform, { rotation: { x: 0 } }],
    ["rotation not normalized", transform, { rotation: [0, 0, 0, 2] }],
    ["valid field alongside an invalid one", transform, { position: [9, 9, 9], scale: [0, 1, 1] }],
    ["material baseColor:null", material, { baseColor: null }],
    ["material empty patch", material, {}],
    ["material unknown field", material, { opacity: 1 }],
    ["material transform field", material, { position: [0, 0, 0] }],
    ["material wrong length", material, { baseColor: [1, 1, 1] }],
  ];
  for (const [label, component, patch] of patches) {
    const revision = component === transform ? 5 : 1;
    await rejected(requester, patchRequest(`p-${label}`, "target", component, revision, patch), "invalid_component_state", label, state);
  }
  assert.equal(JSON.stringify(host.worldStore.getEntity("target")), before, "revision 5 and its complete state remain canonical");
  assert.deepEqual(await observer.fence(host), []);

  // A patch with no `patch` member at all is a closed-shape violation, not a component-state violation.
  const missing = { hvtp: "0.2", id: "p-missing", type: "component.patch", realm: P1_REALM_ID,
    body: { entityId: "target", component: transform, authorityEpoch: 1, baseRevision: 5 } };
  await rejected(requester, missing, "invalid_message", "missing patch member", state);

  // The same revision still accepts a valid merge patch that preserves omitted fields.
  const ok = await requester.request(patchRequest("p-ok", "target", transform, 5, { scale: [2, 2, 2] }));
  assert.equal(ok.type, "ack");
  assert.deepEqual(host.worldStore.getEntity("target")?.components[transform].state, { position: [4, 0, 0], rotation: [0, 0, 0, 1], scale: [2, 2, 2] });
}));

// ---------------------------------------------------------------- C02 / C03 / C32 metadata domains

const invalidMetadata: Array<[string, string]> = [
  ["zero", "0"], ["negative zero", "-0"], ["negative", "-1"], ["fractional", "1.5"], ["string", "\"5\""],
  ["above 2^53-1", "9007199254740992"], ["far above 2^53-1", "9007199254740993123"], ["1e400", "1e400"],
  ["null", "null"], ["boolean", "true"], ["array", "[5]"], ["object", "{}"],
];

test("C02/C03/C32 invalid revision and epoch metadata is invalid_message and precedes every equality check", () => withHost(async (host) => {
  const { observer, requester, state } = await fixture(host, ["meta"]);
  for (let revision = 1; revision < 5; revision++) {
    host.worldStore.replaceMutableComponent("meta", "hvtp.material@1", { baseColor: [revision / 10, 0, 0, 1] }, revision, 1);
  }
  assert.equal(host.worldStore.getEntity("meta")?.components["hvtp.material@1"].revision, 5);
  const material = "hvtp.material@1";
  const marker = "\"__V__\"";
  for (const type of ["set", "patch"] as const) {
    const build = (id: string, baseRevision: unknown, authorityEpoch: unknown) => type === "set"
      ? setRequest(id, "meta", material, baseRevision, { baseColor: [0, 0, 0, 1] }, authorityEpoch)
      : patchRequest(id, "meta", material, baseRevision, { baseColor: [0, 0, 0, 1] }, authorityEpoch);
    for (const [label, literal] of invalidMetadata) {
      const tag = `${type}-${label}`;
      // Invalid baseRevision with a valid, matching epoch.
      await rejected(requester, build(`${tag}-rev`, "__V__", 1), "invalid_message", `${tag} baseRevision`, state, [marker, literal]);
      // Invalid baseRevision together with a valid-domain epoch mismatch: domain validation first.
      await rejected(requester, build(`${tag}-rev-epoch2`, "__V__", 2), "invalid_message", `${tag} baseRevision + epoch 2`, state, [marker, literal]);
      // Invalid epoch with a correct revision, and with a valid-domain revision mismatch.
      await rejected(requester, build(`${tag}-epoch`, 5, "__V__"), "invalid_message", `${tag} epoch`, state, [marker, literal]);
      await rejected(requester, build(`${tag}-epoch-rev99`, 99, "__V__"), "invalid_message", `${tag} epoch + revision 99`, state, [marker, literal]);
    }
    // Valid-domain mismatches use their own codes and carry the current metadata.
    for (const revision of [4, 6, 9007199254740991]) {
      const reply = await rejected(requester, build(`${type}-rev-${revision}`, revision, 1), "revision_mismatch", `${type} baseRevision ${revision}`, state);
      assert.equal(reply.body.currentRevision, 5);
      assert.equal(reply.body.authorityEpoch, 1);
    }
    for (const epoch of [2, 9007199254740991]) {
      const reply = await rejected(requester, build(`${type}-epoch-${epoch}`, 5, epoch), "authority_epoch_mismatch", `${type} epoch ${epoch}`, state);
      assert.equal(reply.body.authorityEpoch, 1);
    }
  }
  assert.deepEqual(await observer.fence(host), []);
  assert.equal(host.worldStore.getEntity("meta")?.components[material].revision, 5);
  assert.equal((await requester.request(patchRequest("eligible", "meta", material, 5, { baseColor: [0, 1, 0, 1] }))).type, "ack");
  assert.equal(host.worldStore.getEntity("meta")?.components[material].revision, 6);
}));

// ---------------------------------------------------------------- C02 races

test("C02 patch race at material revision 5: exactly one commits revision 6, the loser gets revision_mismatch with currentRevision 6", () =>
  withHost(async (host) => {
    host.worldStore.createEntity(cubeInput("race"));
    for (let revision = 1; revision < 5; revision++) {
      host.worldStore.replaceMutableComponent("race", "hvtp.material@1", { baseColor: [revision / 10, 0, 0, 1] }, revision, 1);
    }
    const a = await connectedPeer(host); await joinCollect(a, { entities: ["race"] });
    const b = await connectedPeer(host); await joinCollect(b, { entities: ["race"] });
    const seq = host.worldStore.getRealmSeq();
    a.send(patchRequest("race-a", "race", "hvtp.material@1", 5, { baseColor: [1, 0, 0, 1] }));
    b.send(patchRequest("race-b", "race", "hvtp.material@1", 5, { baseColor: [0, 0, 1, 1] }));
    const [aMessages, bMessages] = await Promise.all([a.take(2), b.take(2)]);
    const results = [aMessages, bMessages].map((messages) => messages.find((m) => m.type === "ack" || m.type === "error")!);
    const winners = results.filter((m) => m.type === "ack");
    const losers = results.filter((m) => m.type === "error");
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.equal(winners[0]!.body.revision, 6);
    assert.equal(losers[0]!.body.code, "revision_mismatch");
    assert.equal(losers[0]!.body.currentRevision, 6);
    assert.equal(losers[0]!.body.authorityEpoch, 1);
    assert.equal(host.worldStore.getRealmSeq(), seq + 1);
    const winnerColor = host.worldStore.getEntity("race")!.components["hvtp.material@1"].state.baseColor;
    assert.ok(JSON.stringify(winnerColor) === "[1,0,0,1]" || JSON.stringify(winnerColor) === "[0,0,1,1]", "the committed state is exactly one request's, never a blend");
  }));

test("C02 concurrent updates to different components both commit and each advances only its own revision", () => withHost(async (host) => {
  host.worldStore.createEntity(cubeInput("two"));
  const observer = await connectedPeer(host); await joinCollect(observer, { entities: ["two"] });
  const a = await connectedPeer(host); await joinCollect(a, {});
  const b = await connectedPeer(host); await joinCollect(b, {});
  const seq = host.worldStore.getRealmSeq();
  a.send(patchRequest("move", "two", "hvtp.transform@1", 1, { position: [3, 0, 0] }));
  b.send(patchRequest("tint", "two", "hvtp.material@1", 1, { baseColor: [0, 1, 0, 1] }));
  const [aReply, bReply] = await Promise.all([a.next(), b.next()]);
  assert.equal(aReply.type, "ack");
  assert.equal(bReply.type, "ack");
  assert.equal(aReply.body.revision, 2);
  assert.equal(bReply.body.revision, 2);
  assert.notEqual(aReply.body.seq, bReply.body.seq);
  assert.deepEqual([aReply.body.seq, bReply.body.seq].sort(), [seq + 1, seq + 2]);
  const entity = host.worldStore.getEntity("two")!;
  assert.deepEqual(
    [entity.components["hvtp.transform@1"].revision, entity.components["hvtp.material@1"].revision, entity.components["hvtp.renderable@1"].revision],
    [2, 2, 1],
  );
  assert.deepEqual(entity.components["hvtp.transform@1"].state.position, [3, 0, 0]);
  assert.deepEqual(entity.components["hvtp.material@1"].state.baseColor, [0, 1, 0, 1]);
  assert.equal(host.worldStore.getRealmSeq(), seq + 2);
  await host.realmCoordinator.drain();
  const updates = await observer.take(2);
  assert.deepEqual(updates.map((m) => m.body.component).sort(), ["hvtp.material@1", "hvtp.transform@1"]);
  assert.deepEqual(updates.map((m) => m.seq), [seq + 1, seq + 2]);
}));

test("C02 an update after a committed deletion is entity_not_found and cannot resurrect; update then delete both commit", () => withHost(async (host) => {
  host.worldStore.createEntity(cubeInput("gone"));
  host.worldStore.createEntity(cubeInput("kept"));
  const observer = await connectedPeer(host); await joinCollect(observer, { entities: ["gone", "kept"] });
  const a = await connectedPeer(host); await joinCollect(a, {});

  // delete first, then update
  const deleted = await a.request({ hvtp: "0.2", id: "del-gone", type: "entity.delete", realm: P1_REALM_ID, body: { entityId: "gone" } });
  assert.equal(deleted.type, "ack");
  const seq = host.worldStore.getRealmSeq();
  for (const request of [
    setRequest("late-set", "gone", "hvtp.transform@1", 1, { ...baseTransform, position: [5, 5, 5] }),
    patchRequest("late-patch", "gone", "hvtp.material@1", 1, { baseColor: [0, 0, 0, 1] }),
  ]) {
    const reply = await a.request(request);
    assert.equal(reply.body.code, "entity_not_found");
    assert.equal(reply.body.ref, request.id);
  }
  assert.equal(host.worldStore.getRealmSeq(), seq);
  assert.equal(host.worldStore.getEntity("gone"), null);
  assert.equal(host.worldStore.isTombstoned("gone"), true);

  // update first, then delete
  assert.equal((await a.request(setRequest("early-set", "kept", "hvtp.transform@1", 1, { ...baseTransform, position: [1, 0, 0] }))).type, "ack");
  assert.equal((await a.request({ hvtp: "0.2", id: "del-kept", type: "entity.delete", realm: P1_REALM_ID, body: { entityId: "kept" } })).type, "ack");
  assert.equal(host.worldStore.isTombstoned("kept"), true);
  assert.equal(host.worldStore.getEntity("kept"), null);
  await host.realmCoordinator.drain();
  assert.deepEqual((await observer.fence(host)).map((m) => m.type), ["entity.deleted", "component.updated", "entity.deleted"]);
}));

test("C02 concurrent update and delete serialize in one of the two legal orders", () => withHost(async (host) => {
  host.worldStore.createEntity(cubeInput("raced"));
  const updater = await connectedPeer(host); await joinCollect(updater, {});
  const deleter = await connectedPeer(host); await joinCollect(deleter, {});
  const seq = host.worldStore.getRealmSeq();
  updater.send(setRequest("race-set", "raced", "hvtp.transform@1", 1, { ...baseTransform, position: [7, 0, 0] }));
  deleter.send({ hvtp: "0.2", id: "race-del", type: "entity.delete", realm: P1_REALM_ID, body: { entityId: "raced" } });
  const [updateReply, deleteReply] = await Promise.all([updater.next(), deleter.next()]);
  assert.equal(deleteReply.type, "ack", "the deletion always commits");
  if (updateReply.type === "ack") {
    assert.equal(updateReply.body.seq, seq + 1);
    assert.equal(deleteReply.body.seq, seq + 2);
  } else {
    assert.equal(updateReply.body.code, "entity_not_found");
    assert.equal(deleteReply.body.seq, seq + 1);
  }
  assert.equal(host.worldStore.getEntity("raced"), null, "no ordering leaves live state");
  assert.equal(host.worldStore.isTombstoned("raced"), true);
}));
