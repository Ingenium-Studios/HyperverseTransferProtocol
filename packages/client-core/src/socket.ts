/**
 * The minimal subset of the WHATWG `WebSocket` API the client needs. Browser `WebSocket` and the Node `ws`
 * package both satisfy it structurally, so lifecycle tests never need a DOM. The wire stays JSON text over
 * WebSocket; this is not another transport.
 */
export interface P1Socket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type P1SocketFactory = (url: string) => P1Socket;

/** Uses the platform `WebSocket` global (browsers, Node 22+). */
export const platformSocketFactory: P1SocketFactory = (url) => {
  const WebSocketCtor = (globalThis as { WebSocket?: new (url: string) => P1Socket }).WebSocket;
  if (WebSocketCtor === undefined) throw new Error("No global WebSocket; pass a socketFactory.");
  return new WebSocketCtor(url);
};

/** Close codes the client uses. Browsers only allow 1000 or 3000–4999 from script. */
export const CLIENT_CLOSE_NORMAL = 1000;
export const CLIENT_CLOSE_PROTOCOL_VIOLATION = 4002;
