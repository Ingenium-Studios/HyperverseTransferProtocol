import {
  ack, applied, begin, end, EPOCH, FakeSocket, hostError, joined, presence, publication, snapshotEntity, welcome,
  type SnapshotMeta,
} from "@hvtp/client-core/test-support";
import type { P1SocketFactory } from "@hvtp/client-core";

type Frame = Record<string, any>;

/** What the scripted host does with one component mutation. */
export type MutationBehavior =
  | { readonly kind: "commit" }
  /** Commit durably, publish to other sessions, then close the requester without an ACK. */
  | { readonly kind: "commit-and-drop"; readonly code?: number }
  /** Close the requester without committing (the request never reached the host). */
  | { readonly kind: "drop"; readonly code?: number }
  | { readonly kind: "error"; readonly code: string }
  | { readonly kind: "ignore" };

const envelope = (state: unknown, revision: number) =>
  ({ revision, authority: "host", authorityEpoch: 1, consistency: "authoritative", state });

export class ScriptSocket extends FakeSocket {
  subscriptionId = "";
  selector: Frame = {};
  generation = 0;
  constructor(readonly index: number, private readonly host: ScriptedHost) { super(); }
  override send(data: string): void {
    super.send(data);
    const frame = JSON.parse(data) as Frame;
    queueMicrotask(() => this.host.receive(this, frame));
  }
}

/**
 * Scripted P1 host over client-core `FakeSocket`s, for deterministic unit tests of the agent. It answers the
 * handshake, join, subscription, and component mutations from an in-memory world, and records every frame.
 * Presence entities carry `kind: "agent"`.
 */
export class ScriptedHost {
  readonly entities = new Map<string, { id: string; components: Record<string, any> }>();
  readonly sockets: ScriptSocket[] = [];
  readonly received: Array<{ session: number; frame: Frame }> = [];
  /** Chooses the behavior of the n-th (0-based) component mutation seen across all sessions. */
  mutate: (frame: Frame, index: number) => MutationBehavior = () => ({ kind: "commit" });
  /** Sessions refused before OPEN (the factory throws) while this is greater than zero. */
  refuseConnections = 0;
  /** If set, the host answers the next hello with this raw (invalid) frame instead of a welcome. */
  garbageOnHello: string | null = null;
  seq = 10;
  private mutations = 0;

  readonly factory: P1SocketFactory = () => {
    if (this.refuseConnections > 0) {
      this.refuseConnections--;
      throw new Error("connection refused");
    }
    const socket = new ScriptSocket(this.sockets.length + 1, this);
    this.sockets.push(socket);
    queueMicrotask(() => socket.open());
    return socket;
  };

  addCube(id: string, options: { x?: number; baseColor?: number[]; transformRevision?: number; materialRevision?: number } = {}): void {
    this.entities.set(id, {
      id,
      components: {
        "hvtp.transform@1": envelope({ position: [options.x ?? 0, 0.5, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, options.transformRevision ?? 1),
        "hvtp.renderable@1": envelope({ asset: { uri: "unit-cube.gltf", mediaType: "model/gltf+json" }, node: "UnitCube", visible: true }, 1),
        "hvtp.material@1": envelope({ baseColor: options.baseColor ?? [1, 1, 1, 1] }, options.materialRevision ?? 1),
      },
    });
  }

  /** Frames of one kind received in a session (1-based), or across all sessions when `session` is omitted. */
  framesOf(type: string, session?: number): Frame[] {
    return this.received.filter((entry) => entry.frame.type === type && (session === undefined || entry.session === session)).map((entry) => entry.frame);
  }

  typesOf(session: number): string[] {
    return this.received.filter((entry) => entry.session === session).map((entry) => entry.frame.type);
  }

  /** Commits a change made by another participant and publishes it to every subscribed session. */
  external(entityId: string, component: string, state: unknown): void {
    this.commit(entityId, component, state, null);
  }

  receive(socket: ScriptSocket, frame: Frame): void {
    this.received.push({ session: socket.index, frame });
    switch (frame.type) {
      case "session.hello":
        if (this.garbageOnHello !== null) { socket.deliver(this.garbageOnHello); return; }
        socket.deliver(welcome());
        return;
      case "realm.join": {
        socket.selector = frame.body.subscription;
        socket.subscriptionId = `subscription:${socket.index}:0`;
        const meta: SnapshotMeta = { snapshotId: `snapshot:${socket.index}`, snapshotBaseSeq: this.seq, subscriptionId: socket.subscriptionId, realmEpoch: EPOCH };
        const visible = this.visible(socket);
        socket.deliver(joined(meta, socket.selector));
        socket.deliver(begin(meta));
        for (const entity of visible) socket.deliver(snapshotEntity(entity, meta));
        const own = presence();
        (own.components["hvtp.presence@1"].state as { kind: string }).kind = "agent";
        socket.deliver(snapshotEntity(own, meta));
        socket.deliver(end(visible.length + 1, meta));
        return;
      }
      case "subscription.set": {
        const previous = socket.subscriptionId;
        socket.selector = frame.body;
        socket.subscriptionId = `subscription:${socket.index}:${++socket.generation}`;
        socket.deliver(applied(frame.id, previous, socket.subscriptionId, this.seq, socket.selector));
        for (const entity of this.visible(socket)) {
          socket.deliver(publication("view.entity.enter", ++this.seq, socket.subscriptionId, { reason: "subscription", entity }));
        }
        return;
      }
      case "component.set":
      case "component.patch":
        this.mutation(socket, frame);
        return;
      default:
        socket.deliver(hostError(frame.id ?? null, "unsupported_message"));
    }
  }

  private visible(socket: ScriptSocket) {
    const ids: string[] = socket.selector.entities ?? [];
    return ids.flatMap((id) => (this.entities.has(id) ? [this.entities.get(id)!] : []));
  }

  private mutation(socket: ScriptSocket, frame: Frame): void {
    const behavior = this.mutate(frame, this.mutations++);
    switch (behavior.kind) {
      case "ignore":
        return;
      case "drop":
        socket.hostClose(behavior.code ?? 1006);
        return;
      case "error":
        socket.deliver(hostError(frame.id, behavior.code));
        return;
      default: {
        const { entityId, component, baseRevision } = frame.body as { entityId: string; component: string; baseRevision: number };
        const entity = this.entities.get(entityId);
        if (entity === undefined) { socket.deliver(hostError(frame.id, "entity_not_found")); return; }
        const current = entity.components[component];
        if (current.revision !== baseRevision) {
          const error = hostError(frame.id, "revision_mismatch");
          socket.deliver({ ...error, body: { ...error.body, entityId, component, currentRevision: current.revision, authorityEpoch: 1 } });
          return;
        }
        const state = frame.type === "component.set" ? frame.body.state : { ...current.state, ...frame.body.patch };
        const seq = this.commit(entityId, component, state, socket, behavior.kind !== "commit-and-drop");
        if (behavior.kind === "commit-and-drop") { socket.hostClose(behavior.code ?? 1011); return; }
        socket.deliver(ack(frame.id, seq, entityId, { component, revision: current.revision + 1, authorityEpoch: 1 }));
      }
    }
  }

  private commit(entityId: string, component: string, state: unknown, requester: ScriptSocket | null, deliverToRequester = true): number {
    const entity = this.entities.get(entityId)!;
    const next = envelope(state, entity.components[component].revision + 1);
    entity.components[component] = next;
    const seq = ++this.seq;
    for (const other of this.sockets) {
      if (other === requester || other.closed !== null || !(other.selector.entities ?? []).includes(entityId)) continue;
      other.deliver(publication("component.updated", seq, other.subscriptionId, { entityId, component, value: next }));
    }
    if (requester !== null && deliverToRequester && (requester.selector.entities ?? []).includes(entityId)) {
      // The requester's own publication precedes its ACK, as on the reference host.
      requester.deliver(publication("component.updated", seq, requester.subscriptionId, { entityId, component, value: next }));
    }
    return seq;
  }
}
