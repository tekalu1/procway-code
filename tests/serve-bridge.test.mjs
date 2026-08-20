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

  it("defaults a worker-origin runTurn to full-auto approval mode", async () => {
    const session = await createAgentSession({
      settings: settingsForCliAgent(),
      cwd,
      sessionId: "bridge-worker",
      events: new EventBus()
    });
    session.origin = "worker";
    const seen = [];
    session.runTurn = async (prompt, options) => { seen.push({ prompt, options }); };
    const ws = fakeWs();
    attachBridge({ session, ws });
    ws.emit("message", JSON.stringify({ kind: "command", command: "runTurn", id: "W1", args: { prompt: "do work" } }));
    await waitFor(() => ws.sent.some((s) => JSON.parse(s).id === "W1"));
    expect(seen).toHaveLength(1);
    expect(seen[0].options.approvalMode).toBe("full-auto");
  });

  it("lets an explicit approvalMode win over the worker-origin default", async () => {
    const session = await createAgentSession({
      settings: settingsForCliAgent(),
      cwd,
      sessionId: "bridge-worker-explicit",
      events: new EventBus()
    });
    session.origin = "worker";
    const seen = [];
    session.runTurn = async (prompt, options) => { seen.push({ prompt, options }); };
    const ws = fakeWs();
    attachBridge({ session, ws });
    ws.emit("message", JSON.stringify({ kind: "command", command: "runTurn", id: "W2", args: { prompt: "do work", options: { approvalMode: "always-ask" } } }));
    await waitFor(() => ws.sent.some((s) => JSON.parse(s).id === "W2"));
    expect(seen[0].options.approvalMode).toBe("always-ask");
  });

  it("does not inject an approval mode for non-worker sessions", async () => {
    const session = await createAgentSession({
      settings: settingsForCliAgent(),
      cwd,
      sessionId: "bridge-user-origin",
      events: new EventBus()
    });
    // origin defaults to null (user session)
    const seen = [];
    session.runTurn = async (prompt, options) => { seen.push({ prompt, options }); };
    const ws = fakeWs();
    attachBridge({ session, ws });
    ws.emit("message", JSON.stringify({ kind: "command", command: "runTurn", id: "W3", args: { prompt: "hi" } }));
    await waitFor(() => ws.sent.some((s) => JSON.parse(s).id === "W3"));
    expect(seen[0].options.approvalMode).toBeUndefined();
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

  it("replays the persisted todo list as todos.updated on attach, after session.resumed", async () => {
    const session = await createAgentSession({
      settings: settingsForCliAgent(),
      cwd,
      sessionId: "todos-attach",
      events: new EventBus(),
      messages: [
        { role: "user", content: "hi", id: "m1", sessionId: "todos-attach" },
        { role: "assistant", content: "hello", id: "m2", sessionId: "todos-attach" }
      ]
    });
    session.todoStore.set([
      { id: "t1", content: "step one", status: "completed", activeForm: "doing step one" },
      { id: "t2", content: "step two", status: "in_progress", activeForm: "doing step two" }
    ]);
    const ws = fakeWs();
    const bridge = attachBridge({ session, ws });
    const all = ws.sent.map((s) => JSON.parse(s));
    const resumedIdx = all.findIndex((m) => m.kind === "event" && m.event?.type === "session.resumed");
    const todosIdx = all.findIndex((m) => m.kind === "event" && m.event?.type === "todos.updated");
    expect(resumedIdx).toBeGreaterThanOrEqual(0);
    // The client wipes its todo panel when session.resumed lands, so the
    // replay must arrive after it or the list is cleared right back out.
    expect(todosIdx).toBeGreaterThan(resumedIdx);
    expect(all[todosIdx].event.sessionId).toBe("todos-attach");
    expect(all[todosIdx].event.todos).toEqual([
      expect.objectContaining({ id: "t1", content: "step one", status: "completed" }),
      expect.objectContaining({ id: "t2", content: "step two", status: "in_progress" })
    ]);
    await bridge.detach();
  });

  it("does not send todos.updated on attach when the session has no todos", async () => {
    const session = await createAgentSession({
      settings: settingsForCliAgent(),
      cwd,
      sessionId: "todos-empty",
      events: new EventBus()
    });
    const ws = fakeWs();
    const bridge = attachBridge({ session, ws });
    const events = ws.sent.map((s) => JSON.parse(s)).filter((m) => m.kind === "event").map((m) => m.event.type);
    expect(events).not.toContain("todos.updated");
    await bridge.detach();
  });

  it("re-announces the loaded session's todos after loadSession's session.resumed", async () => {
    await saveSessionState({
      sessionId: "old-todos",
      state: {
        title: "previous",
        cwd,
        provider: "p",
        model: "m",
        updatedAt: "2026-05-01T00:00:00.000Z",
        messages: [
          { role: "user", content: "hi", id: "m1", sessionId: "old-todos" },
          { role: "assistant", content: "hello", id: "m2", sessionId: "old-todos" }
        ],
        eventCount: 4
      }
    });
    const liveSession = await createAgentSession({ settings: settingsForCliAgent(), cwd, sessionId: "live-todos", events: new EventBus() });
    const ws = fakeWs();
    attachBridge({
      session: liveSession,
      ws,
      cwd,
      settings: settingsForCliAgent(),
      sessionFactory: async ({ sessionId }) => {
        const state = await loadSessionState({ sessionId });
        const next = await createAgentSession({
          settings: settingsForCliAgent(),
          cwd,
          sessionId,
          messages: state.messages ?? [],
          title: state.title,
          events: new EventBus()
        });
        next.todoStore.todos = [
          { id: "t9", content: "restored step", status: "pending", activeForm: "restoring step" }
        ];
        return next;
      }
    });
    ws.emit("message", JSON.stringify({ kind: "command", command: "loadSession", id: "R2", args: { sessionId: "old-todos" } }));
    await waitFor(() => ws.sent.some((s) => JSON.parse(s).id === "R2"));
    const all = ws.sent.map((s) => JSON.parse(s));
    const resumedIdx = all.findIndex((m) => m.kind === "event" && m.event?.type === "session.resumed");
    const todosIdx = all.findIndex((m) => m.kind === "event" && m.event?.type === "todos.updated");
    expect(resumedIdx).toBeGreaterThanOrEqual(0);
    expect(todosIdx).toBeGreaterThan(resumedIdx);
    expect(all[todosIdx].event.sessionId).toBe("old-todos");
    expect(all[todosIdx].event.todos).toEqual([
      expect.objectContaining({ id: "t9", content: "restored step", status: "pending" })
    ]);
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

// event-wake (issue #143) — the `wake` command. The whole point of it being a
// command of its own (and not a runTurn) is that it is accepted while a turn is
// running: a settle pushed by the host must be QUEUED, never refused, because
// the refusal would be swallowed by the caller and the result lost.
describe("serve bridge — wake", () => {
  async function wakeSession(sessionId) {
    return createAgentSession({
      settings: settingsForCliAgent(),
      cwd,
      sessionId,
      events: new EventBus()
    });
  }

  function sendWake(ws, id, args) {
    ws.emit("message", JSON.stringify({ kind: "command", command: "wake", id, args }));
  }

  function responseFor(ws, id) {
    return ws.sent.map((raw) => JSON.parse(raw)).find((m) => m.id === id);
  }

  it("queues a pushed run settle onto the session's wake supervisor", async () => {
    const session = await wakeSession("bridge-wake-1");
    const ws = fakeWs();
    const bridge = attachBridge({ session, ws, version: "0.0.1" });
    ws.sent.length = 0;

    sendWake(ws, "W1", {
      source: "host",
      items: [{ jobId: "run-1", kind: "run", status: "completed", project: "acme", ticket: "TK-1" }]
    });
    await waitFor(() => responseFor(ws, "W1"));

    expect(responseFor(ws, "W1")).toMatchObject({
      kind: "response",
      ok: true,
      result: { queued: true, accepted: 1, deduped: 0 }
    });
    const pending = session.wakeSupervisor.__inspect().pending;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ jobId: "run-1", kind: "run", project: "acme", ticket: "TK-1" });

    session.wakeSupervisor.stop();
    await bridge.detach();
  });

  // Without this line a wake leaves NO evidence inside the Pod: the only proof
  // of delivery is the dashboard's own `woken_at` write plus the turn that
  // eventually shows up, which is how the first real-environment check had to
  // be done. One line, jobIds + accepted/deduped.
  it("logs one line per accepted wake (jobIds, accepted, deduped)", async () => {
    const session = await wakeSession("bridge-wake-log");
    const ws = fakeWs();
    const logs = [];
    const bridge = attachBridge({ session, ws, version: "0.0.1", logger: (msg) => logs.push(msg) });
    ws.sent.length = 0;

    sendWake(ws, "W-LOG", {
      source: "host",
      items: [
        { jobId: "run-log-1", kind: "run", status: "completed", project: "acme", ticket: "TK-1" },
        { jobId: "run-log-2", kind: "run", status: "awaiting-user-input", project: "acme", ticket: "TK-2" }
      ]
    });
    await waitFor(() => responseFor(ws, "W-LOG"));

    const line = logs.find((msg) => msg.includes("wake received"));
    expect(line).toBe("bridge: wake received jobs=2 run-log-1 +1 more accepted=2 deduped=0");

    session.wakeSupervisor.stop();
    await bridge.detach();
  });

  it("logs deduped wakes too, so a re-push is distinguishable from a lost one", async () => {
    const session = await wakeSession("bridge-wake-log-dupe");
    const ws = fakeWs();
    const logs = [];
    const bridge = attachBridge({ session, ws, version: "0.0.1", logger: (msg) => logs.push(msg) });
    session.wakeSupervisor.collect({ jobId: "run-log-3", status: "completed" });
    ws.sent.length = 0;

    sendWake(ws, "W-LOG2", {
      source: "host",
      items: [{ jobId: "run-log-3", kind: "run", status: "completed", project: "acme", ticket: "TK-3" }]
    });
    await waitFor(() => responseFor(ws, "W-LOG2"));

    expect(logs.find((msg) => msg.includes("wake received")))
      .toBe("bridge: wake received jobs=1 run-log-3 accepted=0 deduped=1");

    session.wakeSupervisor.stop();
    await bridge.detach();
  });

  it("accepts a wake WHILE a turn is in flight (never turn_in_progress)", async () => {
    const session = await wakeSession("bridge-wake-live");
    // Same simulation as the runTurn re-entrancy test above.
    session.runningTurn = true;
    const ws = fakeWs();
    const bridge = attachBridge({ session, ws, version: "0.0.1" });
    ws.sent.length = 0;

    sendWake(ws, "W2", { items: [{ jobId: "run-2", status: "completed", project: "p", ticket: "TK-2" }] });
    await waitFor(() => responseFor(ws, "W2"));

    const response = responseFor(ws, "W2");
    expect(response.ok).toBe(true);
    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({ queued: true, accepted: 1 });
    // Held, not injected: no turn may interleave with the running one.
    expect(session.wakeSupervisor.__inspect().pending).toHaveLength(1);
    expect(session.wakeSupervisor.hasOutstanding()).toBe(true);

    session.runningTurn = false;
    session.wakeSupervisor.stop();
    await bridge.detach();
  });

  it("counts a settle the turn already collected as deduped, not accepted", async () => {
    const session = await wakeSession("bridge-wake-dedupe");
    const ws = fakeWs();
    const bridge = attachBridge({ session, ws, version: "0.0.1" });
    ws.sent.length = 0;
    // attach_run / resume_run already delivered this yield inside the turn.
    session.wakeSupervisor.collect({ jobId: "run-3", project: "p", ticket: "TK-3", status: "completed" });

    sendWake(ws, "W3", {
      items: [
        { jobId: "run-3", status: "completed", project: "p", ticket: "TK-3" },
        { jobId: "run-4", status: "failed", project: "p", ticket: "TK-4" }
      ]
    });
    await waitFor(() => responseFor(ws, "W3"));

    expect(responseFor(ws, "W3").result).toEqual({ queued: true, accepted: 1, deduped: 1 });
    expect(session.wakeSupervisor.__inspect().pending.map((i) => i.jobId)).toEqual(["run-4"]);

    session.wakeSupervisor.stop();
    await bridge.detach();
  });

  it("reports queued:false when every pushed item was a duplicate", async () => {
    const session = await wakeSession("bridge-wake-alldupe");
    const ws = fakeWs();
    const bridge = attachBridge({ session, ws, version: "0.0.1" });
    ws.sent.length = 0;
    session.wakeSupervisor.collect({ jobId: "run-5", status: "completed" });

    sendWake(ws, "W4", { items: [{ jobId: "run-5", status: "completed" }] });
    await waitFor(() => responseFor(ws, "W4"));

    expect(responseFor(ws, "W4").result).toEqual({ queued: false, accepted: 0, deduped: 1 });

    session.wakeSupervisor.stop();
    await bridge.detach();
  });

  it("answers invalid_args for a malformed push", async () => {
    const session = await wakeSession("bridge-wake-bad");
    const ws = fakeWs();
    const bridge = attachBridge({ session, ws, version: "0.0.1" });
    ws.sent.length = 0;

    sendWake(ws, "W5", { items: [] });
    await waitFor(() => responseFor(ws, "W5"));
    expect(responseFor(ws, "W5")).toMatchObject({ ok: false, error: { code: "invalid_args" } });

    sendWake(ws, "W6", { items: [{ status: "completed" }] });
    await waitFor(() => responseFor(ws, "W6"));
    expect(responseFor(ws, "W6")).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(session.wakeSupervisor.__inspect().pending).toHaveLength(0);

    session.wakeSupervisor.stop();
    await bridge.detach();
  });

  it("answers wake_unavailable when the session has no supervisor", async () => {
    const session = await wakeSession("bridge-wake-none");
    session.wakeSupervisor?.stop();
    session.wakeSupervisor = null;
    const ws = fakeWs();
    const bridge = attachBridge({ session, ws, version: "0.0.1" });
    ws.sent.length = 0;

    sendWake(ws, "W7", { items: [{ jobId: "run-6", status: "completed" }] });
    await waitFor(() => responseFor(ws, "W7"));
    expect(responseFor(ws, "W7")).toMatchObject({ ok: false, error: { code: "wake_unavailable" } });

    await bridge.detach();
  });
});
