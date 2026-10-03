import { createReadStream, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { P1_LIMITS } from "@hvtp/protocol-types";
import { P1Session } from "./session.js";

export interface ReferenceHostOptions {
  readonly host?: string;
  readonly port?: number;
  readonly publicOrigin?: string;
  readonly fixturePath?: string;
}

export interface ReferenceHost {
  readonly server: Server;
  readonly wsServer: WebSocketServer;
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

export async function createReferenceHost(options: ReferenceHostOptions = {}): Promise<ReferenceHost> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 0;
  const defaultFixture = resolve(dirname(fileURLToPath(import.meta.url)), "../../../protocol-spec/fixtures/unit-cube.gltf");
  const fixturePath = options.fixturePath ?? defaultFixture;

  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/assets/p1/unit-cube.gltf") {
      const stat = statSync(fixturePath);
      if (stat.size > P1_LIMITS.maxAssetBytes) {
        res.writeHead(413).end();
        return;
      }
      res.writeHead(200, {
        "content-type": "model/gltf+json",
        "content-length": stat.size,
        "cache-control": "no-store",
      });
      createReadStream(fixturePath).pipe(res);
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
  const origin = options.publicOrigin ?? `http://${host}:${port}`;
  const assetBaseUri = new URL("/assets/p1/", origin).toString();

  wsServer.on("connection", (socket) => bindSocket(socket, new P1Session(assetBaseUri)));

  return {
    server,
    wsServer,
    host,
    port,
    async close(): Promise<void> {
      for (const client of wsServer.clients) client.close(1001, "host shutdown");
      await new Promise<void>((resolveClose) => wsServer.close(() => resolveClose()));
      await new Promise<void>((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
    },
  };
}

function bindSocket(socket: WebSocket, session: P1Session): void {
  const decoder = new TextDecoder("utf-8", { fatal: true });

  socket.on("message", (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      socket.close(1003, "P1 requires JSON text messages");
      session.close();
      return;
    }

    const bytes = rawDataBytes(data);
    if (bytes.byteLength > P1_LIMITS.maxMessageBytes) {
      socket.close(1009, "message exceeds P1 maxMessageBytes");
      session.close();
      return;
    }

    let text: string;
    try {
      text = decoder.decode(bytes);
    } catch {
      socket.close(1007, "invalid UTF-8 text message");
      session.close();
      return;
    }

    socket.send(JSON.stringify(session.handleText(text)));
  });

  socket.on("close", () => session.close());
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
