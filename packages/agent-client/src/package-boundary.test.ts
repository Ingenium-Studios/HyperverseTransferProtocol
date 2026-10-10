import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const distDir = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(join(distDir, "..", "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;

test("U14: the agent package has no renderer, bundler or WebSocket-library dependency in any field", () => {
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const names = Object.keys(packageJson[field] ?? {});
    for (const forbidden of ["three", "@hvtp/three-client", "vite", "ws", "@types/three"]) assert.ok(!names.includes(forbidden), `${field} has ${forbidden}`);
  }
  assert.deepEqual(Object.keys(packageJson.dependencies ?? {}).sort(), ["@hvtp/client-core", "@hvtp/protocol-types"]);
});

test("U14: no compiled production module imports three or the three client", () => {
  const files = readdirSync(distDir).filter((name) => name.endsWith(".js") && !name.endsWith(".test.js") && !name.startsWith("test-"));
  assert.ok(files.length > 5);
  for (const file of files) {
    const source = readFileSync(join(distDir, file), "utf8");
    assert.doesNotMatch(source, /from\s+["'](three|@hvtp\/three-client|ws)(\/[^"']*)?["']/, file);
  }
});
