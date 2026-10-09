import type { P1SharedEntity } from "@hvtp/protocol-types";
import {
  isPresenceEntity, P1Client, P1ClientStateError, P1ConnectionError, P1OutcomeUncertainError, P1RequestError,
  platformSocketFactory, type P1Ack, type P1FetchLike, type P1SocketFactory,
} from "@hvtp/client-core";
import { checkAsset } from "./asset-check.js";
import { describeEntity, intentComponent, intentSatisfied, sharedEntity, type P1AgentIntent, type P1EntityDescription } from "./entity-state.js";
import { OUTCOME_EXIT_CODE, type P1AgentEvent, type P1AgentOutcome } from "./events.js";
import { until } from "./wait.js";
import { tapSocketFactory } from "./wire-tap.js";

export interface P1AgentOptions {
  readonly url: string;
  readonly entityId: string;
  /** Fixed target values, applied in order. Empty or omitted means observe only. */
  readonly intents?: readonly P1AgentIntent[];
  readonly clientName?: string;
  readonly clientVersion?: string;
  /** Submissions per intent across conflicts and uncertain outcomes. Default 3. */
  readonly maxAttempts?: number;
  /** Reconnect budget for the whole run and the fixed delay before each reconnect. Default 5 / 500 ms. */
  readonly reconnect?: { readonly attempts: number; readonly delayMs: number };
  /** Bound for each wait step (entity in view, publication confirmation). Default 10_000. */
  readonly timeoutMs?: number;
  /** Local fixture check (C34). Default true. */
  readonly assetCheck?: boolean;
  /** Also emit every frame as `wire.out` / `wire.in`. */
  readonly traceWire?: boolean;
  /** Event sink (the CLI writes JSON Lines). Must not throw; a throwing sink is ignored. */
  readonly onEvent?: (event: P1AgentEvent) => void;
  /** Test seams. */
  readonly socketFactory?: P1SocketFactory;
  readonly fetch?: P1FetchLike;
  readonly createId?: (prefix: string) => string;
  readonly delay?: (ms: number) => Promise<void>;
  readonly hooks?: {
    /** Runs after the entity was observed and the fencing values were captured, before the request is sent. */
    readonly beforeSubmit?: (context: { readonly intent: number; readonly attempt: number; readonly entity: P1SharedEntity }) => void | Promise<void>;
    /** Runs before each reconnect attempt, after the previous session closed. */
    readonly beforeReconnect?: (context: { readonly session: number; readonly lastClose: { readonly code: number; readonly reason: string } | null }) => void | Promise<void>;
  };
}

export interface P1AgentResult {
  readonly outcome: P1AgentOutcome;
  readonly exitCode: number;
  readonly events: readonly P1AgentEvent[];
  readonly finalEntity: P1EntityDescription | null;
}

class Fail extends Error {
  readonly outcome: P1AgentOutcome;
  constructor(outcome: P1AgentOutcome, message: string) {
    super(message);
    this.outcome = outcome;
  }
}

const defaultDelay = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

type Resolution = "committed" | "already-satisfied" | "satisfied-after-uncertain" | "satisfied-after-conflict";

/**
 * The deterministic P1 reference agent: a fixed step script, not an AI. No inference, no memory between runs,
 * no goal loops. Every loop is bounded by `maxAttempts`, the reconnect budget, or a timeout.
 *
 * C12: a request whose outcome is uncertain is never re-sent. The agent reconnects, takes a fresh snapshot,
 * re-subscribes explicitly, compares the canonical state with the frozen target, and only if the target is still
 * unmet sends a NEW request ID fenced by the current revision.
 */
export async function runAgent(options: P1AgentOptions): Promise<P1AgentResult> {
  const events: P1AgentEvent[] = [];
  let ordinal = 0;
  const emit = (event: string, fields: Record<string, unknown> = {}): void => {
    const record: P1AgentEvent = { n: ++ordinal, event, ...fields };
    events.push(record);
    try { options.onEvent?.(record); } catch { /* the sink must not affect the run */ }
  };

  const entityId = options.entityId;
  const intents = options.intents ?? [];
  const maxAttempts = options.maxAttempts ?? 3;
  const reconnect = options.reconnect ?? { attempts: 5, delayMs: 500 };
  const timeoutMs = options.timeoutMs ?? 10_000;
  const delay = options.delay ?? defaultDelay;

  let session = 0;
  let outboundCount = 0;
  let lastOutbound: unknown = null;
  let violation: string | null = null;
  let lastClose: { code: number; reason: string } | null = null;
  let finalEntity: P1EntityDescription | null = null;
  let assetChecked = false;
  let everAttempted = false;
  let reconnectsLeft = reconnect.attempts;

  const tapped = tapSocketFactory(options.socketFactory ?? platformSocketFactory, ({ direction, frame }) => {
    if (direction === "out") { outboundCount++; lastOutbound = frame; }
    if (options.traceWire === true) emit(direction === "out" ? "wire.out" : "wire.in", { session, frame });
  });
  const client = new P1Client({
    url: options.url,
    socketFactory: tapped,
    participantKind: "agent",
    clientName: options.clientName ?? "hvtp-agent-client",
    clientVersion: options.clientVersion ?? "0.1.0",
    subscription: {},
    ...(options.createId === undefined ? {} : { createId: options.createId }),
  });
  client.on((event) => {
    switch (event.type) {
      case "closed":
        lastClose = { code: event.code, reason: event.reason };
        emit("session.closed", { session, code: event.code, reason: event.reason, uncertainRequestIds: event.uncertainRequestIds });
        break;
      case "protocol.violation":
        violation = event.error.message;
        emit("protocol.violation", { message: event.error.message });
        break;
      case "host.error":
        emit("host.error", { code: event.body.code, message: event.body.message });
        break;
      default:
        break;
    }
  });

  const failIfViolation = (): void => {
    if (violation !== null) throw new Fail("protocol-violation", violation);
  };

  const observedEntity = (reason: string, entity: P1SharedEntity): void => {
    finalEntity = describeEntity(entity, client.assetBaseUri);
    emit("entity.observed", { session, reason, entity: finalEntity });
  };

  /** Ensures a LIVE session with the explicit subscription applied. Returns true when this was not the first connection. */
  async function establish(): Promise<boolean> {
    const reconnected = everAttempted;
    for (;;) {
      failIfViolation();
      if (everAttempted) {
        if (reconnectsLeft <= 0) throw new Fail("connection-failed", "reconnect budget exhausted");
        reconnectsLeft--;
        await options.hooks?.beforeReconnect?.({ session, lastClose });
        await delay(reconnect.delayMs);
      }
      everAttempted = true;
      session++;
      try {
        // Always join with the empty selector; the explicit subscription.set below is then part of every session.
        await client.connect({ subscription: {} });
      } catch (error) {
        failIfViolation();
        if (error instanceof P1RequestError) throw new Fail("connection-failed", `join rejected: ${error.code}`);
        if (error instanceof P1ConnectionError || error instanceof P1ClientStateError) continue;
        throw error;
      }
      const presence = client.presenceEntityId === null ? undefined : client.entities.get(client.presenceEntityId);
      emit("session.live", {
        session,
        participantId: client.participantId,
        participantKind: presence !== undefined && isPresenceEntity(presence) ? presence.components["hvtp.presence@1"].state.kind : null,
        realmEpoch: client.realmEpoch,
        assetBaseUri: client.assetBaseUri,
        presenceEntityId: client.presenceEntityId,
        subscriptionId: client.subscriptionId,
        snapshotEntityCount: client.entities.size,
      });
      try {
        const result = await client.setSubscription({ entities: [entityId] });
        emit("subscription.applied", {
          session,
          previousSubscriptionId: result.body.previousSubscriptionId,
          subscriptionId: result.body.subscriptionId,
          effectiveSubscription: result.body.effectiveSubscription,
          activated: result.activated,
        });
      } catch (error) {
        failIfViolation();
        if (error instanceof P1OutcomeUncertainError || error instanceof P1ClientStateError) continue;
        if (error instanceof P1RequestError) throw new Fail("rejected", `subscription.set rejected: ${error.code}`);
        throw error;
      }
      return reconnected;
    }
  }

  /**
   * Returns the target entity from a LIVE, explicitly subscribed session, reconnecting (bounded) when needed.
   * `reason` names the `entity.observed` event to emit; `null` emits none. A reconnect always reports
   * `after-reconnect`.
   */
  async function observe(reason: string | null): Promise<P1SharedEntity> {
    let effective = reason;
    for (;;) {
      failIfViolation();
      if (client.phase !== "live") {
        if (await establish()) effective = "after-reconnect";
      }
      const waited = await until(client, () => sharedEntity(client.entities, entityId) !== undefined, timeoutMs);
      if (waited === "ok") {
        const entity = sharedEntity(client.entities, entityId)!;
        if (effective !== null) observedEntity(effective, entity);
        return entity;
      }
      if (waited === "disconnected") { effective = "after-reconnect"; continue; }
      throw new Fail("entity-not-visible", `${entityId} did not enter the view within ${timeoutMs} ms of the explicit subscription`);
    }
  }

  async function applyIntent(index: number, intent: P1AgentIntent): Promise<void> {
    const component = intentComponent(intent);
    let attempts = 0;
    let uncertain = false;
    let conflict = false;
    let reason: string | null = null;
    for (;;) {
      const entity = await observe(reason);
      if (intentSatisfied(entity, intent)) {
        const resolution: Resolution = uncertain ? "satisfied-after-uncertain" : conflict ? "satisfied-after-conflict" : "already-satisfied";
        emit("intent.resolved", { intent: index, resolution, attempts });
        return;
      }
      if (attempts >= maxAttempts) throw new Fail("exhausted", `intent ${index} unresolved after ${attempts} submissions`);
      attempts++;
      const envelope = entity.components[component];
      const fence = { baseRevision: envelope.revision, authorityEpoch: envelope.authorityEpoch };
      await options.hooks?.beforeSubmit?.({ intent: index, attempt: attempts, entity });

      const sentBefore = outboundCount;
      const request: Promise<P1Ack> = intent.kind === "material"
        ? client.setComponent(entityId, component, { baseColor: intent.baseColor }, fence)
        : client.patchComponent(entityId, component, { position: intent.position }, fence);
      let requestId: string | null = null;
      if (outboundCount > sentBefore) {
        // The client sends synchronously, so the frame is already recorded.
        const frame = lastOutbound as { id: string; type: string; body: Record<string, unknown> };
        requestId = frame.id;
        emit("request.sent", {
          session, intent: index, attempt: attempts, requestId, type: frame.type, component,
          baseRevision: frame.body.baseRevision, authorityEpoch: frame.body.authorityEpoch,
          ...(frame.body.state !== undefined ? { state: frame.body.state } : { patch: frame.body.patch }),
        });
      }
      try {
        const ack = await request;
        emit("request.committed", { requestId: ack.ref, seq: ack.seq, revision: ack.revision ?? null, authorityEpoch: ack.authorityEpoch ?? null });
        if (ack.revision !== undefined) {
          const target = ack.revision;
          const confirmed = await until(client, () => (sharedEntity(client.entities, entityId)?.components[component].revision ?? 0) >= target, timeoutMs);
          const current = confirmed === "ok" ? sharedEntity(client.entities, entityId) : undefined;
          if (current !== undefined) observedEntity("after-ack", current);
        }
        emit("intent.resolved", { intent: index, resolution: "committed" satisfies Resolution, attempts });
        return;
      } catch (error) {
        if (error instanceof P1RequestError) {
          emit("request.rejected", {
            requestId: error.ref, code: error.code,
            currentRevision: error.body.currentRevision ?? null, authorityEpoch: error.body.authorityEpoch ?? null,
          });
          if (error.code === "revision_mismatch" || error.code === "authority_epoch_mismatch") {
            conflict = true;
            reason = "after-conflict";
            if (error.code === "revision_mismatch") {
              const wanted = Math.max(error.body.currentRevision ?? 0, envelope.revision + 1);
              await until(client, () => (sharedEntity(client.entities, entityId)?.components[component].revision ?? 0) >= wanted, timeoutMs);
            }
            continue;
          }
          throw new Fail("rejected", `${error.code}: ${error.message}`);
        }
        if (error instanceof P1OutcomeUncertainError) {
          // C12: never re-send. The next observe() reconnects and reads a fresh snapshot.
          emit("request.uncertain", { requestId: error.requestId, requestType: error.requestType });
          uncertain = true;
          reason = "after-reconnect";
          continue;
        }
        if (error instanceof P1ClientStateError) {
          // Nothing was sent (the session ended between observation and submission).
          reason = "after-reconnect";
          continue;
        }
        throw error;
      }
    }
  }

  let outcome: P1AgentOutcome = "internal-error";
  let message: string | undefined;
  try {
    emit("agent.start", { url: options.url, entityId, intents });
    const first = await observe("subscribed");
    if (options.assetCheck !== false && !assetChecked) {
      assetChecked = true;
      const result = await checkAsset(first.components["hvtp.renderable@1"].state, client.assetBaseUri!, client.limits!.maxAssetBytes, options.fetch);
      emit("asset.checked", result.ok ? { url: result.url, ok: true, bytes: result.bytes } : { url: result.url, ok: false, reason: result.reason });
    }
    for (const [index, intent] of intents.entries()) await applyIntent(index, intent);
    outcome = intents.length === 0 ? "observed" : "satisfied";
  } catch (error) {
    if (error instanceof Fail) {
      outcome = error.outcome;
      message = error.message;
    } else {
      outcome = "internal-error";
      message = error instanceof Error ? error.message : String(error);
    }
  } finally {
    client.disconnect();
  }
  const exitCode = OUTCOME_EXIT_CODE[outcome];
  emit("result", { outcome, exitCode, ...(message === undefined ? {} : { message }) });
  return { outcome, exitCode, events, finalEntity };
}
