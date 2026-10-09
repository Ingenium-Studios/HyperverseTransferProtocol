import { parseArgs } from "node:util";
import type { P1AgentIntent } from "./entity-state.js";

export const DEFAULT_URL = "ws://127.0.0.1:8787/hvtp";

export interface ParsedAgentArgs {
  readonly url: string;
  readonly entityId: string;
  readonly intents: readonly P1AgentIntent[];
  readonly maxAttempts?: number;
  readonly reconnectAttempts?: number;
  readonly reconnectDelayMs?: number;
  readonly timeoutMs?: number;
  readonly assetCheck: boolean;
  readonly traceWire: boolean;
  readonly clientName?: string;
}

export type AgentArgsResult =
  | { readonly kind: "run"; readonly args: ParsedAgentArgs }
  | { readonly kind: "help" }
  | { readonly kind: "error"; readonly message: string };

export const USAGE = `Usage: hvtp-agent --entity <id> [options]

  --url <ws-url>               Host WebSocket endpoint (default ${DEFAULT_URL})
  --entity <id>                Shared entity to subscribe to explicitly (required)
  --color r,g,b,a              Target hvtp.material@1 baseColor, linear values in [0,1]
  --position=x,y,z             Target hvtp.transform@1 position (use "=" for negative values)
  --max-attempts <n>           Submissions per intent across conflicts and uncertainty (default 3)
  --reconnect-attempts <n>     Reconnect budget for the whole run (default 5)
  --reconnect-delay-ms <n>     Fixed delay before each reconnect (default 500)
  --timeout-ms <n>             Bound for each wait step (default 10000)
  --no-asset-check             Skip the local fixture fetch and inspection
  --trace-wire                 Also emit every frame as wire.out / wire.in
  --client-name <s>            session.hello client name (default hvtp-agent-client)
  --help                       Print this text

Without --color and --position the agent only observes. Output is JSON Lines on stdout.
Exit codes: 0 ok, 1 internal, 2 usage, 3 entity not visible, 4 rejected, 5 exhausted, 6 connection, 7 protocol violation.
`;

class UsageError extends Error {}

function numberList(name: string, text: string, length: number): number[] {
  const parts = text.split(",");
  if (parts.length !== length) throw new UsageError(`--${name} needs exactly ${length} comma-separated numbers.`);
  return parts.map((part) => {
    const value = part.trim() === "" ? Number.NaN : Number(part);
    if (!Number.isFinite(value)) throw new UsageError(`--${name} contains a value that is not a finite number: '${part}'.`);
    return value;
  });
}

function integer(name: string, text: string, min: number, max: number): number {
  const value = text.trim() === "" ? Number.NaN : Number(text);
  if (!Number.isInteger(value) || value < min || value > max) throw new UsageError(`--${name} must be an integer in [${min}, ${max}].`);
  return value;
}

/** Pure, strict argument parser. Local validation is a UX check only; the host remains authoritative. */
export function parseAgentArgs(argv: readonly string[]): AgentArgsResult {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: true,
      options: {
        url: { type: "string" },
        entity: { type: "string" },
        color: { type: "string" },
        position: { type: "string" },
        "max-attempts": { type: "string" },
        "reconnect-attempts": { type: "string" },
        "reconnect-delay-ms": { type: "string" },
        "timeout-ms": { type: "string" },
        "no-asset-check": { type: "boolean" },
        "trace-wire": { type: "boolean" },
        "client-name": { type: "string" },
        help: { type: "boolean" },
      },
    });
    if (values.help === true) return { kind: "help" };
    if (positionals.length > 0) throw new UsageError(`Unexpected argument '${positionals[0]}'. Negative values need --position=x,y,z.`);
    const entityId = values.entity;
    if (entityId === undefined || entityId === "") throw new UsageError("--entity is required.");
    if (new TextEncoder().encode(entityId).byteLength > 128) throw new UsageError("--entity must be at most 128 bytes.");
    const url = values.url ?? DEFAULT_URL;
    let parsedUrl: URL;
    try { parsedUrl = new URL(url); } catch { throw new UsageError("--url is not a valid URL."); }
    if (parsedUrl.protocol !== "ws:" && parsedUrl.protocol !== "wss:") throw new UsageError("--url must be a ws: or wss: URL.");

    const intents: P1AgentIntent[] = [];
    if (values.color !== undefined) {
      const color = numberList("color", values.color, 4);
      if (color.some((value) => value < 0 || value > 1)) throw new UsageError("--color components must be in [0,1].");
      intents.push({ kind: "material", baseColor: color as unknown as [number, number, number, number] });
    }
    if (values.position !== undefined) {
      const position = numberList("position", values.position, 3);
      if (position.some((value) => Math.abs(value) > 1e6)) throw new UsageError("--position components must be within +/-1e6.");
      intents.push({ kind: "position", position: position as unknown as [number, number, number] });
    }
    return {
      kind: "run",
      args: {
        url, entityId, intents,
        ...(values["max-attempts"] === undefined ? {} : { maxAttempts: integer("max-attempts", values["max-attempts"], 1, 100) }),
        ...(values["reconnect-attempts"] === undefined ? {} : { reconnectAttempts: integer("reconnect-attempts", values["reconnect-attempts"], 0, 100) }),
        ...(values["reconnect-delay-ms"] === undefined ? {} : { reconnectDelayMs: integer("reconnect-delay-ms", values["reconnect-delay-ms"], 0, 60_000) }),
        ...(values["timeout-ms"] === undefined ? {} : { timeoutMs: integer("timeout-ms", values["timeout-ms"], 1, 600_000) }),
        assetCheck: values["no-asset-check"] !== true,
        traceWire: values["trace-wire"] === true,
        ...(values["client-name"] === undefined ? {} : { clientName: values["client-name"] }),
      },
    };
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
}
