import { randomUUID } from "node:crypto";
import {
  HVTP_VERSION, P1_LIMITS, P1_REALM_ID,
  type CanonicalPublicationMessage, type P1SharedEntity,
  type SessionServerMessage, type SubscriptionAppliedMessage, type SubscriptionSelector,
} from "@hvtp/protocol-types";
import type { P1OutboundChannel } from "./outbound.js";
import { entitySelectedBy, P1StoreError, type MutableP1Component } from "./world-store.js";

export type CommittedWorldMutation =
  | { readonly kind: "created"; readonly seq: number; readonly entity: P1SharedEntity }
  | { readonly kind: "updated"; readonly seq: number; readonly before: P1SharedEntity;
      readonly entity: P1SharedEntity; readonly component: MutableP1Component }
  | { readonly kind: "deleted"; readonly seq: number; readonly entity: P1SharedEntity };

export interface P1RealmCoordinatorOptions {
  /** Deterministic barriers before enqueue onto an individual connection. */
  readonly beforeMutationEnqueue?: (seq: number) => Promise<void>;
  readonly beforeSnapshotEnqueue?: (subscriptionId: string) => Promise<void>;
  readonly beforeTransitionEnqueue?: (subscriptionId: string) => Promise<void>;
}

interface Payload { readonly text: string; readonly bytes: number }
interface Batch {
  readonly payloads: readonly Payload[];
  readonly before?: () => Promise<void> | undefined;
  readonly completed?: () => void;
}
interface Subscriber {
  // These represent the view at the tail of the admitted stream, including queued batches.
  selector: SubscriptionSelector;
  subscriptionId: string;
  view: Set<string>;
  readonly baseSeq: number;
  readonly channel: P1OutboundChannel;
  readonly close: (code: number, reason: string) => void;
  readonly batches: Batch[];
  readonly abort: AbortController;
  /** Bytes reserved on the connection budget but not yet handed to the transport. */
  queuedBytes: number;
  running: boolean;
  active: boolean;
}
export interface P1Subscriber {
  unsubscribe(): void;
  replace(
    selector: SubscriptionSelector,
    snapshot: { readonly baseSeq: number; readonly entities: readonly P1SharedEntity[] },
    ref: string,
    completed: (terminal: SubscriptionAppliedMessage) => void,
  ): void;
}

export class P1RealmCoordinator {
  readonly #realmEpoch: string;
  readonly #options: P1RealmCoordinatorOptions;
  readonly #subscribers = new Set<Subscriber>();
  readonly #privatePresenceEntityIds = new Set<string>();
  readonly #work = new Set<Promise<void>>();

  constructor(realmEpoch: string, options: P1RealmCoordinatorOptions = {}) {
    this.#realmEpoch = realmEpoch;
    this.#options = options;
  }

  subscribe(
    selector: SubscriptionSelector,
    subscriptionId: string,
    snapshot: { readonly baseSeq: number; readonly entities: readonly P1SharedEntity[] },
    messages: readonly SessionServerMessage[],
    channel: P1OutboundChannel,
    close: (code: number, reason: string) => void,
    completed: () => void,
  ): P1Subscriber {
    const subscriber: Subscriber = {
      selector, subscriptionId, view: new Set(this.#authorized(snapshot.entities).map((entity) => entity.id)),
      baseSeq: snapshot.baseSeq, channel, close, batches: [], abort: new AbortController(), queuedBytes: 0, running: false, active: true,
    };
    this.#subscribers.add(subscriber);
    this.#enqueue(subscriber, messages, () => this.#options.beforeSnapshotEnqueue?.(subscriptionId), completed);
    return {
      unsubscribe: () => this.#remove(subscriber),
      replace: (selector, snapshot, ref, completed) => this.#replace(subscriber, selector, snapshot, ref, completed),
    };
  }

  get subscriberCount(): number {
    return this.#subscribers.size;
  }

  get privatePresenceCount(): number {
    return this.#privatePresenceEntityIds.size;
  }

  registerPresenceEntity(entityId: string): () => void {
    this.#privatePresenceEntityIds.add(entityId);
    return () => this.#privatePresenceEntityIds.delete(entityId);
  }
  isPrivatePresenceEntity(entityId: string): boolean {
    return this.#privatePresenceEntityIds.has(entityId);
  }

  #authorized(entities: readonly P1SharedEntity[]): readonly P1SharedEntity[] {
    return entities.filter((entity) => !this.isPrivatePresenceEntity(entity.id));
  }

  #replace(
    subscriber: Subscriber, selector: SubscriptionSelector,
    snapshot: { readonly baseSeq: number; readonly entities: readonly P1SharedEntity[] },
    ref: string, completed: (terminal: SubscriptionAppliedMessage) => void,
  ): void {
    if (!subscriber.active) throw new P1StoreError("invalid_state", "Subscriber is closed.");
    const entities = this.#authorized(snapshot.entities);
    if (entities.length + 1 > P1_LIMITS.maxVisibleEntitiesPerConnection) {
      throw new P1StoreError("resource_limit", "Replacement effective view exceeds maxVisibleEntitiesPerConnection.");
    }
    const subscriptionId = `subscription:${randomUUID()}`;
    const terminal: SubscriptionAppliedMessage = {
      ...this.#envelope(), type: "subscription.applied",
      body: { ref, previousSubscriptionId: subscriber.subscriptionId, subscriptionId,
        baseRealmSeq: snapshot.baseSeq, effectiveSubscription: selector },
    };
    const view = new Set(entities.map((entity) => entity.id));
    const messages: SessionServerMessage[] = [terminal];
    for (const entityId of subscriber.view) {
      if (!view.has(entityId)) messages.push({
        ...this.#envelope(), type: "view.entity.leave", seq: snapshot.baseSeq,
        body: { subscriptionId, reason: "subscription", entityId },
      });
    }
    for (const entity of entities) {
      if (!subscriber.view.has(entity.id)) messages.push({
        ...this.#envelope(), type: "view.entity.enter", seq: snapshot.baseSeq,
        body: { subscriptionId, reason: "subscription", entity },
      });
    }
    // Capture canonical state now, never read the store from an asynchronously executing batch.
    if (this.#enqueue(subscriber, messages, () => this.#options.beforeTransitionEnqueue?.(subscriptionId), () => completed(terminal))) {
      subscriber.selector = selector;
      subscriber.subscriptionId = subscriptionId;
      subscriber.view = view;
    }
  }

  publish(mutation: CommittedWorldMutation): void {
    for (const subscriber of this.#subscribers) {
      if (!subscriber.active || mutation.seq <= subscriber.baseSeq || this.isPrivatePresenceEntity(mutation.entity.id)) continue;
      try {
        const message = this.#project(mutation, subscriber);
        if (message === null) continue;
        const grows = message.type === "entity.created" || message.type === "view.entity.enter";
        if (grows && !subscriber.view.has(mutation.entity.id) && subscriber.view.size + 2 > P1_LIMITS.maxVisibleEntitiesPerConnection) {
          this.#resourceFailure(subscriber, "Live effective view exceeds maxVisibleEntitiesPerConnection.");
          continue;
        }
        if (!this.#enqueue(subscriber, [message], () => this.#options.beforeMutationEnqueue?.(mutation.seq))) continue;
        if (message.type === "entity.deleted" || message.type === "view.entity.leave") subscriber.view.delete(mutation.entity.id);
        else subscriber.view.add(mutation.entity.id);
      } catch {
        this.#disconnect(subscriber, "failed to project canonical P1 publication");
      }
    }
  }

  #envelope() {
    return { hvtp: HVTP_VERSION, id: `pub:${randomUUID()}`, realm: P1_REALM_ID, realmEpoch: this.#realmEpoch } as const;
  }
  #project(mutation: CommittedWorldMutation, subscriber: Subscriber): CanonicalPublicationMessage | null {
    const envelope = { ...this.#envelope(), seq: mutation.seq };
    const subscriptionId = subscriber.subscriptionId;
    const wasVisible = subscriber.view.has(mutation.entity.id);
    if (mutation.kind === "deleted") {
      return wasVisible ? { ...envelope, type: "entity.deleted", body: { subscriptionId, entityId: mutation.entity.id } } : null;
    }
    const isVisible = entitySelectedBy(mutation.entity, subscriber.selector);
    if (mutation.kind === "created") {
      return isVisible ? { ...envelope, type: "entity.created", body: { subscriptionId, entity: mutation.entity } } : null;
    }
    if (!wasVisible && !isVisible) return null;
    if (!wasVisible) return { ...envelope, type: "view.entity.enter", body: { subscriptionId, reason: "interest", entity: mutation.entity } };
    if (!isVisible) return { ...envelope, type: "view.entity.leave", body: { subscriptionId, reason: "interest", entityId: mutation.entity.id } };
    return { ...envelope, type: "component.updated", body: {
      subscriptionId, entityId: mutation.entity.id, component: mutation.component, value: mutation.entity.components[mutation.component],
    } };
  }

  #enqueue(subscriber: Subscriber, messages: readonly SessionServerMessage[], before?: Batch["before"], completed?: () => void): boolean {
    if (!subscriber.active) return false;
    const payloads = messages.map((message) => {
      const text = JSON.stringify(message);
      return { text, bytes: Buffer.byteLength(text, "utf8") };
    });
    const bytes = payloads.reduce((total, payload) => total + payload.bytes, 0);
    // One connection-wide budget shared with direct responses and transport-pending sends.
    if (!subscriber.channel.reserve(bytes)) {
      this.#resourceFailure(subscriber, "Connection outbound buffers exceed maxQueuedOutboundBytes.");
      return false;
    }
    subscriber.queuedBytes += bytes;
    subscriber.batches.push({ payloads, ...(before === undefined ? {} : { before }), ...(completed === undefined ? {} : { completed }) });
    if (!subscriber.running) {
      subscriber.running = true;
      // Begin on the next microtask so planning state and handles are installed before delivery.
      const work = Promise.resolve().then(() => this.#pump(subscriber));
      this.#work.add(work);
      void work.finally(() => this.#work.delete(work));
    }
    return true;
  }
  async #pump(subscriber: Subscriber): Promise<void> {
    try {
      while (subscriber.active && subscriber.batches.length > 0) {
        const batch = subscriber.batches.shift()!;
        const barrier = batch.before?.();
        if (barrier !== undefined) await waitOrClosed(barrier, subscriber.abort.signal);
        if (!subscriber.active) break;
        for (const payload of batch.payloads) {
          if (!subscriber.active) break;
          // Reservation ownership moves to the channel, which releases it when the transport completes.
          subscriber.queuedBytes -= payload.bytes;
          subscriber.channel.sendReserved(payload.text, payload.bytes);
        }
        if (!subscriber.active) break;
        batch.completed?.();
      }
    } catch {
      this.#disconnect(subscriber, "failed to enqueue P1 subscriber batch; reconnect for a fresh snapshot");
    } finally {
      subscriber.running = false;
    }
  }
  async drain(): Promise<void> {
    while (this.#work.size > 0) await Promise.all(this.#work);
  }
  #remove(subscriber: Subscriber): void {
    subscriber.active = false;
    subscriber.abort.abort();
    subscriber.batches.length = 0;
    if (subscriber.queuedBytes > 0) subscriber.channel.release(subscriber.queuedBytes);
    subscriber.queuedBytes = 0;
    subscriber.view.clear();
    this.#subscribers.delete(subscriber);
  }
  #resourceFailure(subscriber: Subscriber, message: string): void {
    try {
      subscriber.channel.trySend({ ...this.#envelope(), type: "error", body: { ref: null, code: "resource_limit", message } });
    } catch { /* Closing is sufficient when the transport cannot enqueue an error. */ }
    this.#disconnect(subscriber, "P1 subscriber resource limit; reconnect with a narrower view");
  }
  #disconnect(subscriber: Subscriber, reason: string): void {
    if (!subscriber.active) return;
    this.#remove(subscriber);
    subscriber.close(1011, reason);
  }
}

async function waitOrClosed(barrier: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  let closed!: () => void;
  const cancellation = new Promise<void>((resolve) => { closed = resolve; });
  signal.addEventListener("abort", closed, { once: true });
  try { await Promise.race([barrier, cancellation]); }
  finally { signal.removeEventListener("abort", closed); }
}
