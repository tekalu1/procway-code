import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { openWsClient, waitForOpen } from "../src/adapters/serve/ws-client.mjs";
import { buildHandshakeResponse } from "../src/adapters/serve/ws-server.mjs";

// #136 regression: an explicit client.close() MUST emit a 'close' event, even
// when the peer never sends its own FIN/close frame (the shape of an idle WS
// proxy). serve-client's abort path (exit 143) awaits 'close' after calling
// close(); before the fix, emitter.close() half-closed the socket and never
// emitted 'close', so the awaiting caller hung forever and the run never
// finalized — the "停止" button did nothing.

/** Minimal WS server that completes the RFC 6455 handshake and then goes silent
 *  (never sends a close frame), so the client's own close() is the only path to
 *  a 'close' event. */
function makeSilentWsServer() {
  const server = net.createServer((socket) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString("utf8");
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      socket.off("data", onData);
      const keyLine = buf.split("\r\n").find((l) => /^sec-websocket-key:/i.test(l));
      const key = keyLine ? keyLine.split(":")[1].trim() : "";
      socket.write(buildHandshakeResponse(key));
      // Deliberately keep the socket open and silent — mimic an idle proxy that
      // does not echo the client's FIN promptly.
    };
    socket.on("data", onData);
    socket.on("error", () => {});
  });
  return server;
}

let server = null;
afterEach(() => {
  if (server) { try { server.close(); } catch { /* ignore */ } server = null; }
});

function listen(srv) {
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve(srv.address().port)));
}

describe("openWsClient", () => {
  it("emits 'close' when the caller calls close(), even if the peer stays silent (#136)", async () => {
    server = makeSilentWsServer();
    const port = await listen(server);
    const ws = openWsClient({ host: "127.0.0.1", port, path: "/ws" });
    await waitForOpen(ws, { timeoutMs: 2000 });

    const closed = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timed out waiting for 'close' after close()")), 1000);
      ws.on("close", () => { clearTimeout(t); resolve(); });
    });
    ws.close();
    await expect(closed).resolves.toBeUndefined();
  });

  it("close() is idempotent and emits 'close' at most once", async () => {
    server = makeSilentWsServer();
    const port = await listen(server);
    const ws = openWsClient({ host: "127.0.0.1", port, path: "/ws" });
    await waitForOpen(ws, { timeoutMs: 2000 });

    let closeCount = 0;
    ws.on("close", () => { closeCount += 1; });
    ws.close();
    ws.close(); // second close must be a no-op
    await new Promise((r) => setTimeout(r, 100));
    expect(closeCount).toBe(1);
  });
});
