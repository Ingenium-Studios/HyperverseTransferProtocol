import assert from "node:assert/strict";
import test from "node:test";
import { parseAgentArgs } from "./index.js";

const run = (...argv: string[]) => {
  const result = parseAgentArgs(argv);
  assert.equal(result.kind, "run", JSON.stringify(result));
  return (result as Extract<typeof result, { kind: "run" }>).args;
};
const error = (...argv: string[]) => {
  const result = parseAgentArgs(argv);
  assert.equal(result.kind, "error", JSON.stringify(result));
  return (result as Extract<typeof result, { kind: "error" }>).message;
};

test("U13: defaults, color and position intents in order, and every option", () => {
  const defaults = run("--entity", "entity:a");
  assert.deepEqual([defaults.url, defaults.intents, defaults.assetCheck, defaults.traceWire], ["ws://127.0.0.1:8787/hvtp", [], true, false]);
  const full = run("--url", "wss://host/hvtp", "--entity", "entity:a", "--color", "1,0,0,1", "--position=-2,0.5,0", "--max-attempts", "2",
    "--reconnect-attempts", "1", "--reconnect-delay-ms", "0", "--timeout-ms", "50", "--no-asset-check", "--trace-wire", "--client-name", "x");
  assert.deepEqual(full.intents, [{ kind: "material", baseColor: [1, 0, 0, 1] }, { kind: "position", position: [-2, 0.5, 0] }]);
  assert.deepEqual([full.url, full.maxAttempts, full.reconnectAttempts, full.reconnectDelayMs, full.timeoutMs, full.assetCheck, full.traceWire, full.clientName],
    ["wss://host/hvtp", 2, 1, 0, 50, false, true, "x"]);
});

test("U13: --help, a missing entity, and ambiguous negative values are usage errors", () => {
  assert.equal(parseAgentArgs(["--help"]).kind, "help");
  assert.match(error(), /--entity is required/);
  error("--entity", "entity:a", "--position", "-2,0.5,0");
});

test("U13: out-of-range or malformed values are usage errors", () => {
  const base = ["--entity", "entity:a"];
  for (const bad of [
    ["--color", "1,0,0"], ["--color", "1,0,0,2"], ["--color", "1,0,0,NaN"], ["--color", "1,,0,1"],
    ["--position=1,2"], ["--position=1,2,1e7"], ["--position=1,2,x"],
    ["--max-attempts", "0"], ["--max-attempts", "1.5"], ["--timeout-ms", "0"], ["--reconnect-attempts", "-1"],
    ["--url", "http://127.0.0.1:8787/hvtp"], ["--url", "not a url"], ["--bogus"], ["stray"],
  ]) error(...base, ...bad);
  error("--entity", "x".repeat(129));
});
