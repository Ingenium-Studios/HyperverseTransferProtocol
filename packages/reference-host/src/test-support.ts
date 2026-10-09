import assert from "node:assert/strict";
import WebSocket, { type RawData } from "ws";
import { P1_REALM_ID } from "@hvtp/protocol-types";
import { createReferenceHost, type ReferenceHost, type ReferenceHostOptions } from "./server.js";

export interface Wire {
  type: string;
  realmEpoch?: string;
  seq?: number;
  body: Record<string, any>;
}

export const helloMessage = (id = "hello", clientName = "test") => ({
  hvtp: "0.2", id, type: "session.hello",
  body: {
    versions: ["0.2"], client: { name: clientName, version: "1" }, participant: { kind: "agent" },
    capabilities: { components: ["hvtp.transform@1", "hvtp.renderable@1", "hvtp.material@1", "hvtp.presence@1"] },
  },
});

export const joinMessage = (id = "join", subscription: Record<string, unknown> = {}) => ({
  hvtp: "0.2", id, type: "realm.join", body: { realm: P1_REALM_ID, subscription },
});

export const subscriptionMessage = (id: string, body: Record<string, unknown>) => ({
  hvtp: "0.2", id, type: "subscription.set", realm: P1_REALM_ID, body,
});

export const cubeInput = (id: string, x = 0) => ({
  id,
  transform: { position: [x, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] },
  renderable: { asset: { uri: "unit-cube.gltf" as const, mediaType: "model/gltf+json" as const }, node: "UnitCube" as const, visible: true },
  material: { baseColor: [1, 1, 1, 1] as [number, number, number, number] },
});

export const createMessage = (id: string, entityId: string, x = 0) => {
  const cube = cubeInput(entityId, x);
  return {
    hvtp: "0.2", id, type: "entity.create", realm: P1_REALM_ID,
    body: { entity: { id: entityId, components: {
      "hvtp.transform@1": { state: cube.transform }, "hvtp.renderable@1": { state: cube.renderable }, "hvtp.material@1": { state: cube.material },
    } } },
  };
};

export const setTransformMessage = (id: string, entityId: string, baseRevision: number, x: number) => ({
  hvtp: "0.2", id, type: "component.set", realm: P1_REALM_ID,
  body: { entityId, component: "hvtp.transform@1", authorityEpoch: 1, baseRevision, state: cubeInput(entityId, x).transform },
});

export const patchTransformMessage = (id: string, entityId: string, baseRevision: number, x: number) => ({
  hvtp: "0.2", id, type: "component.patch", realm: P1_REALM_ID,
  body: { entityId, component: "hvtp.transform@1", authorityEpoch: 1, baseRevision, patch: { position: [x, 0, 0] } },
});

export const deleteMessage = (id: string, entityId: string) => ({
  hvtp: "0.2", id, type: "entity.delete", realm: P1_REALM_ID, body: { entityId },
});

/** Manually advanced monotonic clock; rate tests never sleep. */
export function manualClock(start = 0) {
  let current = start;
  return { now: () => current, advance(ms: number) { current += ms; } };
}

let fenceCounter = 0;

/** Deterministic clock that never fills a 1-second rate window (rate behaviour has its own tests). */
export const fastClock = (): (() => number) => { let tick = 0; return () => (tick += 1000); };

/** WebSocket test client that queues every received message and records the close code. */
export class Peer {
  readonly messages: Wire[] = [];
  readonly closed: Promise<number>;
  closeCode: number | null = null;
  readonly #waiters: Array<(message: Wire) => void> = [];

  constructor(readonly socket: WebSocket) {
    socket.on("message", (data: RawData) => {
      const message = JSON.parse(data.toString()) as Wire;
      const waiter = this.#waiters.shift();
      if (waiter) waiter(message); else this.messages.push(message);
    });
    this.closed = new Promise((resolve) => socket.once("close", (code: number) => { this.closeCode = code; resolve(code); }));
  }

  send(request: unknown): void {
    this.socket.send(typeof request === "string" ? request : JSON.stringify(request));
  }

  next(): Promise<Wire> {
    const message = this.messages.shift();
    return message ? Promise.resolve(message) : new Promise((resolve) => this.#waiters.push(resolve));
  }

  async take(count: number): Promise<Wire[]> {
    const result: Wire[] = [];
    for (let i = 0; i < count; i++) result.push(await this.next());
    return result;
  }

  /** Ping/pong round trip: every frame the host wrote before replying has been received (TCP ordering). */
  async flush(): Promise<void> {
    await new Promise<void>((resolve) => { this.socket.once("pong", () => resolve()); this.socket.ping(); });
  }

  /**
   * Deterministic quiet-period marker: an invalid-state request is answered in order behind every frame the host
   * already queued for this peer. Returns the frames that arrived before the marker reply (no timers).
   */
  async fence(host?: ReferenceHost): Promise<Wire[]> {
    if (host !== undefined) await host.realmCoordinator.drain();
    const marker = `fence-${++fenceCounter}`;
    this.send({ ...helloMessage(), id: marker });
    const events: Wire[] = [];
    for (;;) {
      const message = await this.next();
      if (message.type === "error" && message.body.ref === marker) return events;
      events.push(message);
    }
  }

  async request(request: unknown): Promise<Wire> {
    this.send(request);
    return await this.next();
  }

  async hello(): Promise<Wire> {
    const welcome = await this.request(helloMessage());
    assert.equal(welcome.type, "session.welcome");
    return welcome;
  }

  /** Join and consume the whole snapshot sequence; returns the `realm.joined` message. */
  async join(subscription: Record<string, unknown> = {}): Promise<Wire> {
    this.send(joinMessage("join", subscription));
    const joined = await this.next();
    assert.equal(joined.type, "realm.joined");
    for (;;) if ((await this.next()).type === "realm.snapshot.end") return joined;
  }
}

export async function connect(host: ReferenceHost): Promise<Peer> {
  const socket = new WebSocket(`ws://${host.host}:${host.port}/hvtp`);
  const peer = new Peer(socket);
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  return peer;
}

export async function joinedPeer(host: ReferenceHost, subscription: Record<string, unknown> = {}): Promise<Peer> {
  const peer = await connect(host);
  await peer.hello();
  await peer.join(subscription);
  return peer;
}

export async function startHost(options: ReferenceHostOptions = {}): Promise<ReferenceHost> {
  return await createReferenceHost({ clock: fastClock(), databasePath: ":memory:", ...options });
}

/** Run `run` against a fresh in-memory host that is always closed afterwards. */
export async function withHost(run: (host: ReferenceHost) => Promise<void>, options: ReferenceHostOptions = {}): Promise<void> {
  const host = await startHost(options);
  try { await run(host); } finally { await host.close(); }
}

/** Join and return every message through `realm.snapshot.end` (or the error that refused the join). */
export async function joinCollect(peer: Peer, subscription: Record<string, unknown> = {}, id = "join"): Promise<Wire[]> {
  peer.send(joinMessage(id, subscription));
  const result: Wire[] = [];
  do { result.push(await peer.next()); } while (result.at(-1)!.type !== "realm.snapshot.end" && result.at(-1)!.type !== "error");
  return result;
}

/** IDs of non-presence entities in a snapshot, sorted. */
export function snapshotSharedIds(messages: readonly Wire[]): string[] {
  return messages.filter((m) => m.type === "entity.snapshot")
    .map((m) => m.body.entity as { id: string; components: Record<string, unknown> })
    .filter((entity) => !Object.hasOwn(entity.components, "hvtp.presence@1"))
    .map((entity) => entity.id).sort();
}

/** Replace the first `placeholder` in the serialized request with a raw JSON literal such as `1e400`. */
export function withLiteral(request: unknown, placeholder: string, literal: string): string {
  const text = JSON.stringify(request);
  assert.ok(text.includes(placeholder), `placeholder ${placeholder} missing`);
  return text.replace(placeholder, literal);
}

export async function connectedPeer(host: ReferenceHost): Promise<Peer> {
  const peer = await connect(host);
  await peer.hello();
  return peer;
}
