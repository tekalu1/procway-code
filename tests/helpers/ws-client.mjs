import net from "node:net";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  computeAcceptKey,
  createFrameParser,
  encodeClientTextFrame
} from "../../src/adapters/serve/ws-server.mjs";

/**
 * Minimal RFC 6455 client used by the serve-* tests. We do not use the
 * `ws` package or the experimental Node 22 WebSocket global so this stays
 * dependency-free on Node 20 LTS. Returns an emitter that fires
 * `open`, `message`, and `close` once the handshake completes.
 */
export function connect({ host, port, path: urlPath = "/ws", token = "", query = null } = {}) {
  const emitter = new EventEmitter();
  const key = randomBytes(16).toString("base64");
  const expectedAccept = computeAcceptKey(key);
  // Compose query string from token + arbitrary extra params (e.g. cwd, resume)
  // without clobbering callers that pass a urlPath with its own '?'.
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
    ""
  ].join("\r\n");

  const socket = net.connect({ host, port }, () => {
    socket.write(headers);
  });
  let handshakeDone = false;
  let buffer = Buffer.alloc(0);
  const parser = createFrameParser();

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
      if (frame.opcode === 0x8) {
        socket.end();
        emitter.emit("close");
        continue;
      }
      if (frame.isText) emitter.emit("message", frame.text);
      else if (frame.payload) emitter.emit("message", frame.payload);
    }
  }

  socket.on("close", () => emitter.emit("close"));
  socket.on("error", (error) => emitter.emit("error", error));

  emitter.send = (text) => {
    if (!handshakeDone) throw new Error("ws-client: send before open");
    socket.write(encodeClientTextFrame(text));
  };
  emitter.close = () => {
    try { socket.end(); } catch { /* ignore */ }
  };
  // TK-131 test hook: expose the underlying socket so tests can simulate
  // abrupt ECONNRESET without rebuilding the handshake plumbing.
  emitter.socket = socket;

  return emitter;
}

export function waitFor(emitter, eventName, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(eventName, onEvent);
      reject(new Error(`ws-client: timed out waiting for ${eventName}`));
    }, timeoutMs);
    const onEvent = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    emitter.once(eventName, onEvent);
  });
}

export function collectMessages(emitter, predicate, { timeoutMs = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    const collected = [];
    const timer = setTimeout(() => {
      emitter.off("message", onMessage);
      reject(new Error(`ws-client: predicate did not resolve in ${timeoutMs}ms; saw ${collected.length} messages`));
    }, timeoutMs);
    const onMessage = (raw) => {
      let parsed;
      try { parsed = typeof raw === "string" ? JSON.parse(raw) : null; } catch { parsed = null; }
      collected.push({ raw, parsed });
      if (predicate(parsed, collected)) {
        clearTimeout(timer);
        emitter.off("message", onMessage);
        resolve(collected);
      }
    };
    emitter.on("message", onMessage);
  });
}
