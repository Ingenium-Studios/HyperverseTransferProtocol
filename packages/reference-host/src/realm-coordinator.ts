import { randomUUID } from "node:crypto";
import {
  HVTP_VERSION,
  P1_REALM_ID,
  type CanonicalPublicationMessage,
  type P1SharedEntity,
  type SubscriptionSelector,
} from "@hvtp/protocol-types";
import { entitySelectedBy, type MutableP1Component } from "./world-store.js";

export type CommittedWorldMutation =
  | { readonly kind: "created"; readonly seq: number; readonly entity: P1SharedEntity }
  | {
      readonly kind: "updated";
      readonly seq: number;
      readonly before: P1SharedEntity;
      readonly entity: P1SharedEntity;
      readonly component: MutableP1Component;
    }
  | { readonly kind: "deleted"; readonly seq: number; readonly entity: P1SharedEntity };

export interface P1RealmCoordinatorOptions {
  /** Deterministic test barrier before projecting a committed mutation. */
  readonly beforeMutationEnqueue?: (seq: number) => Promise<void>;
}

interface Subscriber {
  readonly selector: SubscriptionSelector;
  readonly subscriptionId: string;
  readonly deliver: (message: CanonicalPublicationMessage) => void;
  readonly close: (code: number, reason: string) => void;
  active: boolean;
}

export class P1RealmCoordinator {
  readonly #realmEpoch: string;
  readonly #options: P1RealmCoordinatorOptions;
  readonly #subscribers = new Set<Subscriber>();
  readonly #privatePresenceEntityIds = new Set<string>();
  #tail: Promise<void> = Promise.resolve();

  constructor(realmEpoch: string, options: P1RealmCoordinatorOptions = {}) {
    this.#realmEpoch = realmEpoch;
    this.#options = options;
  }

  subscribe(
    selector: SubscriptionSelector,
    subscriptionId: string,
    deliver: (message: CanonicalPublicationMessage) => void,
    close: (code: number, reason: string) => void,
  ): () => void {
    const subscriber: Subscriber = { selector, subscriptionId, deliver, close, active: true };
    this.#subscribers.add(subscriber);
    return () => {
      subscriber.active = false;
      this.#subscribers.delete(subscriber);
    };
  }

  registerPresenceEntity(entityId: string): () => void {
    this.#privatePresenceEntityIds.add(entityId);
    return () => this.#privatePresenceEntityIds.delete(entityId);
  }

  isPrivatePresenceEntity(entityId: string): boolean {
    return this.#privatePresenceEntityIds.has(entityId);
  }

  publish(mutation: CommittedWorldMutation): void {
    const subscribers = [...this.#subscribers];
    const task = this.#tail.then(async () => {
      try {
        await this.#options.beforeMutationEnqueue?.(mutation.seq);
      } catch {
        for (const subscriber of subscribers) this.#disconnect(subscriber, "canonical publication queue failed");
        return;
      }
      for (const subscriber of subscribers) {
        if (!subscriber.active) continue;
        try {
          const message = project(mutation, subscriber.selector, subscriber.subscriptionId, this.#realmEpoch);
          if (message === null) continue;
          subscriber.deliver(message);
        } catch {
          this.#disconnect(subscriber, "failed to project or enqueue canonical P1 publication");
        }
      }
    });
    this.#tail = task.catch(() => undefined);
  }

  async drain(): Promise<void> {
    await this.#tail;
  }

  #disconnect(subscriber: Subscriber, reason: string): void {
    if (!subscriber.active) return;
    subscriber.active = false;
    this.#subscribers.delete(subscriber);
    subscriber.close(1011, reason);
  }
}

function project(
  mutation: CommittedWorldMutation,
  selector: SubscriptionSelector,
  subscriptionId: string,
  realmEpoch: string,
): CanonicalPublicationMessage | null {
  const envelope = {
    hvtp: HVTP_VERSION,
    id: `pub:${randomUUID()}`,
    realm: P1_REALM_ID,
    realmEpoch,
    seq: mutation.seq,
  } as const;
  if (mutation.kind === "created") {
    if (!entitySelectedBy(mutation.entity, selector)) return null;
    return { ...envelope, type: "entity.created", body: { subscriptionId, entity: mutation.entity } };
  } else if (mutation.kind === "deleted") {
    if (!entitySelectedBy(mutation.entity, selector)) return null;
    return { ...envelope, type: "entity.deleted", body: { subscriptionId, entityId: mutation.entity.id } };
  } else {
    const wasVisible = entitySelectedBy(mutation.before, selector);
    const isVisible = entitySelectedBy(mutation.entity, selector);
    if (!wasVisible && !isVisible) return null;
    if (!wasVisible) {
      return {
        ...envelope,
        type: "view.entity.enter",
        body: { subscriptionId, reason: "interest", entity: mutation.entity },
      };
    }
    if (!isVisible) {
      return {
        ...envelope,
        type: "view.entity.leave",
        body: { subscriptionId, reason: "interest", entityId: mutation.entity.id },
      };
    }
    return {
      ...envelope,
      type: "component.updated",
      body: {
        subscriptionId,
        entityId: mutation.entity.id,
        component: mutation.component,
        value: mutation.entity.components[mutation.component],
      },
    };
  }
}
