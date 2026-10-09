/** Fixed process exit codes of `hvtp-agent` and `runAgent`. */
export const AGENT_EXIT_CODES = {
  ok: 0,
  internalError: 1,
  usage: 2,
  entityNotVisible: 3,
  rejected: 4,
  exhausted: 5,
  connectionFailed: 6,
  protocolViolation: 7,
} as const;

export type P1AgentOutcome =
  | "satisfied" | "observed" | "entity-not-visible" | "rejected" | "exhausted"
  | "connection-failed" | "protocol-violation" | "internal-error";

export const OUTCOME_EXIT_CODE: Readonly<Record<P1AgentOutcome, number>> = {
  satisfied: AGENT_EXIT_CODES.ok,
  observed: AGENT_EXIT_CODES.ok,
  "internal-error": AGENT_EXIT_CODES.internalError,
  "entity-not-visible": AGENT_EXIT_CODES.entityNotVisible,
  rejected: AGENT_EXIT_CODES.rejected,
  exhausted: AGENT_EXIT_CODES.exhausted,
  "connection-failed": AGENT_EXIT_CODES.connectionFailed,
  "protocol-violation": AGENT_EXIT_CODES.protocolViolation,
};

/** One JSON Lines record: `n` is the 1-based ordinal, `event` the name; the remaining keys are event-specific. */
export interface P1AgentEvent {
  readonly n: number;
  readonly event: string;
  readonly [key: string]: unknown;
}

/** Serializes one event as a single JSON line (no trailing newline). Key order is construction order. */
export function serializeEvent(event: P1AgentEvent): string {
  return JSON.stringify(event);
}
