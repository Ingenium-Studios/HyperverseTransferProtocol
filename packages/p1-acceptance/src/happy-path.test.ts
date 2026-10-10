import assert from "node:assert/strict";
import test from "node:test";
import type { ReferenceHost } from "@hvtp/reference-host";
import {
  bounded, colorOf, disconnected, makeBrowser, MATERIAL, positionOf, runAgentCli, shared, SPATIAL, startHostOnPort, tempDatabase,
  TRANSFORM, waitFor, wsUrl,
} from "./support.js";
import { createReferenceHost } from "@hvtp/reference-host";

const CUBE = "entity:accept-cube";
const MOVED = [2, 0.5, -1];
const BLUE = [0.25, 0.5, 0.75, 1];
const AGENT_POSITION = [-3, 0.5, 2];
const AGENT_COLOR = [0, 1, 0, 1];
const BROWSER_FRAME_TYPES = new Set(["session.hello", "realm.join", "entity.create", "component.set", "component.patch", "subscription.set", "entity.delete"]);

const revisions = (client: { entities: ReadonlyMap<string, unknown> }, id: string) => {
  const entity = client.entities.get(id) as { components: Record<string, { revision: number }> } | undefined;
  return entity === undefined ? null : { transform: entity.components[TRANSFORM]!.revision, material: entity.components[MATERIAL]!.revision };
};

test("Prototype Profile section 16 happy path: steps 1-16 against a real host, two Three.js browsers, and a separate-process agent", async () => {
  const database = tempDatabase();
  let host = null as ReferenceHost | null;
  const browsers: Array<ReturnType<typeof makeBrowser>> = [];
  try {
    // Step 1: start a clean host (new temp SQLite file, empty realm).
    host = await createReferenceHost({ databasePath: database.path });
    const port = host.port;
    const firstEpoch = host.realmEpoch;
    assert.equal(host.worldStore.getRealmSeq(), 0);
    assert.equal(host.worldStore.getEntity(CUBE), null);

    // Steps 2-3: browsers A and B connect, negotiate HVTP 0.2, and join with overlapping spatial subscriptions.
    const a = makeBrowser(wsUrl(host), "browser-a", { subscription: SPATIAL });
    const b = makeBrowser(wsUrl(host), "browser-b", { subscription: { spatial: { center: [10, 0, 0], radius: 100 } } });
    browsers.push(a, b);
    await bounded(Promise.all([a.client.connect(), b.client.connect()]), "A and B join");
    for (const browser of [a, b]) {
      assert.equal(browser.client.phase, "live");
      assert.equal(browser.client.realmEpoch, firstEpoch);
      assert.ok(browser.client.participantId !== null);
      const hello = browser.sent.find((frame) => frame.type === "session.hello")!;
      assert.deepEqual(hello.body.versions, ["0.2"]);
      assert.equal(hello.hvtp, "0.2");
      assert.equal(browser.sent.find((frame) => frame.type === "realm.join")!.body.subscription.spatial.radius, 100);
      assert.equal(browser.client.entities.size, 1, "only own presence in an empty realm");
    }
    assert.notEqual(a.client.participantId, b.client.participantId);
    // The two spatial selectors overlap (both contain the origin area where the cube is created).
    assert.deepEqual(a.client.effectiveSubscription, SPATIAL);

    // Step 4: A creates a renderable P1 unit cube.
    const ack = await bounded(a.client.createEntity({
      id: CUBE, transform: { position: [0, 0.5, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, material: { baseColor: [1, 1, 1, 1] },
    }), "create ack");
    assert.equal(ack.status, "committed");
    assert.equal(ack.entityId, CUBE);
    assert.deepEqual(host.worldStore.getEntity(CUBE)!.components["hvtp.renderable@1"].state.asset, { uri: "unit-cube.gltf", mediaType: "model/gltf+json" });

    // Step 5: B materializes it without reload (same session, no new snapshot).
    await waitFor(b.client, () => b.client.entities.has(CUBE), "B sees the cube");
    await b.view.whenIdle();
    assert.equal(b.sessions(), 1);
    assert.equal(b.events.filter((event) => event.type === "view.reset" && event.reason === "snapshot").length, 1, "no reload");
    assert.equal(b.view.assetStatus(CUBE), "loaded", "real fixture, not the placeholder");
    assert.deepEqual(b.assetFailures, []);
    assert.deepEqual(positionOf(b, CUBE), [0, 0.5, 0]);
    assert.deepEqual(colorOf(b, CUBE), [1, 1, 1, 1]);
    assert.equal(b.view.object(CUBE)!.getObjectByName("UnitCube") !== undefined, true, "glTF node instantiated under the entity root");
    await a.view.whenIdle();
    assert.equal(a.view.assetStatus(CUBE), "loaded");
    assert.deepEqual(revisions(b.client, CUBE), { transform: 1, material: 1 });

    // Step 6: A moves it.
    const moved = await bounded(a.client.setComponent(CUBE, TRANSFORM, { position: [2, 0.5, -1], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }), "move ack");
    assert.equal(moved.revision, 2);

    // Step 7: B receives canonical transform state (canonical view and Three object).
    await waitFor(b.client, () => shared(b.client, CUBE)?.components[TRANSFORM].revision === 2, "B sees the move");
    assert.deepEqual(shared(b.client, CUBE)!.components[TRANSFORM].state.position, MOVED);
    assert.deepEqual(positionOf(b, CUBE), MOVED);
    assert.deepEqual(host.worldStore.getEntity(CUBE)!.components[TRANSFORM].state.position, MOVED);
    assert.equal(shared(b.client, CUBE)!.components[MATERIAL].revision, 1, "material untouched");

    // Step 8: B changes its base color.
    const recolored = await bounded(b.client.setComponent(CUBE, MATERIAL, { baseColor: [0.25, 0.5, 0.75, 1] }), "recolor ack");
    assert.equal(recolored.revision, 2);

    // Step 9: A receives canonical material state (canonical view and Three material, linear factors).
    await waitFor(a.client, () => shared(a.client, CUBE)?.components[MATERIAL].revision === 2, "A sees the color");
    assert.deepEqual(shared(a.client, CUBE)!.components[MATERIAL].state.baseColor, BLUE);
    assert.deepEqual(colorOf(a, CUBE), BLUE);
    assert.deepEqual(positionOf(a, CUBE), MOVED);
    await waitFor(b.client, () => shared(b.client, CUBE)?.components[MATERIAL].revision === 2, "B sees its own color publication");
    assert.deepEqual(colorOf(b, CUBE), BLUE);
    const durableSeq = host.worldStore.getRealmSeq();
    assert.equal(durableSeq, 3);

    // Step 10: stop and restart the host on the same SQLite file and port.
    await host.close();
    host = null;
    await Promise.all([disconnected(a), disconnected(b)]);
    for (const browser of [a, b]) {
      assert.equal(browser.client.entities.size, 0, "session state dropped on close");
      assert.equal(browser.view.size, 0, "Three scene emptied on session end");
    }
    host = await startHostOnPort({ databasePath: database.path }, port);
    assert.equal(host.port, port);
    assert.notEqual(host.realmEpoch, firstEpoch, "restart starts a new realm epoch");
    assert.equal(host.worldStore.getRealmSeq(), 0, "realm sequence restarts with the epoch");

    // Step 11: reconnect both clients (new connect(), fresh snapshots, new sessions).
    await bounded(Promise.all([a.client.connect(), b.client.connect()]), "A and B reconnect");
    for (const browser of [a, b]) {
      assert.equal(browser.client.phase, "live");
      assert.equal(browser.client.realmEpoch, host.realmEpoch);
      assert.equal(browser.sessions(), 2);
      assert.equal(browser.events.filter((event) => event.type === "view.reset" && event.reason === "snapshot").length, 2, "fresh snapshot");
      assert.equal(browser.sent.filter((frame) => frame.type === "session.hello").length, 2);
      // Nothing from the old session was replayed: only handshake frames and the earlier user mutations exist.
      assert.equal(browser.sent.filter((frame) => frame.type === "realm.join").length, 2);
    }

    // Step 12: the cube reappears with the last durable transform/material state and revisions.
    for (const browser of [a, b]) {
      assert.deepEqual(revisions(browser.client, CUBE), { transform: 2, material: 2 });
      assert.deepEqual(shared(browser.client, CUBE)!.components[TRANSFORM].state.position, MOVED);
      assert.deepEqual(shared(browser.client, CUBE)!.components[MATERIAL].state.baseColor, BLUE);
      await browser.view.whenIdle();
      assert.equal(browser.view.assetStatus(CUBE), "loaded");
      assert.deepEqual(positionOf(browser, CUBE), MOVED);
      assert.deepEqual(colorOf(browser, CUBE), BLUE);
    }

    // Step 13: connect a headless agent participant (a separate OS process: it shares no memory with the browsers).
    // Steps 14-15: it subscribes explicitly to the cube, reads structured state, and requests material and position changes.
    const agent = await runAgentCli([
      "--url", wsUrl(host), "--entity", CUBE, "--color", AGENT_COLOR.join(","), `--position=${AGENT_POSITION.join(",")}`, "--trace-wire",
    ]);
    assert.equal(agent.code, 0, agent.stderr + agent.stdout);
    assert.equal(agent.stderr, "");
    assert.notEqual(agent.pid, process.pid);
    const names = agent.events.map((event) => event.event);
    assert.deepEqual(names.filter((name) => !name.startsWith("wire.")), [
      "agent.start", "session.live", "subscription.applied", "entity.observed", "asset.checked",
      "request.sent", "request.committed", "entity.observed", "intent.resolved",
      "request.sent", "request.committed", "entity.observed", "intent.resolved", "session.closed", "result",
    ]);
    const live = agent.events.find((event) => event.event === "session.live")!;
    assert.equal(live.participantKind, "agent");
    assert.equal(live.realmEpoch, host.realmEpoch);
    assert.notEqual(live.participantId, a.client.participantId);
    assert.notEqual(live.participantId, b.client.participantId);
    // Explicit subscribe: the join selector is empty, then subscription.set names the cube.
    const out = agent.events.filter((event) => event.event === "wire.out").map((event) => event.frame as Record<string, any>);
    assert.deepEqual(out.map((frame) => frame.type), ["session.hello", "realm.join", "subscription.set", "component.set", "component.patch"]);
    assert.deepEqual(out[1]!.body.subscription, {});
    assert.deepEqual(out[2]!.body, { entities: [CUBE] });
    assert.equal(agent.events.find((event) => event.event === "subscription.applied") !== undefined, true);
    // Structured read, with the revisions exactly as the host holds them.
    const observed = agent.events.find((event) => event.event === "entity.observed")!;
    assert.equal(observed.reason, "subscribed");
    assert.equal(observed.entity.id, CUBE);
    assert.equal(observed.entity.components[TRANSFORM].revision, 2);
    assert.equal(observed.entity.components[MATERIAL].revision, 2);
    assert.deepEqual(observed.entity.components[TRANSFORM].state.position, MOVED);
    assert.deepEqual(observed.entity.components[MATERIAL].state.baseColor, BLUE);
    // The mutations are fenced on the observed revisions.
    const sent = agent.events.filter((event) => event.event === "request.sent");
    assert.deepEqual(sent.map((event) => [event.baseRevision]), [[2], [2]]);
    assert.deepEqual(agent.events.filter((event) => event.event === "request.committed").map((event) => event.revision), [3, 3]);
    assert.deepEqual(agent.events.at(-1), { n: agent.events.length, event: "result", outcome: "satisfied", exitCode: 0 });

    // Step 16: both browser clients observe the accepted canonical result (state, revision, Three objects).
    for (const browser of [a, b]) {
      await waitFor(browser.client, () => revisions(browser.client, CUBE)?.transform === 3 && revisions(browser.client, CUBE)?.material === 3,
        `${browser.name} sees the agent result`);
      assert.deepEqual(shared(browser.client, CUBE)!.components[TRANSFORM].state.position, AGENT_POSITION);
      assert.deepEqual(shared(browser.client, CUBE)!.components[MATERIAL].state.baseColor, AGENT_COLOR);
      assert.deepEqual(positionOf(browser, CUBE), AGENT_POSITION);
      assert.deepEqual(colorOf(browser, CUBE), AGENT_COLOR);
      assert.equal(browser.view.assetStatus(CUBE), "loaded");
    }
    const durable = host.worldStore.getEntity(CUBE)!;
    assert.deepEqual([durable.components[TRANSFORM].revision, durable.components[MATERIAL].revision], [3, 3]);
    assert.deepEqual(durable.components[TRANSFORM].state.position, AGENT_POSITION);
    assert.deepEqual(durable.components[MATERIAL].state.baseColor, AGENT_COLOR);

    // "No renderer-specific private channel": browsers used only the P1 wire (via P1Client) plus the advertised
    // asset endpoint; the Three view has no request surface; the agent is a different process with its own session.
    for (const browser of [a, b]) {
      assert.ok(browser.sent.every((frame) => BROWSER_FRAME_TYPES.has(frame.type)), `${browser.name} sent only P1 frames`);
      assert.ok(browser.sent.every((frame) => frame.hvtp === "0.2"));
      const base = new URL("/assets/p1/", wsUrl(host).replace("ws:", "http:")).toString();
      assert.ok(browser.fetched.length > 0 && browser.fetched.every((url) => url === `${base}unit-cube.gltf`), `${browser.name} fetched only the asset endpoint`);
      assert.deepEqual(browser.assetFailures, []);
    }
    assert.equal(typeof (a.view as unknown as { setComponent?: unknown }).setComponent, "undefined");
    assert.equal(a.client.participantId === live.participantId, false);
  } finally {
    for (const browser of browsers) { browser.client.disconnect(); browser.view.dispose(); }
    await host?.close();
    database.remove();
  }
});
