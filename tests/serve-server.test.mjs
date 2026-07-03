import { describe, expect, it, beforeEach, afterEach } from "vitest";
import http from "node:http";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../src/adapters/serve/server.mjs";
import { saveSessionState } from "../src/session/store.mjs";
import { connect, waitFor, collectMessages } from "./helpers/ws-client.mjs";

const echoBin = fileURLToPath(new URL("./fixtures/cli-agent-echo.mjs", import.meta.url));

function settingsForCliAgent() {
  return {
    defaultProvider: "echo-agent",
    defaultModel: "echo",
    approvalMode: "auto-readonly",
    agents: { defaultTimeoutMs: 5000, maxDepth: 1, maxConcurrentAgents: 1 },
    tools: { maxToolRounds: 1, maxParallelTools: 1 },
    providers: {
      "echo-agent": {
        type: "cli-agent",
        command: process.execPath,
        args: [echoBin],
        stdinMode: "json"
      }
    },
    mcpServers: {},
    session: { enabled: false },
    context: { compatibilityMode: "claude" }
  };
}

function fetchOnce({ host, port, urlPath = "/", method = "GET", headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, path: urlPath, method, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

let cwd;
let handle;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "procway-serve-"));
});

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

describe("serve server", () => {
  it("rejects startup when the auth token is missing", async () => {
    await expect(startServer({
      cwd,
      settings: settingsForCliAgent(),
      port: 0,
      host: "127.0.0.1",
      token: ""
    })).rejects.toThrow(/PROCWAY_SERVE_TOKEN/);
  });

  it("emits a warning when bound to a public host", async () => {
    const warnings = [];
    handle = await startServer({
      cwd,
      settings: settingsForCliAgent(),
      port: 0,
      host: "0.0.0.0",
      token: "test-token",
      onWarn: (m) => warnings.push(m)
    });
    expect(warnings.some((m) => /0\.0\.0\.0/.test(m))).toBe(true);
  });

  it("serves index.html on / and a 404 on missing files", async () => {
    handle = await startServer({
      cwd,
      settings: settingsForCliAgent(),
      port: 0,
      host: "127.0.0.1",
      token: "test-token"
    });
    const ok = await fetchOnce({ host: "127.0.0.1", port: handle.port, urlPath: "/" });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toContain("text/html");
    expect(ok.body).toContain("procway-code");

    const css = await fetchOnce({ host: "127.0.0.1", port: handle.port, urlPath: "/style.css" });
    expect(css.statusCode).toBe(200);
    expect(css.headers["content-type"]).toContain("text/css");

    const js = await fetchOnce({ host: "127.0.0.1", port: handle.port, urlPath: "/client.mjs" });
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toContain("javascript");

    const missing = await fetchOnce({ host: "127.0.0.1", port: handle.port, urlPath: "/no-such-file.txt" });
    expect(missing.statusCode).toBe(404);

    const traversal = await fetchOnce({ host: "127.0.0.1", port: handle.port, urlPath: "/../package.json" });
    expect([400, 404]).toContain(traversal.statusCode);
  });

  it("rejects WebSocket upgrade with the wrong / missing token", async () => {
    handle = await startServer({
      cwd,
      settings: settingsForCliAgent(),
      port: 0,
      host: "127.0.0.1",
      token: "good-token"
    });
    const result = await rawUpgrade({ host: "127.0.0.1", port: handle.port, urlPath: "/ws" });
    expect(result.statusLine).toMatch(/401/);
    const result2 = await rawUpgrade({ host: "127.0.0.1", port: handle.port, urlPath: "/ws?token=bad" });
    expect(result2.statusLine).toMatch(/401/);
  });

  it("accepts WebSocket upgrade with the correct token and emits ready", async () => {
    handle = await startServer({
      cwd,
      settings: settingsForCliAgent(),
      port: 0,
      host: "127.0.0.1",
      token: "good-token"
    });
    const ws = connect({ host: "127.0.0.1", port: handle.port, token: "good-token" });
    await waitFor(ws, "open");
    const messages = await collectMessages(ws, (msg) => msg && msg.kind === "ready");
    const ready = messages.find((m) => m.parsed?.kind === "ready").parsed;
    // protocolVersion is the serve-protocol negotiation field (ADR 0030 D4),
    // independent of the package `version`.
    expect(ready).toMatchObject({ kind: "ready", version: "0.1.0-alpha.1", protocolVersion: 1 });
    expect(typeof ready.sessionId).toBe("string");
    ws.close();
  });

  it("buffers a command sent BEFORE the ready frame and answers it (early-send race)", async () => {
    // WsConnection starts parsing inbound frames right after the 101
    // handshake, but the bridge's message handler only attaches after the
    // async session creation. A command fired on `open` (before
    // `{kind:"ready"}`) used to be silently dropped — no response, no error.
    // The server now buffers pre-attach frames and replays them.
    //
    // The race is made DETERMINISTIC with a slow sessionFactory: on a fast
    // localhost loop the default factory can win the race by accident, which
    // would let a regression slip through (the un-fixed server passed an
    // undelayed version of this test).
    handle = await startServer({
      cwd,
      settings: settingsForCliAgent(),
      port: 0,
      host: "127.0.0.1",
      token: "good-token",
      sessionFactory: async ({ settings, cwd: sessionCwd, sessionId }) => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const { createAgentSession } = await import("../src/core/index.mjs");
        return createAgentSession({ settings, cwd: sessionCwd, sessionId });
      }
    });
    const ws = connect({ host: "127.0.0.1", port: handle.port, token: "good-token" });
    await waitFor(ws, "open");
    // Send IMMEDIATELY — deliberately not waiting for the ready frame.
    ws.send(JSON.stringify({ kind: "command", command: "history", id: "early-1", args: {} }));
    const messages = await collectMessages(
      ws,
      (msg) => msg && msg.kind === "response" && msg.id === "early-1"
    );
    const response = messages.find((m) => m.parsed?.kind === "response").parsed;
    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({ transcript: [] });
    // The ready frame still arrived (before or after — order is not part of
    // the contract for an early sender, delivery is).
    expect(messages.some((m) => m.parsed?.kind === "ready")).toBe(true);
    ws.close();
  });

  it("lists persisted sessions and loads one over the WebSocket bridge end-to-end", async () => {
    await saveSessionState({
      sessionId: "persisted-1",
      state: {
        title: "first",
        cwd,
        provider: "p",
        model: "m",
        updatedAt: "2026-05-01T00:00:00.000Z",
        messages: [
          { role: "user", content: "hi", id: "u1", sessionId: "persisted-1" },
          { role: "assistant", content: "hello", id: "a1", sessionId: "persisted-1" }
        ],
        eventCount: 4
      }
    });
    handle = await startServer({
      cwd,
      settings: settingsForCliAgent(),
      port: 0,
      host: "127.0.0.1",
      token: "good-token"
    });
    const ws = connect({ host: "127.0.0.1", port: handle.port, token: "good-token" });
    await waitFor(ws, "open");
    await collectMessages(ws, (msg) => msg && msg.kind === "ready");

    ws.send(JSON.stringify({ kind: "command", command: "listSessions", id: "L1", args: { limit: 10 } }));
    const listed = await collectMessages(ws, (msg) => msg && msg.kind === "response" && msg.id === "L1", { timeoutMs: 4000 });
    const listResponse = listed.map((m) => m.parsed).find((m) => m && m.kind === "response" && m.id === "L1");
    expect(listResponse.ok).toBe(true);
    const persisted = listResponse.result.sessions.find((s) => s.sessionId === "persisted-1");
    expect(persisted).toBeDefined();
    expect(persisted.messageCount).toBe(2);

    ws.send(JSON.stringify({ kind: "command", command: "loadSession", id: "R1", args: { sessionId: "persisted-1" } }));
    const resumed = await collectMessages(ws, (msg) => msg && msg.kind === "response" && msg.id === "R1", { timeoutMs: 4000 });
    const parsedTrail = resumed.map((m) => m.parsed);
    const resumedEvent = parsedTrail.find((m) => m && m.kind === "event" && m.event?.type === "session.resumed");
    const resumeResponse = parsedTrail.find((m) => m && m.kind === "response" && m.id === "R1");
    expect(resumedEvent).toBeDefined();
    expect(resumedEvent.event.sessionId).toBe("persisted-1");
    expect(resumedEvent.event.messageCount).toBe(2);
    expect(parsedTrail.indexOf(resumedEvent)).toBeLessThan(parsedTrail.indexOf(resumeResponse));
    expect(resumeResponse.ok).toBe(true);
    expect(resumeResponse.result).toEqual(expect.objectContaining({ sessionId: "persisted-1", messageCount: 2 }));

    ws.send(JSON.stringify({ kind: "command", command: "history", id: "H1" }));
    const history = await collectMessages(ws, (msg) => msg && msg.kind === "response" && msg.id === "H1", { timeoutMs: 4000 });
    const historyResponse = history.map((m) => m.parsed).find((m) => m && m.kind === "response" && m.id === "H1");
    expect(historyResponse.ok).toBe(true);
    expect(Array.isArray(historyResponse.result?.transcript)).toBe(true);
    expect(historyResponse.result.transcript.length).toBeGreaterThan(0);
    ws.close();
  });

  it("returns session_not_found over the WebSocket bridge for missing sessionId", async () => {
    handle = await startServer({
      cwd,
      settings: settingsForCliAgent(),
      port: 0,
      host: "127.0.0.1",
      token: "good-token"
    });
    const ws = connect({ host: "127.0.0.1", port: handle.port, token: "good-token" });
    await waitFor(ws, "open");
    await collectMessages(ws, (msg) => msg && msg.kind === "ready");
    ws.send(JSON.stringify({ kind: "command", command: "loadSession", id: "M1", args: { sessionId: "no-such-session" } }));
    const collected = await collectMessages(ws, (msg) => msg && msg.kind === "response" && msg.id === "M1", { timeoutMs: 4000 });
    const response = collected.map((m) => m.parsed).find((m) => m && m.kind === "response" && m.id === "M1");
    expect(response.ok).toBe(false);
    expect(response.error.code).toBe("session_not_found");
    ws.close();
  });

  it("runs a turn end-to-end via the WebSocket bridge and broadcasts events", async () => {
    handle = await startServer({
      cwd,
      settings: settingsForCliAgent(),
      port: 0,
      host: "127.0.0.1",
      token: "good-token"
    });
    const ws = connect({ host: "127.0.0.1", port: handle.port, token: "good-token" });
    await waitFor(ws, "open");
    await collectMessages(ws, (msg) => msg && msg.kind === "ready");
    ws.send(JSON.stringify({ kind: "command", command: "runTurn", id: "req-1", args: { prompt: "ping" } }));
    const collected = await collectMessages(ws, (msg) => msg && msg.kind === "response" && msg.id === "req-1", { timeoutMs: 8000 });
    const eventKinds = collected.map((m) => m.parsed).filter((m) => m && m.kind === "event").map((m) => m.event.type);
    expect(eventKinds).toContain("user.prompt.submitted");
    expect(eventKinds).toContain("assistant.message.completed");
    expect(eventKinds).toContain("turn.completed");
    const response = collected.map((m) => m.parsed).find((m) => m && m.kind === "response" && m.id === "req-1");
    expect(response).toMatchObject({ ok: true });
    ws.close();
  });

  // TK-131: socket-level errors (ECONNRESET on browser close/reload, EPIPE on
  // half-open writes) used to crash the server with "Unhandled 'error' event".
  // After the fix, abrupt socket destruction must transition the connection to
  // closed (handles cleanup runs) and the server stays alive to accept new
  // connections.
  it("survives an abrupt socket destroy after the WebSocket upgrade (TK-131)", async () => {
    handle = await startServer({
      cwd,
      settings: settingsForCliAgent(),
      port: 0,
      host: "127.0.0.1",
      token: "good-token"
    });
    const port = handle.port;

    // Establish a normal upgrade via the connect() helper (same path the rest
    // of the suite uses), then yank the underlying socket to simulate an
    // ECONNRESET. The fix in ws-server.mjs / server.mjs must keep the server
    // alive and free the per-connection handle.
    const ws = connect({ host: "127.0.0.1", port, token: "good-token" });
    // The destroyed socket re-emits 'error' on the helper emitter — register a
    // no-op listener so the expected ECONNRESET doesn't bubble up as an
    // EventEmitter "Unhandled 'error' event".
    ws.on("error", () => { /* expected */ });
    await waitFor(ws, "open");
    await collectMessages(ws, (msg) => msg && msg.kind === "ready");
    const rawSocket = ws.socket;
    rawSocket.destroy(new Error("ECONNRESET"));
    // Give the server a tick to process the error path.
    await new Promise((r) => setTimeout(r, 100));

    // Server is still alive: a fresh connection must succeed.
    const ws2 = connect({ host: "127.0.0.1", port, token: "good-token" });
    await waitFor(ws2, "open");
    await collectMessages(ws2, (msg) => msg && msg.kind === "ready");
    ws2.close();
  });

  // Phase 4a: per-session cwd override via ?cwd= query param.
  // We use a real session factory but capture the cwd via a wrapper so we
  // don't have to mock the AgentSession surface.
  async function startWithCapturingFactory({ token }) {
    const captured = [];
    const realFactory = (await import("../src/core/index.mjs")).createAgentSession;
    const h = await startServer({
      cwd,
      settings: settingsForCliAgent(),
      port: 0,
      host: "127.0.0.1",
      token,
      sessionFactory: async (input) => {
        captured.push({ cwd: input.cwd, sessionId: input.sessionId, origin: input.origin, hearingReturnMode: input.hearingReturnMode === true });
        return realFactory(input);
      },
    });
    return { handle: h, captured };
  }

  it("accepts ?cwd=<absolute> at handshake and uses it for the session", async () => {
    const sessionCwd = await mkdtemp(path.join(os.tmpdir(), "procway-serve-cwd-"));
    try {
      const { handle: h, captured } = await startWithCapturingFactory({ token: "good-token" });
      handle = h;
      const ws = connect({
        host: "127.0.0.1",
        port: handle.port,
        token: "good-token",
        query: { cwd: sessionCwd },
      });
      // Attach the ready collector BEFORE awaiting open: the ready frame can
      // arrive in the same TCP chunk as the 101 handshake, so it is emitted
      // synchronously right after 'open' — collecting only after `waitFor(open)`
      // resolves (a microtask later) races and can miss it.
      const ready = collectMessages(ws, (msg) => msg && msg.kind === "ready");
      await waitFor(ws, "open");
      await ready;
      ws.close();
      expect(captured.length).toBeGreaterThan(0);
      expect(captured[0].cwd).toBe(path.resolve(sessionCwd));
    } finally {
      await rm(sessionCwd, { recursive: true, force: true });
    }
  })

  it("falls back to serve-level cwd when ?cwd= is missing", async () => {
    const { handle: h, captured } = await startWithCapturingFactory({ token: "good-token" });
    handle = h;
    const ws = connect({ host: "127.0.0.1", port: handle.port, token: "good-token" });
    await waitFor(ws, "open");
    await collectMessages(ws, (msg) => msg && msg.kind === "ready");
    ws.close();
    expect(captured[0].cwd).toBe(cwd);
  })

  it("ignores ?cwd= with a relative path (falls back to serve-level cwd)", async () => {
    const { handle: h, captured } = await startWithCapturingFactory({ token: "good-token" });
    handle = h;
    const ws = connect({
      host: "127.0.0.1",
      port: handle.port,
      token: "good-token",
      query: { cwd: "../escape/attempt" },
    });
    await waitFor(ws, "open");
    await collectMessages(ws, (msg) => msg && msg.kind === "ready");
    ws.close();
    expect(captured[0].cwd).toBe(cwd);
  })

  // Session-origin tag: serve-client workers send ?origin=worker so their
  // sessions are excluded from the /ai history sidebar (user sessions only).
  it("threads ?origin=worker through to the session factory", async () => {
    const { handle: h, captured } = await startWithCapturingFactory({ token: "good-token" });
    handle = h;
    const ws = connect({
      host: "127.0.0.1",
      port: handle.port,
      token: "good-token",
      query: { origin: "worker" },
    });
    await waitFor(ws, "open");
    await collectMessages(ws, (msg) => msg && msg.kind === "ready");
    ws.close();
    expect(captured[0].origin).toBe("worker");
  })

  // §6 run-loop hearing return mode: workers connect with ?hearingMode=return so
  // request_user_action records-and-returns instead of blocking the worker turn.
  it("threads ?hearingMode=return through to the session factory", async () => {
    const { handle: h, captured } = await startWithCapturingFactory({ token: "good-token" });
    handle = h;
    const ws = connect({
      host: "127.0.0.1",
      port: handle.port,
      token: "good-token",
      query: { hearingMode: "return" },
    });
    await waitFor(ws, "open");
    await collectMessages(ws, (msg) => msg && msg.kind === "ready");
    ws.close();
    expect(captured[0].hearingReturnMode).toBe(true);
  })

  it("leaves hearingReturnMode false when ?hearingMode is absent or not 'return'", async () => {
    const { handle: h, captured } = await startWithCapturingFactory({ token: "good-token" });
    handle = h;
    const ws = connect({
      host: "127.0.0.1",
      port: handle.port,
      token: "good-token",
      query: { hearingMode: "block" },
    });
    await waitFor(ws, "open");
    await collectMessages(ws, (msg) => msg && msg.kind === "ready");
    ws.close();
    expect(captured[0].hearingReturnMode).toBe(false);
  })

  it("?session=<new-id> creates a session that ADOPTS the given id (ADR 0020 create-or-resume)", async () => {
    handle = await startServer({
      cwd,
      settings: settingsForCliAgent(),
      port: 0,
      host: "127.0.0.1",
      token: "good-token"
    });
    const ws = connect({
      host: "127.0.0.1",
      port: handle.port,
      token: "good-token",
      query: { session: "conv-fresh-123" },
    });
    const ready = collectMessages(ws, (msg) => msg && msg.kind === "ready");
    await waitFor(ws, "open");
    const frames = await ready;
    const readyFrame = frames.map((m) => m.parsed).find((m) => m && m.kind === "ready");
    expect(readyFrame.sessionId).toBe("conv-fresh-123");
    ws.close();
  });

  it("?session=<existing-id> resumes the persisted session instead of creating", async () => {
    await saveSessionState({
      sessionId: "conv-existing-1",
      state: {
        title: "existing",
        cwd,
        provider: "p",
        model: "m",
        updatedAt: "2026-05-01T00:00:00.000Z",
        messages: [
          { role: "user", content: "hi", id: "u1", sessionId: "conv-existing-1" },
          { role: "assistant", content: "hello", id: "a1", sessionId: "conv-existing-1" }
        ],
        eventCount: 4
      }
    });
    handle = await startServer({
      cwd,
      settings: settingsForCliAgent(),
      port: 0,
      host: "127.0.0.1",
      token: "good-token"
    });
    const ws = connect({
      host: "127.0.0.1",
      port: handle.port,
      token: "good-token",
      query: { session: "conv-existing-1" },
    });
    const ready = collectMessages(ws, (msg) => msg && msg.kind === "ready");
    await waitFor(ws, "open");
    const frames = await ready;
    const readyFrame = frames.map((m) => m.parsed).find((m) => m && m.kind === "ready");
    expect(readyFrame.sessionId).toBe("conv-existing-1");
    // Resume (not create): the persisted transcript is rehydrated.
    ws.send(JSON.stringify({ kind: "command", command: "history", id: "H1" }));
    const history = await collectMessages(ws, (msg) => msg && msg.kind === "response" && msg.id === "H1", { timeoutMs: 4000 });
    const historyResponse = history.map((m) => m.parsed).find((m) => m && m.kind === "response" && m.id === "H1");
    expect(historyResponse.ok).toBe(true);
    expect(historyResponse.result.transcript.length).toBeGreaterThan(0);
    ws.close();
  });

  it("rejects a path-traversal ?session= id (factory sees no sessionId → fresh own id)", async () => {
    const { handle: h, captured } = await startWithCapturingFactory({ token: "good-token" });
    handle = h;
    const ws = connect({
      host: "127.0.0.1",
      port: handle.port,
      token: "good-token",
      query: { session: "../escape" },
    });
    const ready = collectMessages(ws, (msg) => msg && msg.kind === "ready");
    await waitFor(ws, "open");
    await ready;
    ws.close();
    expect(captured[0].sessionId).toBeUndefined();
  });

  it("drops a malformed ?origin= (factory sees null) and defaults to null when absent", async () => {
    const { handle: h, captured } = await startWithCapturingFactory({ token: "good-token" });
    handle = h;
    const wsBad = connect({
      host: "127.0.0.1",
      port: handle.port,
      token: "good-token",
      query: { origin: "not a token!" },
    });
    await waitFor(wsBad, "open");
    await collectMessages(wsBad, (msg) => msg && msg.kind === "ready");
    wsBad.close();
    const wsNone = connect({ host: "127.0.0.1", port: handle.port, token: "good-token" });
    await waitFor(wsNone, "open");
    await collectMessages(wsNone, (msg) => msg && msg.kind === "ready");
    wsNone.close();
    expect(captured[0].origin).toBeNull();
    expect(captured[1].origin).toBeNull();
  })
});

function rawUpgrade({ host, port, urlPath }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port }, () => {
      const headers = [
        `GET ${urlPath} HTTP/1.1`,
        `Host: ${host}:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
        "",
        ""
      ].join("\r\n");
      socket.write(headers);
    });
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const idx = buffer.indexOf("\r\n\r\n");
      if (idx !== -1) {
        const head = buffer.subarray(0, idx).toString("utf8");
        const statusLine = head.split("\r\n")[0] ?? "";
        socket.destroy();
        resolve({ statusLine });
      }
    });
    socket.on("error", reject);
    socket.on("close", () => {
      if (buffer.length === 0) resolve({ statusLine: "" });
    });
  });
}
