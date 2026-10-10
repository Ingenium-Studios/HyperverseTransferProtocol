import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createReferenceHost } from "@hvtp/reference-host";
import { ID, MATERIAL, seedObserver, shared, TRANSFORM, until, withHost, wsUrl } from "./test-host.js";

const BIN = fileURLToPath(new URL("./bin.js", import.meta.url));

interface CliRun { code: number | null; stdout: string; stderr: string; events: Array<Record<string, any>> }

function runCli(args: string[]): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI timed out\n${stdout}\n${stderr}`)); }, 30_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      const events = stdout.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Record<string, any>);
      resolve({ code, stdout, stderr, events });
    });
  });
}

test("CLI: --color against a real host emits JSON Lines, exits 0, and the change is observed by a second client", async () => {
  await withHost({}, async (host) => {
    const observer = await seedObserver(host);
    try {
      const run = await runCli(["--url", wsUrl(host), "--entity", ID, "--color", "1,0,0,1"]);
      assert.equal(run.code, 0, run.stderr + run.stdout);
      assert.equal(run.stderr, "");
      assert.deepEqual(run.events.map((event) => event.event), [
        "agent.start", "session.live", "subscription.applied", "entity.observed", "asset.checked", "request.sent", "request.committed",
        "entity.observed", "intent.resolved", "session.closed", "result",
      ]);
      assert.deepEqual(run.events.map((event) => event.n), run.events.map((_, index) => index + 1));
      assert.equal(run.events[1]!.participantKind, "agent");
      assert.equal(run.events[5]!.baseRevision, 1);
      assert.deepEqual(run.events.at(-1), { n: run.events.length, event: "result", outcome: "satisfied", exitCode: 0 });
      await until(observer.client, () => shared(observer.client, ID)?.components[MATERIAL].revision === 2, "observer sees the CLI change");
      assert.deepEqual(shared(observer.client, ID)!.components[MATERIAL].state.baseColor, [1, 0, 0, 1]);
    } finally {
      observer.client.disconnect();
    }
  });
});

test("CLI: --position=-2,0.5,0 with --trace-wire exits 0 and traces an agent hello", async () => {
  await withHost({}, async (host) => {
    const observer = await seedObserver(host);
    try {
      const run = await runCli(["--url", wsUrl(host), "--entity", ID, "--position=-2,0.5,0", "--trace-wire"]);
      assert.equal(run.code, 0, run.stderr + run.stdout);
      const out = run.events.filter((event) => event.event === "wire.out").map((event) => event.frame);
      assert.equal(out[0].type, "session.hello");
      assert.equal(out[0].body.participant.kind, "agent");
      assert.deepEqual(out.map((frame) => frame.type), ["session.hello", "realm.join", "subscription.set", "component.patch"]);
      await until(observer.client, () => shared(observer.client, ID)?.components[TRANSFORM].revision === 2, "observer sees the CLI move");
      assert.deepEqual(shared(observer.client, ID)!.components[TRANSFORM].state.position, [-2, 0.5, 0]);
    } finally {
      observer.client.disconnect();
    }
  });
});

test("CLI: observe-only on an existing entity exits 0 without any mutation", async () => {
  await withHost({}, async (host) => {
    const observer = await seedObserver(host);
    try {
      const run = await runCli(["--url", wsUrl(host), "--entity", ID, "--no-asset-check"]);
      assert.equal(run.code, 0);
      assert.equal(run.events.some((event) => event.event === "request.sent" || event.event === "asset.checked"), false);
      assert.equal(run.events.at(-1)!.outcome, "observed");
      assert.equal(shared(observer.client, ID)!.components[MATERIAL].revision, 1);
    } finally {
      observer.client.disconnect();
    }
  });
});

test("CLI: bad arguments exit 2 with empty stdout and usage on stderr", async () => {
  for (const args of [[], ["--entity", ID, "--color", "2,0,0,1"], ["--entity", ID, "--position", "-2,0,0"], ["--entity", ID, "--nope"]]) {
    const run = await runCli(args);
    assert.equal(run.code, 2, `${args}`);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /Usage: hvtp-agent/);
  }
});

test("CLI: --help prints usage on stderr and exits 0", async () => {
  const run = await runCli(["--help"]);
  assert.equal(run.code, 0);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /Exit codes:/);
});

test("CLI: an entity that never becomes visible exits 3", async () => {
  await withHost({}, async (host) => {
    const run = await runCli(["--url", wsUrl(host), "--entity", "entity:missing", "--timeout-ms", "300"]);
    assert.equal(run.code, 3);
    assert.deepEqual(run.events.at(-1), { n: run.events.length, event: "result", outcome: "entity-not-visible", exitCode: 3, message: run.events.at(-1)!.message });
  });
});

test("CLI: an unreachable host exits 6 within the reconnect budget", async () => {
  const host = await createReferenceHost({ databasePath: ":memory:" });
  const url = wsUrl(host);
  await host.close();
  const run = await runCli(["--url", url, "--entity", ID, "--reconnect-attempts", "1", "--reconnect-delay-ms", "10"]);
  assert.equal(run.code, 6);
  assert.equal(run.events.at(-1)!.outcome, "connection-failed");
});
