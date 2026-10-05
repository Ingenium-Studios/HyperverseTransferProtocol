import { randomUUID } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { P1_LIMITS, type SessionServerMessage } from "@hvtp/protocol-types";
import { P1Session } from "./session.js";
import { P1OutboundChannel } from "./outbound.js";
import { originForBindHost, validateAssetOrigin } from "./origin.js";
import type { MonotonicClock } from "./rate-limiter.js";
import { P1WorldStore } from "./world-store.js";
import type { P1WorldStoreOptions } from "./world-store.js";
import { P1RealmCoordinator, type P1RealmCoordinatorOptions } from "./realm-coordinator.js";

export interface ReferenceHostOptions {
  readonly host?: string;
  readonly port?: number;
  readonly publicOrigin?: string;
  readonly fixturePath?: string;
  readonly databasePath?: string;
  readonly worldStoreOptions?: P1WorldStoreOptions;
  readonly realmCoordinatorOptions?: P1RealmCoordinatorOptions;
  /** Monotonic clock for per-connection request-rate limiters; defaults to `performance.now`. */
  readonly clock?: MonotonicClock;
  /** Test seam: replaces the WebSocket write so completion can be delayed or failed deterministically. */
  readonly sendTransport?: (socket: WebSocket, data: string, done: (error?: Error | null) => void) => void;
  /** Test seam: observes each accepted connection and its outbound channel. */
  readonly onConnection?: (connection: ReferenceConnection) => void;
  /** Test seam after durable commit/publication admission but before requester response. */
  readonly afterDurableCommit?: () => void;
}

export interface ReferenceConnection {
  readonly socket: WebSocket;
  readonly session: P1Session;
  readonly channel: P1OutboundChannel;
}

export interface ReferenceHost {
  readonly server: Server;
  readonly wsServer: WebSocketServer;
  readonly host: string;
  readonly port: number;
  readonly realmEpoch: string;
  readonly worldStore: P1WorldStore;
  readonly realmCoordinator: P1RealmCoordinator;
  close(): Promise<void>;
}

export async function createReferenceHost(options: ReferenceHostOptions = {}): Promise<ReferenceHost> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 0;
  const defaultFixture = resolve(dirname(fileURLToPath(import.meta.url)), "../../../protocol-spec/fixtures/unit-cube.gltf");
  const fixturePath = options.fixturePath ?? defaultFixture;
  // HTTPS is required outside loopback/local development; reject before binding or opening the store.
  validateAssetOrigin(options.publicOrigin ?? originForBindHost(host));
  const databasePath =
    options.databasePath ??
    process.env.HVTP_DB_PATH ??
    resolve(process.cwd(), "data", "p1.sqlite");
  const worldStore = new P1WorldStore(databasePath, options.worldStoreOptions);

  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/assets/p1/unit-cube.gltf") {
      let stat;
      try {
        stat = statSync(fixturePath);
      } catch {
        res.writeHead(404).end();
        return;
      }
      if (stat.size > P1_LIMITS.maxAssetBytes) {
        res.writeHead(413).end();
        return;
      }
      // Commit headers only once the file is open; any open/read failure must never surface as an
      // unhandled 'error' event.
      const stream = createReadStream(fixturePath);
      res.once("close", () => stream.destroy());
      stream.on("error", () => {
        if (!res.headersSent) res.writeHead(404).end();
        else res.destroy();
      });
      stream.once("open", () => {
        // The public conformance fixture is credential-free; a wildcard origin lets a browser client served from
        // another (dev-server) origin read it. Delivery detail only, not protocol semantics.
        res.writeHead(200, {
          "access-control-allow-origin": "*",
          "content-type": "model/gltf+json",
          "content-length": stat.size,
          "cache-control": "no-store",
        });
        stream.pipe(res);
      });
      return;
    }
    res.writeHead(404).end();
  });

  const wsServer = new WebSocketServer({ server, path: "/hvtp", maxPayload: P1_LIMITS.maxMessageBytes });

  await new Promise<void>((resolveListen, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(requestedPort, host, () => {
      server.off("error", onError);
      resolveListen();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Reference host did not bind a TCP port.");
  const port = address.port;
  const origin = options.publicOrigin ?? originForBindHost(host, port);
  const assetBaseUri = new URL("/assets/p1/", origin).toString();
  const realmEpoch = `epoch:${randomUUID()}`;
  const realmCoordinator = new P1RealmCoordinator(realmEpoch, options.realmCoordinatorOptions);

  wsServer.on("connection", (socket) => {
    const send = options.sendTransport ?? ((target, data, done) => target.send(data, (error) => done(error)));
    const closeConnection = (code: number, reason: string): void => {
      session.close();
      channel.dispose();
      socket.close(code, reason);
    };
    const channel = new P1OutboundChannel(
      { isOpen: () => socket.readyState === WebSocket.OPEN, send: (data, done) => send(socket, data, done) },
      () => closeConnection(1011, "failed to send P1 output"),
    );
    const session = new P1Session(assetBaseUri, realmEpoch, worldStore, {
      realmCoordinator,
      outbound: channel,
      closeTransport: closeConnection,
      ...(options.clock === undefined ? {} : { now: options.clock }),
      ...(options.afterDurableCommit === undefined ? {} : { afterDurableCommit: options.afterDurableCommit }),
    });
    bindSocket(socket, session, channel, closeConnection);
    options.onConnection?.({ socket, session, channel });
  });

  return {
    server,
    wsServer,
    host,
    port,
    realmEpoch,
    worldStore,
    realmCoordinator,
    async close(): Promise<void> {
      for (const client of wsServer.clients) client.close(1001, "host shutdown");
      await new Promise<void>((resolveClose) => wsServer.close(() => resolveClose()));
      await new Promise<void>((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
      worldStore.close();
    },
  };
}

function bindSocket(
  socket: WebSocket,
  session: P1Session,
  channel: P1OutboundChannel,
  closeConnection: (code: number, reason: string) => void,
): void {
  const decoder = new TextDecoder("utf-8", { fatal: true });

  // Direct responses compete with coordinator output for the same per-connection byte budget. The exact
  // computed response is sent or the connection is closed; a substitute response is never sent, because the
  // session state machine and request-ID terminal cache already reflect the original response.
  const sendDirect = (message: SessionServerMessage): boolean => {
    if (channel.trySend(message)) return true;
    closeConnection(1011, "P1 outbound buffer limit reached; reconnect for a fresh snapshot");
    return false;
  };

  socket.on("message", (data: RawData, isBinary: boolean) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (isBinary) {
      closeConnection(1003, "P1 requires JSON text messages");
      return;
    }

    const bytes = rawDataBytes(data);
    if (bytes.byteLength > P1_LIMITS.maxMessageBytes) {
      closeConnection(1009, "message exceeds P1 maxMessageBytes");
      return;
    }

    let text: string;
    try {
      text = decoder.decode(bytes);
    } catch {
      closeConnection(1007, "invalid UTF-8 text message");
      return;
    }

    let dispatch;
    try {
      dispatch = session.handleText(text);
    } catch {
      closeConnection(1011, "P1 world-state failure");
      return;
    }

    try {
      for (const message of dispatch.messages) if (!sendDirect(message)) return;
      dispatch.afterEnqueue?.();
    } catch {
      closeConnection(1011, "failed to enqueue P1 response");
    }
  });

  // ws closes the connection itself (1009 oversize, 1007 invalid UTF-8) and then emits 'error'; an unhandled
  // 'error' event would crash the host process, so release connection state and swallow it.
  socket.on("error", () => {
    session.close();
    channel.dispose();
  });

  socket.on("close", () => {
    session.close();
    channel.dispose();
  });
}

function rawDataBytes(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) {
    const buffer = Buffer.concat(data);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? "8787");
  const host = process.env.HOST ?? "127.0.0.1";
  const running = await createReferenceHost({ host, port });
  console.log(`HVTP P1 reference host listening on ws://${running.host}:${running.port}/hvtp`);
}
