import assert from "node:assert/strict";
import test from "node:test";
import { isPresenceEntity, P1Client, P1OutcomeUncertainError, type P1ClientEvent, type P1Socket } from "@hvtp/client-core";
import { P1_REALM_ID, type P1SharedEntity } from "@hvtp/protocol-types";
import type { ReferenceHost } from "@hvtp/reference-host";
import {
  bounded, colorOf, makeBrowser, MATERIAL, positionOf, shared, SPATIAL, TRANSFORM, waitFor, withHost, wsUrl, type Browser,
} from "./support.js";

const E = "entity:cross-cube";
const cubeInput = (id: string, x = 0) => ({
  id, transform: { position: [x, 0.5, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] },
  material: { baseColor: [1, 1, 1, 1] as [number, number, number, number] },
});

/** A plain (renderer-free) participant that mutates the realm. */
async function writer(host: ReferenceHost, ...cubes: Array<[string, number]>): Promise<P1Client> {
  const client = new P1Client({ url: wsUrl(host), subscription: SPATIAL, clientName: "writer" });
  await bounded(client.connect(), "writer join");
  for (const [id, x] of cubes) await bounded(client.createEntity(cubeInput(id, x)), `writer creates ${id}`);
  return client;
}

/** A gate: `wait()` parks the caller until `release()`; `entered` resolves when someone is parked. */
function gate() {
  let release!: () => void;
  let reached!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { reached = resolve; });
  return { release, entered, wait: async () => { reached(); await blocked; } };
}

const canonical = (host: ReferenceHost, id: string): P1SharedEntity | undefined => host.worldStore.getEntity(id) ?? undefined;
const sharedIds = (client: P1Client): string[] => [...client.entities.values()].filter((entity) => !isPresenceEntity(entity)).map((entity) => entity.id);

// ---------------------------------------------------------------------------------------------------------------
// C08 / C30: a client joins while the host holds the snapshot cut
// ---------------------------------------------------------------------------------------------------------------

for (const kind of ["update", "create", "delete", "interest"] as const) {
  test(`C08/C30 real host: ${kind === "update" ? "an" : "a"} ${kind} committed after the snapshot cut is applied exactly once after snapshot end`, async () => {
    // The host's own `beforeSnapshotEnqueue` barrier (the same seam the reference-host tests use) holds the second
    // snapshot (the joiner's) after its cut was taken and before any byte of it reaches the joiner.
    const snapshot = gate();
    let snapshots = 0;
    await withHost({ realmCoordinatorOptions: { beforeSnapshotEnqueue: async () => { if (++snapshots === 2) await snapshot.wait(); } } }, async (host) => {
      try {
        // "interest" starts outside the joiner's radius; the post-cut move crosses into it.
        const other = await writer(host, [E, kind === "interest" ? 500 : 0]);
        const joiner = makeBrowser(wsUrl(host), "joiner", { subscription: SPATIAL });
        let atSnapshot: Array<[string, number, number]> = [];
        joiner.client.on((event) => {
          if (event.type === "view.reset" && event.reason === "snapshot") {
            atSnapshot = [...event.entities.values()].flatMap((entity) => isPresenceEntity(entity) ? []
              : [[entity.id, entity.components[TRANSFORM].revision, entity.components[MATERIAL].revision] as [string, number, number]]);
          }
        });
        const joining = joiner.client.connect();
        joining.catch(() => { /* reported through the awaited promise below */ });
        await snapshot.entered; // cut taken at the join; delivery parked

        const cutSeq = host.worldStore.getRealmSeq();
        if (kind === "update") await bounded(other.setComponent(E, TRANSFORM, { position: [1, 0.5, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }), "post-cut update");
        if (kind === "create") await bounded(other.createEntity(cubeInput("entity:post-cut", 3)), "post-cut create");
        if (kind === "delete") await bounded(other.deleteEntity(E), "post-cut delete");
        if (kind === "interest") await bounded(other.setComponent(E, TRANSFORM, { position: [5, 0.5, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, { baseRevision: 1, authorityEpoch: 1 }), "post-cut move into range");
        assert.equal(host.worldStore.getRealmSeq(), cutSeq + 1, "exactly one post-cut commit");
        assert.equal(joiner.client.phase, "joining", "nothing of the snapshot (or the post-cut change) reached the joiner yet");
        assert.equal(joiner.events.some((event) => event.type === "entity.upsert" || event.type === "entity.remove"), false);

        snapshot.release();
        await bounded(joining, "joiner live");
        // Fence: a later commit proves the joiner's ordered stream has drained past the buffered publication.
        await bounded(other.createEntity(cubeInput(`entity:fence-${kind}`, 7)), "fence create");
        await waitFor(joiner.client, () => joiner.client.entities.has(`entity:fence-${kind}`), "joiner reaches the fence");
        await joiner.view.whenIdle();

        // The snapshot represents state through the cut only.
        const expectedSnapshot = kind === "create" ? [[E, 1, 1]] : kind === "interest" ? [] : [[E, 1, 1]];
        assert.deepEqual(atSnapshot, expectedSnapshot);
        // The post-cut change is delivered exactly once, after snapshot end, with the right publication kind.
        const after = joiner.events.slice(joiner.events.findIndex((event) => event.type === "view.reset" && event.reason === "snapshot") + 1)
          .filter((event): event is Extract<P1ClientEvent, { type: "entity.upsert" | "entity.remove" }> => event.type === "entity.upsert" || event.type === "entity.remove");
        const describe = (event: (typeof after)[number]) => event.type === "entity.upsert" ? `${event.cause}:${event.entity.id}` : `${event.cause}:${event.entityId}`;
        const expected = { update: `updated:${E}`, create: "created:entity:post-cut", delete: `deleted:${E}`, interest: `enter:${E}` }[kind];
        assert.deepEqual(after.map(describe), [expected, `created:entity:fence-${kind}`]);
        assert.equal(joiner.events.some((event) => event.type === "protocol.violation" || event.type === "publication.stale"), false);

        // Final client state equals the host's canonical store, record for record.
        for (const id of [E, "entity:post-cut", `entity:fence-${kind}`]) {
          const hostEntity = canonical(host, id);
          const clientEntity = shared(joiner.client, id);
          if (hostEntity === undefined) assert.equal(clientEntity, undefined, id);
          else if (clientEntity === undefined) assert.fail(`${id} is in the host store but not in the client view`);
          else assert.deepEqual(JSON.parse(JSON.stringify(clientEntity)), JSON.parse(JSON.stringify(hostEntity)), id);
        }
        // The Three scene follows the same canonical result.
        if (kind === "update") assert.deepEqual(positionOf(joiner, E), [1, 0.5, 0]);
        if (kind === "create") { assert.equal(joiner.view.assetStatus("entity:post-cut"), "loaded"); assert.deepEqual(positionOf(joiner, "entity:post-cut"), [3, 0.5, 0]); }
        if (kind === "delete") assert.equal(joiner.view.object(E), undefined);
        if (kind === "interest") { assert.equal(joiner.view.assetStatus(E), "loaded"); assert.deepEqual(positionOf(joiner, E), [5, 0.5, 0]); }
        joiner.client.disconnect();
        other.disconnect();
      } finally {
        snapshot.release();
      }
    });
  });
}

// ---------------------------------------------------------------------------------------------------------------
// C28: overlapping subscription replacements, stale generation ignored
// ---------------------------------------------------------------------------------------------------------------

test("C28 real host: rapid S1 (excludes E) then S2 (includes E) settles on S2 with E present; a late S1-tagged publication is ignored", async () => {
  await withHost({}, async (host) => {
    const other = await writer(host, [E, 0]);
    let socket: P1Socket | undefined;
    const browser = makeBrowser(wsUrl(host), "c28", { subscription: { entities: [E] }, wrapSocket: (inner) => (socket = inner) });
    try {
      await bounded(browser.client.connect(), "join");
      await browser.view.whenIdle();
      const s0 = browser.client.subscriptionId!;
      assert.ok(browser.client.entities.has(E));
      const oldObject = browser.view.object(E)!;

      const first = browser.client.setSubscription({ entities: [] });
      const second = browser.client.setSubscription({ entities: [E] });
      const [r1, r2] = await bounded(Promise.all([first, second]), "both replacements resolve");
      await browser.view.whenIdle();

      assert.equal(r1.activated, true);
      assert.equal(r2.activated, true);
      assert.equal(r1.body.previousSubscriptionId, s0);
      assert.equal(r2.body.previousSubscriptionId, r1.body.subscriptionId, "S2 continues from S1: the host serialized them");
      assert.notEqual(r1.body.subscriptionId, r2.body.subscriptionId);
      const s1 = r1.body.subscriptionId;
      const s2 = r2.body.subscriptionId;
      assert.equal(browser.client.subscriptionId, s2, "active generation is S2");
      assert.deepEqual(browser.client.effectiveSubscription, { entities: [E] });
      // E left for S1 and re-entered for S2, in that order, and is present in the client view and the Three view.
      const lifecycle = browser.events.flatMap((event) => event.type === "entity.remove" ? [`${event.cause}:${event.entityId}`]
        : event.type === "entity.upsert" ? [`${event.cause}:${event.entity.id}`] : event.type === "subscription.activated" ? [`activated:${event.subscriptionId}`] : [])
        .filter((entry) => !entry.startsWith("created:"));
      assert.deepEqual(lifecycle.slice(-4), [`activated:${s1}`, `leave:${E}`, `activated:${s2}`, `enter:${E}`]);
      assert.ok(browser.client.entities.has(E));
      assert.ok(browser.view.object(E) !== undefined);
      assert.notEqual(browser.view.object(E), oldObject, "rebuilt from the enter record");
      assert.equal(browser.view.assetStatus(E), "loaded");

      // Delayed S1-tagged subscriber publications arrive after S2 is active.
      const before = browser.client.entities.get(E);
      const envelope = (type: string, body: Record<string, unknown>) =>
        JSON.stringify({ hvtp: "0.2", id: `late:${type}`, type, realm: P1_REALM_ID, realmEpoch: browser.client.realmEpoch, seq: 9_999, body: { subscriptionId: s1, ...body } });
      const late = {
        value: { revision: 99, authority: "host", authorityEpoch: 1, consistency: "authoritative", state: { position: [9, 9, 9], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } },
      };
      const stale: Array<{ messageType: string; subscriptionId: string }> = [];
      browser.client.on((event) => { if (event.type === "publication.stale") stale.push({ messageType: event.messageType, subscriptionId: event.subscriptionId }); });
      for (const text of [
        envelope("component.updated", { entityId: E, component: TRANSFORM, ...late }),
        envelope("view.entity.leave", { reason: "interest", entityId: E }),
        envelope("entity.deleted", { entityId: E }),
      ]) socket!.onmessage!({ data: text });
      assert.deepEqual(stale, [
        { messageType: "component.updated", subscriptionId: s1 },
        { messageType: "view.entity.leave", subscriptionId: s1 },
        { messageType: "entity.deleted", subscriptionId: s1 },
      ]);
      assert.equal(browser.client.phase, "live");
      assert.equal(browser.client.subscriptionId, s2);
      assert.equal(browser.client.entities.get(E), before, "canonical record untouched");
      assert.deepEqual(positionOf(browser, E), [0, 0.5, 0]);
      assert.equal(browser.events.some((event) => event.type === "protocol.violation"), false);

      // The live generation still works and is not confused by the stale ones.
      await bounded(other.setComponent(E, TRANSFORM, { position: [4, 0.5, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }), "update under S2");
      await waitFor(browser.client, () => shared(browser.client, E)?.components[TRANSFORM].revision === 2, "S2 publication applied");
      assert.deepEqual(positionOf(browser, E), [4, 0.5, 0]);
    } finally {
      browser.client.disconnect();
      other.disconnect();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// C12: lost reply after a durable commit, browser client
// ---------------------------------------------------------------------------------------------------------------

test("C12 real host: connection lost after the durable commit -> outcome-uncertain, fresh snapshot shows the commit, no replay", async () => {
  let armed = false;
  await withHost({ afterDurableCommit: () => { if (armed) { armed = false; throw new Error("injected lost reply"); } } }, async (host) => {
    const other = await writer(host, [E, 0]);
    const browser = makeBrowser(wsUrl(host), "c12", { subscription: SPATIAL });
    try {
      await bounded(browser.client.connect(), "join");
      await browser.view.whenIdle();
      assert.deepEqual(colorOf(browser, E), [1, 1, 1, 1]);
      const seqBefore = host.worldStore.getRealmSeq();

      armed = true;
      const pending = browser.client.setComponent(E, MATERIAL, { baseColor: [1, 0, 0, 1] });
      const outcome = await bounded(pending.then(() => null, (error: unknown) => error), "request settles");
      assert.ok(outcome instanceof P1OutcomeUncertainError, `expected outcome-uncertain, got ${String(outcome)}`);
      assert.equal(outcome.requestType, "component.set");
      const requestId = outcome.requestId;
      await waitFor(browser.client, () => browser.client.phase === "disconnected", "client noticed the close");
      const closed = browser.events.find((event) => event.type === "closed");
      assert.ok(closed !== undefined && closed.type === "closed");
      assert.deepEqual(closed.uncertainRequestIds, [requestId]);
      assert.equal(browser.view.size, 0);

      // Reconnect: a fresh snapshot already shows the committed state; nothing is replayed.
      await bounded(browser.client.connect(), "reconnect");
      assert.equal(browser.client.phase, "live");
      assert.equal(shared(browser.client, E)!.components[MATERIAL].revision, 2);
      assert.deepEqual(shared(browser.client, E)!.components[MATERIAL].state.baseColor, [1, 0, 0, 1]);
      await browser.view.whenIdle();
      assert.deepEqual(colorOf(browser, E), [1, 0, 0, 1]);
      assert.equal(browser.sessions(), 2);
      assert.equal(browser.sent.filter((frame) => frame.id === requestId).length, 1, "the uncertain request ID is never re-sent");
      assert.equal(browser.sent.filter((frame) => String(frame.type).startsWith("component.")).length, 1, "no mutation after reconnect");
      assert.equal(host.worldStore.getRealmSeq(), seqBefore + 1, "committed exactly once");
      assert.equal(canonical(host, E)!.components[MATERIAL].revision, 2);
      await waitFor(other, () => shared(other, E)?.components[MATERIAL].revision === 2, "writer sees the commit");
    } finally {
      browser.client.disconnect();
      other.disconnect();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Three view lifecycle against a real host
// ---------------------------------------------------------------------------------------------------------------

test("Three on a real host: subscription leave removes the object without a tombstone, re-enter rebuilds from full state, global delete removes it", async () => {
  await withHost({}, async (host) => {
    const other = await writer(host, [E, 0]);
    const browser: Browser = makeBrowser(wsUrl(host), "lifecycle", { subscription: SPATIAL });
    try {
      await bounded(browser.client.connect(), "join");
      await browser.view.whenIdle();
      const first = browser.view.object(E)!;
      assert.equal(browser.view.assetStatus(E), "loaded");

      // Leave via subscription change: the object goes away; canonical state is still held by the host (no tombstone).
      const empty = await bounded(browser.client.setSubscription({}), "leave subscription");
      assert.equal(empty.activated, true);
      assert.equal(browser.client.entities.has(E), false);
      assert.equal(browser.view.object(E), undefined);
      assert.equal(browser.view.assetStatus(E), undefined);
      assert.equal(first.parent, null);
      assert.equal(browser.view.root.children.length, 0);
      assert.ok(browser.events.some((event) => event.type === "entity.remove" && event.cause === "leave" && event.entityId === E));
      assert.equal(browser.events.some((event) => event.type === "entity.remove" && event.cause === "deleted"), false);
      assert.ok(canonical(host, E) !== undefined, "the entity still exists on the host: leaving a view is not a delete");

      // The entity changes while the browser cannot see it; those publications are not delivered.
      await bounded(other.setComponent(E, TRANSFORM, { position: [6, 0.5, 1], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }), "unseen move");
      await bounded(other.setComponent(E, MATERIAL, { baseColor: [0, 0, 1, 0.5] }), "unseen recolor");

      // Re-enter: rebuilt from the complete enter record, with the current revisions.
      const back = await bounded(browser.client.setSubscription(SPATIAL), "re-enter subscription");
      assert.equal(back.activated, true);
      await waitFor(browser.client, () => browser.client.entities.has(E), "E re-enters");
      await browser.view.whenIdle();
      assert.ok(browser.events.some((event) => event.type === "entity.upsert" && event.cause === "enter" && event.entity.id === E));
      const second = browser.view.object(E)!;
      assert.notEqual(second, first, "a new renderer object, not the old one");
      assert.equal(browser.view.assetStatus(E), "loaded");
      assert.deepEqual(positionOf(browser, E), [6, 0.5, 1]);
      assert.deepEqual(colorOf(browser, E), [0, 0, 1, 0.5]);
      assert.equal(shared(browser.client, E)!.components[TRANSFORM].revision, 2);
      assert.equal(shared(browser.client, E)!.components[MATERIAL].revision, 2);
      // No tombstone on the client either: the re-entered entity accepts mutations from this client.
      const ack = await bounded(browser.client.setComponent(E, TRANSFORM, { position: [7, 0.5, 1], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }), "mutate after re-enter");
      assert.equal(ack.revision, 3);

      // Global delete removes the object.
      await bounded(other.deleteEntity(E), "global delete");
      await waitFor(browser.client, () => !browser.client.entities.has(E), "delete observed");
      assert.equal(browser.view.object(E), undefined);
      assert.equal(browser.view.root.children.length, 0);
      assert.ok(browser.events.some((event) => event.type === "entity.remove" && event.cause === "deleted" && event.entityId === E));
      assert.equal(sharedIds(browser.client).length, 0);
    } finally {
      browser.client.disconnect();
      other.disconnect();
    }
  });
});
