import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Mesh, MeshStandardMaterial, Object3D } from "three";
import {
  P1Client, platformSocketFactory, type P1ClientEvent, type P1Socket, type P1SocketFactory,
} from "@hvtp/client-core";
import type { P1SharedEntity, SubscriptionSelector } from "@hvtp/protocol-types";
import { createReferenceHost, type ReferenceHost, type ReferenceHostOptions } from "@hvtp/reference-host";
import { P1ThreeView } from "@hvtp/three-client";

// GLTFLoader's FileLoader (used for the fixture's embedded data: buffer) emits the browser-only ProgressEvent.
// Node lacks that global; browsers provide it natively. Test-environment shim only (same as the three-client tests).
(globalThis as { ProgressEvent?: unknown }).ProgressEvent ??= class ProgressEvent extends Event {
  constructor(type: string, init: Record<string, unknown> = {}) { super(type); Object.assign(this, init); }
};

export const TRANSFORM = "hvtp.transform@1";
export const MATERIAL = "hvtp.material@1";
export const SPATIAL: SubscriptionSelector = { spatial: { center: [0, 0, 0], radius: 100 } };
export const wsUrl = (host: ReferenceHost): string => `ws://${host.host}:${host.port}/hvtp`;

type Frame = Record<string, any>;

// ---------------------------------------------------------------------------------------------------------------
// Host lifecycle
// ---------------------------------------------------------------------------------------------------------------

export function tempDatabase(): { path: string; remove(): void } {
  const dir = mkdtempSync(join(tmpdir(), "hvtp-accept-"));
  return { path: join(dir, "world.sqlite"), remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Restart on the same port. Immediately after `close()` the listening socket can still be reported busy on some
 * platforms, so the bind is retried a bounded number of times on EADDRINUSE and nothing else.
 */
export async function startHostOnPort(options: ReferenceHostOptions, port: number): Promise<ReferenceHost> {
  let last: unknown;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      return await createReferenceHost({ ...options, port });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw last;
}

export async function withHost(options: ReferenceHostOptions, run: (host: ReferenceHost) => Promise<void>): Promise<void> {
  const host = await createReferenceHost({ databasePath: ":memory:", ...options });
  try {
    await run(host);
  } finally {
    await host.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Waiting (event driven; the only timer is the failure-path bound)
// ---------------------------------------------------------------------------------------------------------------

/** Resolves once `predicate` holds, re-checking after every client event. */
export function waitFor(client: P1Client, predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error(`Timed out waiting for ${label}`)); }, timeoutMs);
    const off = client.on(() => {
      if (!predicate()) return;
      clearTimeout(timer);
      off();
      resolve();
    });
  });
}

/** Rejects with `label` if `promise` does not settle within `timeoutMs`. */
export function bounded<T>(promise: Promise<T>, label: string, timeoutMs = 10_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Simulated browsers: P1Client + P1ThreeView in Node with the real WebSocket and fetch
// ---------------------------------------------------------------------------------------------------------------

export interface Browser {
  readonly name: string;
  readonly client: P1Client;
  readonly view: P1ThreeView;
  /** Every P1Client event, in order. This is the only input the Three view has. */
  readonly events: P1ClientEvent[];
  /** Every frame this browser sent, across sessions. */
  readonly sent: Frame[];
  /** Every URL this browser requested over HTTP (asset fetches). */
  readonly fetched: string[];
  readonly assetFailures: string[];
  /** Number of WebSockets opened (one per session). */
  readonly sessions: () => number;
}

export interface BrowserOptions {
  readonly subscription?: SubscriptionSelector;
  /** Wraps the platform socket (after frame recording) to intercept inbound frames. */
  readonly wrapSocket?: (socket: P1Socket) => P1Socket;
}

export function makeBrowser(url: string, name: string, options: BrowserOptions = {}): Browser {
  const sent: Frame[] = [];
  const fetched: string[] = [];
  const assetFailures: string[] = [];
  let sockets = 0;
  const socketFactory: P1SocketFactory = (target) => {
    sockets++;
    const inner = platformSocketFactory(target);
    const recording: P1Socket = {
      send: (data) => { sent.push(JSON.parse(data) as Frame); inner.send(data); },
      close: (code, reason) => inner.close(code, reason),
      get onopen() { return inner.onopen; }, set onopen(handler) { inner.onopen = handler; },
      get onmessage() { return inner.onmessage; }, set onmessage(handler) { inner.onmessage = handler; },
      get onclose() { return inner.onclose; }, set onclose(handler) { inner.onclose = handler; },
      get onerror() { return inner.onerror; }, set onerror(handler) { inner.onerror = handler; },
    };
    return options.wrapSocket?.(recording) ?? recording;
  };
  const client = new P1Client({
    url, socketFactory, clientName: name, ...(options.subscription === undefined ? {} : { subscription: options.subscription }),
  });
  const view = new P1ThreeView({
    // The platform fetch, observed: the asset endpoint must be the browser's only HTTP traffic. Node's fetch pools
    // keep-alive sockets per origin; after a host restart on the same port the next WebSocket handshake can be
    // written to a pooled socket the old host already closed (a Node-only artifact; browsers retry transparently).
    // `connection: close` keeps asset sockets out of the pool so a same-port restart is deterministic.
    fetch: (target, init) => { fetched.push(target); return fetch(target, { ...init, headers: { connection: "close" } }); },
    onAssetFailure: (_id, reason) => assetFailures.push(reason),
  });
  const events: P1ClientEvent[] = [];
  // The view attaches before any test waiter, so it has applied an event before a waiter looks at the scene.
  view.attach(client);
  client.on((event) => events.push(event));
  return { name, client, view, events, sent, fetched, assetFailures, sessions: () => sockets };
}

export const shared = (client: P1Client, id: string): P1SharedEntity | undefined => client.entities.get(id) as P1SharedEntity | undefined;

export const disconnected = (browser: Browser, label = `${browser.name} disconnected`): Promise<void> =>
  waitFor(browser.client, () => browser.client.phase === "disconnected", label);

// ---------------------------------------------------------------------------------------------------------------
// Three scene inspection (read only)
// ---------------------------------------------------------------------------------------------------------------

export function meshOf(object: Object3D): Mesh {
  let found: Mesh | undefined;
  object.traverse((child) => { if (found === undefined && (child as Mesh).isMesh) found = child as Mesh; });
  if (found === undefined) throw new Error("no mesh under the entity root");
  return found;
}

export const materialOf = (browser: Browser, id: string): MeshStandardMaterial =>
  meshOf(browser.view.object(id)!).material as MeshStandardMaterial;

export const colorOf = (browser: Browser, id: string): number[] => {
  const material = materialOf(browser, id);
  return [material.color.r, material.color.g, material.color.b, material.opacity];
};

export const positionOf = (browser: Browser, id: string): number[] => browser.view.object(id)!.position.toArray();

// ---------------------------------------------------------------------------------------------------------------
// Headless agent as a separate OS process (it can only use the wire)
// ---------------------------------------------------------------------------------------------------------------

export const AGENT_BIN = createRequire(import.meta.url).resolve("@hvtp/agent-client/bin");

export interface CliRun { pid: number; code: number | null; stdout: string; stderr: string; events: Array<Record<string, any>> }

export function runAgentCli(args: string[], timeoutMs = 30_000): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [AGENT_BIN, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`agent CLI timed out\n${stdout}\n${stderr}`)); }, timeoutMs);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      const events = stdout.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Record<string, any>);
      resolve({ pid: child.pid!, code, stdout, stderr, events });
    });
  });
}
