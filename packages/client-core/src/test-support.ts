import { P1_REALM_ID, P1_LIMITS } from "@hvtp/protocol-types";
import { P1Client, type P1ClientEvent, type P1ClientOptions } from "./client.js";
import type { P1Socket } from "./socket.js";

/** In-memory socket driven by the test: it records client frames and injects host frames synchronously. */
export class FakeSocket implements P1Socket {
  readonly sent: Array<Record<string, any>> = [];
  closed: { code: number | undefined; reason: string | undefined } | null = null;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  send(data: string): void { this.sent.push(JSON.parse(data) as Record<string, any>); }
  close(code?: number, reason?: string): void { this.closed = { code, reason }; }
  open(): void { this.onopen?.({}); }
  deliver(message: unknown): void { this.onmessage?.({ data: typeof message === "string" ? message : JSON.stringify(message) }); }
  hostClose(code = 1006): void { this.onclose?.({ code, reason: "" }); }
}

export const EPOCH = "epoch:test-1";
export const PARTICIPANT = "participant:me";
export const PRESENCE = "entity:presence-me";
export const S0 = "subscription:s0";

let counter = 0;
const envelope = (type: string, extra: Record<string, unknown> = {}) =>
  ({ hvtp: "0.2", id: `host-${++counter}`, type, realm: P1_REALM_ID, realmEpoch: EPOCH, ...extra });

export const welcome = () => ({
  hvtp: "0.2", id: `host-${++counter}`, type: "session.welcome",
  body: { version: "0.2", participantId: PARTICIPANT, server: { name: "hvtp-reference-host", version: "0.1.0" },
    assetBaseUri: "http://127.0.0.1:8787/assets/p1/", limits: P1_LIMITS },
});

export interface SnapshotMeta { snapshotId: string; snapshotBaseSeq: number; subscriptionId: string; realmEpoch: string }
export const META: SnapshotMeta = { snapshotId: "snapshot:1", snapshotBaseSeq: 10, subscriptionId: S0, realmEpoch: EPOCH };

export const joined = (meta: SnapshotMeta = META, subscription: Record<string, unknown> = { spatial: { center: [0, 0, 0], radius: 100 } }) => ({
  ...envelope("realm.joined"), realmEpoch: meta.realmEpoch,
  body: { participantId: PARTICIPANT, presenceEntityId: PRESENCE, subscriptionId: meta.subscriptionId, effectiveSubscription: subscription,
    snapshotId: meta.snapshotId, snapshotBaseSeq: meta.snapshotBaseSeq,
    requiredComponents: ["hvtp.transform@1", "hvtp.renderable@1", "hvtp.material@1", "hvtp.presence@1"] },
});
export const begin = (meta: SnapshotMeta = META) => ({
  ...envelope("realm.snapshot.begin"), realmEpoch: meta.realmEpoch,
  body: { snapshotId: meta.snapshotId, subscriptionId: meta.subscriptionId, snapshotBaseSeq: meta.snapshotBaseSeq },
});
export const snapshotEntity = (entity: unknown, meta: SnapshotMeta = META) => ({
  ...envelope("entity.snapshot"), realmEpoch: meta.realmEpoch,
  body: { snapshotId: meta.snapshotId, snapshotBaseSeq: meta.snapshotBaseSeq, entity },
});
export const end = (entityCount: number, meta: SnapshotMeta = META) => ({
  ...envelope("realm.snapshot.end"), realmEpoch: meta.realmEpoch,
  body: { snapshotId: meta.snapshotId, subscriptionId: meta.subscriptionId, snapshotBaseSeq: meta.snapshotBaseSeq, entityCount },
});

const component = (state: unknown, revision = 1) => ({ revision, authority: "host", authorityEpoch: 1, consistency: "authoritative", state });

export const presence = (id = PRESENCE, participantId = PARTICIPANT) => ({
  id,
  components: {
    "hvtp.transform@1": component({ position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }),
    "hvtp.presence@1": component({ participantId, kind: "human" }),
  },
});

export const cube = (id: string, x = 0, revisions: { transform?: number; material?: number } = {},
  baseColor: number[] = [1, 1, 1, 1], visible = true) => ({
  id,
  components: {
    "hvtp.transform@1": component({ position: [x, 0.5, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, revisions.transform ?? 1),
    "hvtp.renderable@1": component({ asset: { uri: "unit-cube.gltf", mediaType: "model/gltf+json" }, node: "UnitCube", visible }),
    "hvtp.material@1": component({ baseColor }, revisions.material ?? 1),
  },
});

export const transformValue = (x: number, revision: number) =>
  component({ position: [x, 0.5, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, revision);
export const materialValue = (baseColor: number[], revision: number) => component({ baseColor }, revision);

export const publication = (type: string, seq: number, subscriptionId: string, body: Record<string, unknown>, realmEpoch = EPOCH) =>
  ({ ...envelope(type, { seq }), realmEpoch, body: { subscriptionId, ...body } });
export const created = (entity: unknown, seq: number, sub = S0) => publication("entity.created", seq, sub, { entity });
export const updated = (entityId: string, componentName: string, value: unknown, seq: number, sub = S0) =>
  publication("component.updated", seq, sub, { entityId, component: componentName, value });
export const deleted = (entityId: string, seq: number, sub = S0) => publication("entity.deleted", seq, sub, { entityId });
export const enter = (entity: unknown, seq: number, sub = S0, reason = "interest") => publication("view.entity.enter", seq, sub, { reason, entity });
export const leave = (entityId: string, seq: number, sub = S0, reason = "interest") => publication("view.entity.leave", seq, sub, { reason, entityId });

export const ack = (ref: string, seq: number, entityId: string, extra: Record<string, unknown> = {}) =>
  ({ ...envelope("ack"), body: { ref, status: "committed", seq, entityId, ...extra } });
export const applied = (ref: string, previousSubscriptionId: string, subscriptionId: string, baseRealmSeq: number,
  effectiveSubscription: Record<string, unknown> = {}) =>
  ({ ...envelope("subscription.applied"), body: { ref, previousSubscriptionId, subscriptionId, baseRealmSeq, effectiveSubscription } });
export const hostError = (ref: string | null, code: string) =>
  ({ ...envelope("error"), body: { ref, code, message: code } });

export interface Harness {
  readonly client: P1Client;
  readonly sockets: FakeSocket[];
  readonly events: P1ClientEvent[];
  readonly socket: FakeSocket;
}

export function harness(options: Partial<P1ClientOptions> = {}): Harness {
  const sockets: FakeSocket[] = [];
  let ids = 0;
  const client = new P1Client({
    url: "ws://test/hvtp",
    socketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    createId: (prefix) => `${prefix}:${++ids}`,
    ...options,
  });
  const events: P1ClientEvent[] = [];
  client.on((event) => events.push(event));
  return { client, sockets, events, get socket() { return sockets.at(-1)!; } };
}

/** Drives a fresh connection on the harness up to (but excluding) the snapshot stream. */
export function negotiate(h: Harness, meta: SnapshotMeta = META): Promise<void> {
  const ready = h.client.connect();
  h.socket.open();
  h.socket.deliver(welcome());
  h.socket.deliver(joined(meta));
  return ready;
}

/** Drives a complete valid join with the given shared entities plus own presence. */
export async function live(h: Harness, entities: unknown[] = [], meta: SnapshotMeta = META): Promise<void> {
  const ready = negotiate(h, meta);
  h.socket.deliver(begin(meta));
  for (const entity of entities) h.socket.deliver(snapshotEntity(entity, meta));
  h.socket.deliver(snapshotEntity(presence(), meta));
  h.socket.deliver(end(entities.length + 1, meta));
  await ready;
}
