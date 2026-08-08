// RFC 6455 WebSocket client used by procway's dispatcher (skills/procway/
// scripts/serve-client.mjs) to drive worker sessions inside the long-lived
// `procway-code serve` process.
//
// Same wire shape as the test helper in tests/helpers/ws-client.mjs but
// scoped for production: explicit close semantics, ping/pong handling,
// no test-only socket-handle escape hatch, and a Promise-returning open.
//
// We intentionally avoid the `ws` package + the experimental Node 22
// WebSocket global to keep procway-code dependency-free on Node 20 LTS.

import net from "node:net";
import { EventEmitter } from "node:events";
import {
  computeAcceptKey,
  createFrameParser,
  encodeClientTextFrame,
  encodeFrame,
  makeClientKey,
  OPCODE,
} from "./ws-server.mjs";

/**
 * Open a WebSocket connection to a `procway-code serve` instance.
 *
 * Returns an EventEmitter with:
 *   - events: `open` (no args), `message` (text or Buffer), `close`,
 *     `handshake-failed` (statusLine), `error` (Error)
 *   - methods: `send(text)`, `close()`
 *   - prop: `socket` (underlying net.Socket) — exposed for advanced use
 *     (timeouts, abort signals); avoid touching unless necessary.
 *
 * @param {{
 *   host: string,
 *   port: number,
 *   path?: string,
 *   token?: string,
 *   query?: Record<string, string | null | undefined>,
 * }} input
 */
export function openWsClient({ host, port, path: urlPath = "/ws", token = "", query = null } = {}) {
  const emitter = new EventEmitter();
  const key = makeClientKey();
  const expectedAccept = computeAcceptKey(key);
  const params = new URLSearchParams();
  if (token) params.set("token", token);
  if (query && typeof query === "object") {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
    }
  }
  const qs = params.toString();
  const sep = urlPath.includes("?") ? "&" : "?";
  const target = qs ? `${urlPath}${sep}${qs}` : urlPath;
  const headers = [
    `GET ${target} HTTP/1.1`,
    `Host: ${host}:${port}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
    "",
    "",
  ].join("\r\n");

  const socket = net.connect({ host, port }, () => {
    socket.write(headers);
  });

  let handshakeDone = false;
  let buffer = Buffer.alloc(0);
  const parser = createFrameParser();
  let closed = false;

  socket.on("data", (chunk) => {
    if (!handshakeDone) {
      buffer = Buffer.concat([buffer, chunk]);
      const idx = buffer.indexOf("\r\n\r\n");
      if (idx === -1) return;
      const head = buffer.subarray(0, idx).toString("utf8");
      const rest = buffer.subarray(idx + 4);
      buffer = Buffer.alloc(0);
      const lines = head.split("\r\n");
      const statusLine = lines[0] ?? "";
      if (!statusLine.startsWith("HTTP/1.1 101")) {
        emitter.emit("handshake-failed", statusLine);
        socket.destroy();
        return;
      }
      const acceptHeader = lines.find((line) => line.toLowerCase().startsWith("sec-websocket-accept:"));
      const accept = acceptHeader ? acceptHeader.split(":").slice(1).join(":").trim() : null;
      if (accept !== expectedAccept) {
        emitter.emit("handshake-failed", "bad accept key");
        socket.destroy();
        return;
      }
      handshakeDone = true;
      emitter.emit("open");
      if (rest.length > 0) deliverFrames(rest);
      return;
    }
    deliverFrames(chunk);
  });

  function deliverFrames(chunk) {
    const frames = parser.push(chunk);
    for (const frame of frames) {
      if (frame.opcode === OPCODE.CLOSE) {
        closed = true;
        try { socket.end(); } catch { /* ignore */ }
        emitter.emit("close");
        continue;
      }
      if (frame.opcode === OPCODE.PING) {
        // Reply pong with the same payload, per RFC 6455 §5.5.3.
        try {
          socket.write(encodeFrame(frame.payload ?? Buffer.alloc(0), { opcode: OPCODE.PONG }));
        } catch { /* ignore */ }
        continue;
      }
      if (frame.opcode === OPCODE.PONG) continue;
      if (frame.isText) emitter.emit("message", frame.text);
      else if (frame.payload) emitter.emit("message", frame.payload);
    }
  }

  socket.on("close", () => {
    if (closed) return;
    closed = true;
    emitter.emit("close");
  });
  socket.on("error", (error) => emitter.emit("error", error));

  emitter.send = (text) => {
    if (!handshakeDone) throw new Error("ws-client: send before open");
    if (closed) throw new Error("ws-client: send after close");
    socket.write(encodeClientTextFrame(text));
  };
  emitter.close = (code = 1000, reason = "") => {
    if (closed) return;
    closed = true;
    try { socket.end(); } catch { /* ignore */ }
    void code; void reason; // close frame omitted; server sees connection close
    // #136: an explicit close() MUST still notify listeners. socket.end() only
    // half-closes (waits for the peer's FIN), so through an idle proxy the
    // underlying 'close' can be arbitrarily delayed — and even when it lands,
    // the socket.on('close') handler above is guarded by `closed` (set here)
    // and won't re-emit. Without this, a caller awaiting 'close' after close()
    // (serve-client's abort path → exit 143) hangs forever and the run never
    // finalizes. Emit on a microtask so `ws.on('close')` handlers registered
    // right after openWsClient() still fire, and listeners see async semantics.
    queueMicrotask(() => emitter.emit("close"));
  };
  emitter.socket = socket;

  return emitter;
}

/**
 * Resolve once the emitter emits `open`, reject on `handshake-failed` /
 * `error` / `close` before open. Mirrors the test helper's `waitFor`.
 */
export function waitForOpen(emitter, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      emitter.off("open", onOpen);
      emitter.off("handshake-failed", onFail);
      emitter.off("error", onError);
      emitter.off("close", onCloseBeforeOpen);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`ws-client: handshake timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onOpen = () => { cleanup(); resolve(); };
    const onFail = (statusLine) => { cleanup(); reject(new Error(`ws-client: handshake failed: ${statusLine}`)); };
    const onError = (err) => { cleanup(); reject(err); };
    const onCloseBeforeOpen = () => { cleanup(); reject(new Error("ws-client: connection closed before open")); };
    emitter.once("open", onOpen);
    emitter.once("handshake-failed", onFail);
    emitter.once("error", onError);
    emitter.once("close", onCloseBeforeOpen);
  });
}
