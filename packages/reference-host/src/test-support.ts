import assert from "node:assert/strict";
import WebSocket, { type RawData } from "ws";
import { P1_REALM_ID } from "@hvtp/protocol-types";
import type { ReferenceHost } from "./server.js";

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
