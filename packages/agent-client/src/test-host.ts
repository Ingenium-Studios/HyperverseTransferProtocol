import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { P1Client, platformSocketFactory, type P1Socket, type P1SocketFactory } from "@hvtp/client-core";
import type { P1SharedEntity } from "@hvtp/protocol-types";
import { createReferenceHost, type ReferenceHost, type ReferenceHostOptions } from "@hvtp/reference-host";

export const ID = "entity:agent-cube";
export const MATERIAL = "hvtp.material@1";
export const TRANSFORM = "hvtp.transform@1";

type Frame = Record<string, any>;

export interface RecordedSocket { readonly frames: Frame[] }

export interface RecordingOptions {
  /** Return true to swallow an outbound frame and close the socket with 4000 (the request never reaches the host). */
  readonly swallow?: (frame: Frame) => boolean;
}

/** Wraps the platform WebSocket: records every outbound frame per socket (= per session) and can drop one. */
export function recordingFactory(options: RecordingOptions = {}): { factory: P1SocketFactory; sockets: RecordedSocket[] } {
  const sockets: RecordedSocket[] = [];
  const factory: P1SocketFactory = (url) => {
    const inner = platformSocketFactory(url);
    const record: RecordedSocket = { frames: [] };
    sockets.push(record);
    const wrapped: P1Socket = {
      send: (data) => {
        const frame = JSON.parse(data) as Frame;
        record.frames.push(frame);
        if (options.swallow?.(frame) === true) { inner.close(4000, "injected request loss"); return; }
        inner.send(data);
      },
      close: (code, reason) => inner.close(code, reason),
      get onopen() { return inner.onopen; }, set onopen(handler) { inner.onopen = handler; },
      get onmessage() { return inner.onmessage; }, set onmessage(handler) { inner.onmessage = handler; },
      get onclose() { return inner.onclose; }, set onclose(handler) { inner.onclose = handler; },
      get onerror() { return inner.onerror; }, set onerror(handler) { inner.onerror = handler; },
    };
    return wrapped;
  };
  return { factory, sockets };
}

export const wsUrl = (host: ReferenceHost): string => `ws://${host.host}:${host.port}/hvtp`;

/** Resolves once `predicate` holds, re-checking after every client event. */
export function until(client: P1Client, predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
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

export const shared = (client: P1Client, id: string) => client.entities.get(id) as P1SharedEntity | undefined;

export interface Observer {
  readonly client: P1Client;
  /** Number of `component.updated` publications this observer has received. */
  readonly updates: () => number;
}

/** A human client that watches the origin area, creates the cube, and counts the updates it sees. */
export async function seedObserver(host: ReferenceHost, id = ID): Promise<Observer> {
  const client = new P1Client({
    url: wsUrl(host), subscription: { spatial: { center: [0, 0, 0], radius: 100 } }, clientName: "agent-test-observer",
  });
  let updated = 0;
  client.on((event) => { if (event.type === "entity.upsert" && event.cause === "updated") updated++; });
  await client.connect();
  await client.createEntity({
    id,
    transform: { position: [0, 0.5, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    material: { baseColor: [1, 1, 1, 1] },
  });
  await until(client, () => client.entities.has(id), "observer sees the seeded cube");
  return { client, updates: () => updated };
}

export async function withHost(options: ReferenceHostOptions, run: (host: ReferenceHost) => Promise<void>): Promise<void> {
  const host = await createReferenceHost({ databasePath: ":memory:", ...options });
  try {
    await run(host);
  } finally {
    await host.close();
  }
}

export function tempDatabase(): { path: string; remove(): void } {
  const dir = mkdtempSync(join(tmpdir(), "hvtp-agent-"));
  return { path: join(dir, "world.sqlite"), remove: () => rmSync(dir, { recursive: true, force: true }) };
}
