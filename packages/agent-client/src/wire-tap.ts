import type { P1Socket, P1SocketFactory } from "@hvtp/client-core";

export interface WireFrame {
  readonly direction: "out" | "in";
  /** Parsed JSON when the frame is valid JSON text, otherwise the raw value. */
  readonly frame: unknown;
}

/**
 * Wraps a socket factory so every outbound and inbound frame is observable. The client sends synchronously, so
 * the outbound frame of a request is recorded by the time the request method returns; that is how the agent
 * learns a request ID before its terminal result. The tap never alters, delays or replays traffic.
 */
export function tapSocketFactory(inner: P1SocketFactory, onFrame: (frame: WireFrame) => void): P1SocketFactory {
  return (url) => {
    const socket = inner(url);
    const report = (direction: "out" | "in", data: unknown) => {
      let frame: unknown = data;
      if (typeof data === "string") {
        try { frame = JSON.parse(data); } catch { frame = data; }
      }
      try { onFrame({ direction, frame }); } catch { /* observers must not affect traffic */ }
    };
    const tapped: P1Socket = {
      send: (data) => { report("out", data); socket.send(data); },
      close: (code, reason) => socket.close(code, reason),
      get onopen() { return socket.onopen; },
      set onopen(handler) { socket.onopen = handler; },
      get onerror() { return socket.onerror; },
      set onerror(handler) { socket.onerror = handler; },
      get onclose() { return socket.onclose; },
      set onclose(handler) { socket.onclose = handler; },
      get onmessage() { return socket.onmessage; },
      set onmessage(handler) {
        socket.onmessage = handler === null ? null : (event) => { report("in", event.data); handler(event); };
      },
    };
    return tapped;
  };
}
