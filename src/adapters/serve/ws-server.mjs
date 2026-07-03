import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa
};

/**
 * Compute the Sec-WebSocket-Accept value for a given Sec-WebSocket-Key.
 *
 * @param {string} key
 */
export function computeAcceptKey(key) {
  return createHash("sha1").update(`${key}${GUID}`).digest("base64");
}

/**
 * Encode a single WebSocket frame for a server-to-client message. Server
 * frames are unmasked per RFC 6455 §5.1.
 *
 * @param {Buffer} payload
 * @param {{ opcode?: number, fin?: boolean }} [opts]
 * @returns {Buffer}
 */
export function encodeFrame(payload, { opcode = OPCODE.TEXT, fin = true } = {}) {
  const len = payload.length;
  const head = [];
  head.push((fin ? 0x80 : 0) | (opcode & 0x0f));
  if (len < 126) {
    head.push(len);
  } else if (len < 65536) {
    head.push(126);
    head.push((len >> 8) & 0xff);
    head.push(len & 0xff);
  } else {
    head.push(127);
    const big = BigInt(len);
    for (let i = 7; i >= 0; i -= 1) head.push(Number((big >> BigInt(i * 8)) & 0xffn));
  }
  return Buffer.concat([Buffer.from(head), payload]);
}

/**
 * Encode a TEXT frame from a UTF-8 string.
 */
export function encodeTextFrame(text) {
  return encodeFrame(Buffer.from(String(text), "utf8"), { opcode: OPCODE.TEXT });
}

/**
 * Encode a CLOSE frame with the given status code and reason.
 */
export function encodeCloseFrame(code = 1000, reason = "") {
  const reasonBuf = Buffer.from(reason, "utf8");
  const buf = Buffer.alloc(2 + reasonBuf.length);
  buf.writeUInt16BE(code, 0);
  reasonBuf.copy(buf, 2);
  return encodeFrame(buf, { opcode: OPCODE.CLOSE });
}

/**
 * Streaming frame parser. Append bytes via `push(chunk)` and consume zero or
 * more complete frames from the returned array. Single-frame TEXT messages
 * are decoded into UTF-8 strings; fragmented messages are concatenated.
 *
 * Returns parsed frames as `{ opcode, payload, isText }` for callers to act on.
 */
export function createFrameParser() {
  let buffer = Buffer.alloc(0);
  let fragmentOpcode = null;
  const fragments = [];
  return {
    push(chunk) {
      buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
      const out = [];
      while (true) {
        const frame = readFrame(buffer);
        if (!frame) break;
        buffer = buffer.subarray(frame.consumed);
        if (frame.opcode === OPCODE.CONTINUATION) {
          fragments.push(frame.payload);
        } else if (frame.opcode === OPCODE.TEXT || frame.opcode === OPCODE.BINARY) {
          if (frame.fin) {
            out.push(toMessage(frame.opcode, frame.payload));
          } else {
            fragmentOpcode = frame.opcode;
            fragments.length = 0;
            fragments.push(frame.payload);
          }
          continue;
        } else if (frame.opcode === OPCODE.CLOSE || frame.opcode === OPCODE.PING || frame.opcode === OPCODE.PONG) {
          out.push({ opcode: frame.opcode, payload: frame.payload });
          continue;
        }
        if (frame.fin && fragmentOpcode != null) {
          const merged = Buffer.concat(fragments);
          out.push(toMessage(fragmentOpcode, merged));
          fragmentOpcode = null;
          fragments.length = 0;
        }
      }
      return out;
    }
  };
}

function toMessage(opcode, payload) {
  if (opcode === OPCODE.TEXT) {
    return { opcode, payload, isText: true, text: payload.toString("utf8") };
  }
  return { opcode, payload, isText: false };
}

function readFrame(buf) {
  if (buf.length < 2) return null;
  const byte0 = buf[0];
  const byte1 = buf[1];
  const fin = (byte0 & 0x80) !== 0;
  const opcode = byte0 & 0x0f;
  const masked = (byte1 & 0x80) !== 0;
  let payloadLen = byte1 & 0x7f;
  let offset = 2;
  if (payloadLen === 126) {
    if (buf.length < offset + 2) return null;
    payloadLen = buf.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLen === 127) {
    if (buf.length < offset + 8) return null;
    const big = buf.readBigUInt64BE(offset);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError("ws frame too large");
    }
    payloadLen = Number(big);
    offset += 8;
  }
  let maskKey = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    maskKey = buf.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + payloadLen) return null;
  const raw = buf.subarray(offset, offset + payloadLen);
  const payload = masked ? unmask(raw, maskKey) : Buffer.from(raw);
  return { fin, opcode, payload, consumed: offset + payloadLen };
}

function unmask(buf, key) {
  const out = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i < buf.length; i += 1) out[i] = buf[i] ^ key[i % 4];
  return out;
}

/**
 * Server-side WebSocket connection abstraction wrapping a raw `socket`
 * (net.Socket) after the upgrade handshake completes. Emits `message`,
 * `close`, and `error` events. Provides `send`, `close`, and `ping`.
 */
export class WsConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.closed = false;
    const parser = createFrameParser();
    socket.on("data", (chunk) => {
      let frames;
      try {
        frames = parser.push(chunk);
      } catch (error) {
        this.emit("error", error);
        this.close(1009, "frame too large");
        return;
      }
      for (const frame of frames) {
        if (frame.opcode === OPCODE.PING) {
          this.#sendRaw(encodeFrame(frame.payload ?? Buffer.alloc(0), { opcode: OPCODE.PONG }));
          continue;
        }
        if (frame.opcode === OPCODE.PONG) continue;
        if (frame.opcode === OPCODE.CLOSE) {
          this.close(1000, "");
          continue;
        }
        if (frame.isText) {
          this.emit("message", frame.text);
        } else {
          this.emit("message", frame.payload);
        }
      }
    });
    socket.on("close", () => {
      if (this.closed) return;
      this.closed = true;
      this.emit("close");
    });
    socket.on("end", () => {
      // WebSocket has no half-close: a peer FIN without a Close frame means
      // the client is gone (abnormal closure, RFC 6455 §7.1.7). http.Server
      // upgrade sockets keep allowHalfOpen, so without this the socket
      // lingers half-open after a page reload, 'close' never fires, and the
      // bridge's close-wired detach leaks its event forwarder on the session.
      if (this.closed) return;
      this.closed = true;
      try { this.socket.destroy(); } catch { /* socket may already be torn down */ }
      this.emit("close");
    });
    socket.on("error", (error) => {
      // TK-131: socket errors (ECONNRESET on browser close/reload, EPIPE on
      // half-open writes) must not crash the server process. Treat as a close
      // path: mark closed, destroy the socket, emit close so handles.delete
      // cleanup runs. Re-emit error only when at least one listener exists,
      // otherwise EventEmitter would throw (Node's "Unhandled 'error' event").
      if (this.closed) return;
      this.closed = true;
      try { this.socket.destroy(); } catch { /* socket may already be torn down */ }
      this.emit("close");
      if (this.listenerCount("error") > 0) {
        this.emit("error", error);
      }
    });
  }

  send(text) {
    if (this.closed) return false;
    return this.#sendRaw(encodeTextFrame(text));
  }

  close(code = 1000, reason = "") {
    if (this.closed) return;
    this.closed = true;
    try {
      this.#sendRaw(encodeCloseFrame(code, reason));
    } catch {
      // socket may already be torn down
    }
    try {
      this.socket.end();
    } catch {
      // ignore
    }
    this.emit("close");
  }

  #sendRaw(frame) {
    if (this.socket.writable === false) return false;
    return this.socket.write(frame);
  }
}

/**
 * Build the HTTP 101 handshake response headers for a Sec-WebSocket-Key.
 */
export function buildHandshakeResponse(key, { extraHeaders = [] } = {}) {
  const accept = computeAcceptKey(key);
  const headers = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    ...extraHeaders,
    "",
    ""
  ];
  return headers.join("\r\n");
}

/**
 * Generate a random Sec-WebSocket-Key for client-side handshakes (used by
 * the test client helper that piggybacks on this module).
 */
export function makeClientKey() {
  return randomBytes(16).toString("base64");
}

/**
 * Mask a buffer with the given 4-byte mask key, in place. Used by the test
 * client; clients MUST mask outbound frames per RFC 6455 §5.1.
 */
export function maskInPlace(buf, key) {
  for (let i = 0; i < buf.length; i += 1) buf[i] ^= key[i % 4];
  return buf;
}

/**
 * Encode a client-to-server TEXT frame (masked). For test use.
 */
export function encodeClientTextFrame(text) {
  const payload = Buffer.from(String(text), "utf8");
  const mask = randomBytes(4);
  const len = payload.length;
  const head = [];
  head.push(0x81);
  if (len < 126) {
    head.push(0x80 | len);
  } else if (len < 65536) {
    head.push(0x80 | 126);
    head.push((len >> 8) & 0xff);
    head.push(len & 0xff);
  } else {
    head.push(0x80 | 127);
    const big = BigInt(len);
    for (let i = 7; i >= 0; i -= 1) head.push(Number((big >> BigInt(i * 8)) & 0xffn));
  }
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
  return Buffer.concat([Buffer.from(head), mask, masked]);
}

export { OPCODE };
