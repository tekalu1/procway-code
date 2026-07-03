import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, EventBus } from "../src/core/index.mjs";
import { attachBridge } from "../src/adapters/serve/bridge.mjs";
import { saveSessionState, loadSessionState } from "../src/session/store.mjs";

const echoBin = fileURLToPath(new URL("./fixtures/cli-agent-echo.mjs", import.meta.url));

function fakeWs() {
  const emitter = new EventEmitter();
  const sent = [];
  emitter.send = (text) => { sent.push(text); };
  emitter.close = () => emitter.emit("close");
  emitter.sent = sent;
  return emitter;
}

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

let cwd;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "procway-bridge-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function flushIo() {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

async function waitFor(predicate, { timeoutMs = 4000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("waitFor: predicate not satisfied");
}

describe("serve bridge", () => {
  it("forwards every event to the WebSocket and sends a ready message on attach", async () => {
    const events = new EventBus();
    const session = await createAgentSession({
      settings: settingsForCliAgent(),
      cwd,
      sessionId: "bridge-1",
      events
    });
    const ws = fakeWs();
    const bridge = attachBridge({ session, ws, version: "0.0.1" });
    expect(ws.sent).toHaveLength(1);
    const ready = JSON.parse(ws.sent[0]);
    // protocolVersion is the serve-protocol negotiation field (ADR 0030 D4),
    // independent of the package `version` above.
    expect(ready).toMatchObject({ kind: "ready", sessionId: "bridge-1", version: "0.0.1", protocolVersion: 1 });

    await session.runTurn("hello");
    await session.flushEventLog();
    const messages = ws.sent.map((s) => JSON.parse(s));
    const eventKinds = messages.filter((m) => m.kind === "event").map((m) => m.event.type);
    expect(eventKinds).toContain("user.prompt.submitted");
    expect(eventKinds).toContain("assistant.message.completed");
    expect(eventKinds).toContain("turn.completed");
    await bridge.detach();
  });

  it("invokes runTurn from a client command and replies with ok response", async () => {
    const events = new EventBus();
    const session = await createAgentSession({
      settings: settingsForCliAgent(),
      cwd,
      sessionId: "bridge-2",
      events
    });
    const ws = fakeWs();
    attachBridge({ session, ws });
    ws.emit("message", JSON.stringify({ kind: "command", command: "runTurn", id: "req-1", args: { prompt: "hello world" } }));
    const deadline = Date.now() + 8000;
    let response;
    while (Date.now() < deadline) {
      response = ws.sent.map((s) => JSON.parse(s)).find((m) => m.kind === "response" && m.id === "req-1");
      if (response) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await session.flushEventLog();
    expect(response).toEqual({ kind: "response", id: "req-1", ok: true, result: { ok: true } });
    const transcript = session.messages.map((m) => m.role);
    expect(transcript).toContain("user");
    expect(transcript).toContain("assistant");
  });

  it("returns ok=false when the command shape is invalid", async () => {
    const events = new EventBus();
    const session = await createAgentSession({
      settings: settingsForCliAgent(),
      cwd,
      sessionId: "bridge-3",
      events
    });
    const ws = fakeWs();
    attachBridge({ session, ws });
    ws.emit("message", JSON.stringify({ kind: "command", command: "runTurn", id: "req-2", args: { prompt: "" } }));
    await flushIo();
    const responses = ws.sent.map((s) => JSON.parse(s)).filter((m) => m.kind === "response");
    expect(responses[0]).toMatchObject({ kind: "response", id: "req-2", ok: false });
    expect(responses[0].error).toMatch(/prompt is required/);
  });

  it("emits an error message when the payload is not parseable JSON", async () => {
    const events = new EventBus();
    const session = await createAgentSession({
      settings: settingsForCliAgent(),
      cwd,
      sessionId: "bridge-4",
      events
    });
    const ws = fakeWs();
    attachBridge({ session, ws });
    ws.emit("message", "not-json");
    await flushIo();
    const errors = ws.sent.map((s) => JSON.parse(s)).filter((m) => m.kind === "error");
    expect(errors[0]).toMatchObject({ kind: "error", error: "invalid message", fatal: false });
  });
});

describe("serve bridge — listSessions dispatch", () => {
  it("returns the sorted page and a nextCursor when more sessions exist", async () => {
    for (let i = 0; i < 5; i += 1) {
      await saveSessionState({
        sessionId: `sess-${i}`,
        state: {
          title: `t${i}`,
          cwd,
          provider: "p",
          model: "m",
          updatedAt: `2026-05-0${i + 1}T00:00:00.000Z`,
          messages: []
        }
      });
    }
    const session = await createAgentSession({ settings: settingsForCliAgent(), cwd, sessionId: "current", events: new EventBus() });
    const ws = fakeWs();
    attachBridge({ session, ws, cwd });
    ws.emit("message", JSON.stringify({ kind: "command", command: "listSessions", id: "L1", args: { limit: 2 } }));
    await waitFor(() => ws.sent.some((s) => JSON.parse(s).id === "L1"));
    const response = ws.sent.map((s) => JSON.parse(s)).find((m) => m.kind === "response" && m.id === "L1");
    expect(response.ok).toBe(true);
    expect(response.result.sessions).toHaveLength(2);
    expect(response.result.sessions[0].sessionId).toBe("sess-4");
    expect(response.result.sessions[1].sessionId).toBe("sess-3");
    expect(typeof response.result.nextCursor).toBe("string");

    ws.sent.length = 0;
    ws.emit("message", JSON.stringify({ kind: "command", command: "listSessions", id: "L2", args: { limit: 10, cursor: response.result.nextCursor } }));
    await waitFor(() => ws.sent.some((s) => JSON.parse(s).id === "L2"));
    const next = ws.sent.map((s) => JSON.parse(s)).find((m) => m.kind === "response" && m.id === "L2");
    expect(next.ok).toBe(true);
    expect(next.result.sessions.map((s) => s.sessionId)).toEqual(["sess-2", "sess-1", "sess-0"]);
    expect(next.result.nextCursor).toBeNull();
  });

  it("rejects out-of-range limit with invalid_args", async () => {
    const session = await createAgentSession({ settings: settingsForCliAgent(), cwd, sessionId: "L-limit", events: new EventBus() });
    const ws = fakeWs();
    attachBridge({ session, ws, cwd });
    ws.emit("message", JSON.stringify({ kind: "command", command: "listSessions", id: "Lbad", args: { limit: 0 } }));
    await waitFor(() => ws.sent.some((s) => JSON.parse(s).id === "Lbad"));
    const response = ws.sent.map((s) => JSON.parse(s)).find((m) => m.kind === "response" && m.id === "Lbad");
    expect(response).toMatchObject({ ok: false });
    expect(response.error.code).toBe("invalid_args");
    expect(response.error.message).toMatch(/limit/);
  });

  it("rejects non-string cursor with invalid_args", async () => {
    const session = await createAgentSession({ settings: settingsForCliAgent(), cwd, sessionId: "L-cur", events: new EventBus() });
    const ws = fakeWs();
    attachBridge({ session, ws, cwd });
    ws.emit("message", JSON.stringify({ kind: "command", command: "listSessions", id: "Lcur", args: { cursor: 42 } }));
    await waitFor(() => ws.sent.some((s) => JSON.parse(s).id === "Lcur"));
    const response = ws.sent.map((s) => JSON.parse(s)).find((m) => m.kind === "response" && m.id === "Lcur");
    expect(response).toMatchObject({ ok: false });
    expect(response.error.code).toBe("invalid_args");
    expect(response.error.message).toMatch(/cursor/);
  });
});

describe("serve bridge — loadSession dispatch", () => {
  it("treats loadSession with the same sessionId as a no-op and does not broadcast session.resumed", async () => {
    const session = await createAgentSession({ settings: settingsForCliAgent(), cwd, sessionId: "noop", events: new EventBus() });
    const ws = fakeWs();
    let factoryCalls = 0;
    attachBridge({
      session,
      ws,
      cwd,
      settings: settingsForCliAgent(),
      sessionFactory: async () => { factoryCalls += 1; return session; }
    });
    ws.emit("message", JSON.stringify({ kind: "command", command: "loadSession", id: "N1", args: { sessionId: "noop" } }));
    await waitFor(() => ws.sent.some((s) => JSON.parse(s).id === "N1"));
    const messages = ws.sent.map((s) => JSON.parse(s));
    const response = messages.find((m) => m.kind === "response" && m.id === "N1");
    expect(response.ok).toBe(true);
    expect(response.result.sessionId).toBe("noop");
    expect(factoryCalls).toBe(0);
    expect(messages.some((m) => m.kind === "event" && m.event?.type === "session.resumed")).toBe(false);
  });

  it("rejects sessionId omission / empty / non-string with invalid_args", async () => {
    const session = await createAgentSession({ settings: settingsForCliAgent(), cwd, sessionId: "v1", events: new EventBus() });
    const ws = fakeWs();
    attachBridge({ session, ws, cwd, settings: settingsForCliAgent(), sessionFactory: async () => session });
    ws.emit("message", JSON.stringify({ kind: "command", command: "loadSession", id: "V1", args: {} }));
    ws.emit("message", JSON.stringify({ kind: "command", command: "loadSession", id: "V2", args: { sessionId: "" } }));
    ws.emit("message", JSON.stringify({ kind: "command", command: "loadSession", id: "V3", args: { sessionId: 123 } }));
    await waitFor(() => ws.sent.filter((s) => JSON.parse(s).kind === "response").length >= 3);
    const responses = ws.sent.map((s) => JSON.parse(s)).filter((m) => m.kind === "response");
    for (const response of responses) {
      expect(response.ok).toBe(false);
      expect(response.error.code).toBe("invalid_args");
      expect(response.error.message).toMatch(/sessionId/);
    }
  });

  it("returns session_not_found when the factory throws No session found", async () => {
    const session = await createAgentSession({ settings: settingsForCliAgent(), cwd, sessionId: "live", events: new EventBus() });
    const ws = fakeWs();
    attachBridge({
      session,
      ws,
      cwd,
      settings: settingsForCliAgent(),
      sessionFactory: async () => { throw new Error("No session found: missing"); }
    });
    ws.emit("message", JSON.stringify({ kind: "command", command: "loadSession", id: "M1", args: { sessionId: "missing" } }));
    await waitFor(() => ws.sent.some((s) => JSON.parse(s).id === "M1"));
    const response = ws.sent.map((s) => JSON.parse(s)).find((m) => m.kind === "response" && m.id === "M1");
    expect(response.ok).toBe(false);
    expect(response.error.code).toBe("session_not_found");
  });

  it("returns initialize_failed and keeps the live session attached when factory throws", async () => {
    const session = await createAgentSession({ settings: settingsForCliAgent(), cwd, sessionId: "live2", events: new EventBus() });
    const ws = fakeWs();
    attachBridge({
      session,
      ws,
      cwd,
      settings: settingsForCliAgent(),
      sessionFactory: async () => { throw new Error("boom during initialize"); }
    });
    ws.emit("message", JSON.stringify({ kind: "command", command: "loadSession", id: "I1", args: { sessionId: "broken" } }));
    await waitFor(() => ws.sent.some((s) => JSON.parse(s).id === "I1"));
    const response = ws.sent.map((s) => JSON.parse(s)).find((m) => m.kind === "response" && m.id === "I1");
    expect(response.ok).toBe(false);
    expect(response.error.code).toBe("initialize_failed");
    expect(response.error.message).toMatch(/boom/);

    ws.sent.length = 0;
    await session.runTurn("ping");
    await session.flushEventLog();
    const events = ws.sent.map((s) => JSON.parse(s)).filter((m) => m.kind === "event").map((m) => m.event.type);
    expect(events).toContain("user.prompt.submitted");
  });

  it("broadcasts session.resumed BEFORE the response and rebinds the bridge", async () => {
    await saveSessionState({
      sessionId: "old",
      state: {
        title: "previous",
        cwd,
        provider: "p",
        model: "m",
        updatedAt: "2026-05-01T00:00:00.000Z",
        messages: [
          { role: "user", content: "hi", id: "m1", sessionId: "old" },
          { role: "assistant", content: "hello", id: "m2", sessionId: "old" }
        ],
        eventCount: 4
      }
    });
    const liveSession = await createAgentSession({ settings: settingsForCliAgent(), cwd, sessionId: "live3", events: new EventBus() });
    const ws = fakeWs();
    attachBridge({
      session: liveSession,
      ws,
      cwd,
      settings: settingsForCliAgent(),
      sessionFactory: async ({ sessionId }) => {
        const state = await loadSessionState({ sessionId });
        return createAgentSession({
          settings: settingsForCliAgent(),
          cwd,
          sessionId,
          messages: state.messages ?? [],
          title: state.title,
          events: new EventBus()
        });
      }
    });
    ws.emit("message", JSON.stringify({ kind: "command", command: "loadSession", id: "R1", args: { sessionId: "old" } }));
    await waitFor(() => ws.sent.some((s) => JSON.parse(s).id === "R1"));
    const all = ws.sent.map((s) => JSON.parse(s));
    const resumedIdx = all.findIndex((m) => m.kind === "event" && m.event?.type === "session.resumed");
    const responseIdx = all.findIndex((m) => m.kind === "response" && m.id === "R1");
    expect(resumedIdx).toBeGreaterThanOrEqual(0);
    expect(responseIdx).toBeGreaterThan(resumedIdx);
    const resumed = all[resumedIdx];
    expect(resumed.event.sessionId).toBe("old");
    expect(resumed.event.messageCount).toBe(2);
    expect(Array.isArray(resumed.event.messages)).toBe(true);
    expect(resumed.event.messages.length).toBeGreaterThan(0);
    const response = all[responseIdx];
    expect(response.ok).toBe(true);
    expect(response.result).toEqual({ sessionId: "old", messageCount: 2, eventCount: resumed.event.eventCount });
  });

  it("rejects a runTurn command while a turn is already in flight (turn_in_progress)", async () => {
    const events = new EventBus();
    const session = await createAgentSession({
      settings: settingsForCliAgent(),
      cwd,
      sessionId: "bridge-reentry",
      events
    });
    // Simulate an in-flight turn on the shared session instance (the real cause
    // is a second WS / reconnect-resend hitting the same liveSession).
    session.runningTurn = true;
    const ws = fakeWs();
    const bridge = attachBridge({ session, ws, version: "0.0.1" });
    ws.sent.length = 0; // drop the ready frame so we only inspect the response

    ws.emit("message", JSON.stringify({ kind: "command", command: "runTurn", id: "T1", args: { prompt: "second" } }));
    await waitFor(() => ws.sent.some((s) => JSON.parse(s).id === "T1"));

    const response = ws.sent.map((s) => JSON.parse(s)).find((m) => m.id === "T1");
    expect(response.kind).toBe("response");
    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({ code: "turn_in_progress" });
    // The guard short-circuits BEFORE invoking the provider: no turn started.
    const eventKinds = ws.sent.map((s) => JSON.parse(s)).filter((m) => m.kind === "event").map((m) => m.event.type);
    expect(eventKinds).not.toContain("assistant.message.started");

    session.runningTurn = false;
    await bridge.detach();
  });
});
