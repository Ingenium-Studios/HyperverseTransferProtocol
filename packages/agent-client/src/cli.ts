import { parseAgentArgs, USAGE } from "./args.js";
import { AGENT_EXIT_CODES, serializeEvent } from "./events.js";
import { runAgent, type P1AgentOptions } from "./run.js";

export interface CliIo {
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
}

/**
 * CLI entry without side effects: parses `argv`, runs the agent, writes JSON Lines to stdout (human text only
 * on stderr) and returns the exit code. `overrides` are test seams merged into the run options.
 */
export async function main(argv: readonly string[], io: CliIo, overrides: Partial<P1AgentOptions> = {}): Promise<number> {
  const parsed = parseAgentArgs(argv);
  if (parsed.kind === "help") {
    io.stderr.write(USAGE);
    return AGENT_EXIT_CODES.ok;
  }
  if (parsed.kind === "error") {
    io.stderr.write(`hvtp-agent: ${parsed.message}\n\n${USAGE}`);
    return AGENT_EXIT_CODES.usage;
  }
  const { args } = parsed;
  try {
    const result = await runAgent({
      url: args.url,
      entityId: args.entityId,
      intents: args.intents,
      assetCheck: args.assetCheck,
      traceWire: args.traceWire,
      ...(args.maxAttempts === undefined ? {} : { maxAttempts: args.maxAttempts }),
      ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
      ...(args.clientName === undefined ? {} : { clientName: args.clientName }),
      ...(args.reconnectAttempts === undefined && args.reconnectDelayMs === undefined ? {} : {
        reconnect: { attempts: args.reconnectAttempts ?? 5, delayMs: args.reconnectDelayMs ?? 500 },
      }),
      ...overrides,
      onEvent: (event) => { io.stdout.write(`${serializeEvent(event)}\n`); },
    });
    return result.exitCode;
  } catch (error) {
    io.stderr.write(`hvtp-agent: internal error: ${error instanceof Error ? error.message : String(error)}\n`);
    return AGENT_EXIT_CODES.internalError;
  }
}
