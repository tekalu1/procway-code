// Regression test for the turn idle watchdog (AgentSession.runTurn).
//
// A turn that emits NO agent event for the idle window is stalled — e.g. an
// upstream that keeps the HTTP stream alive (so llm-fetch's inter-chunk
// bodyTimeout never trips) yet produces no tokens. The watchdog aborts such a
// turn so it surfaces as turn.failed (retryable) instead of hanging at
// "model waiting" forever. Uses a real cli-agent fixture that consumes its
// request and never responds (no mocks), with a short idle window so the test
// is fast.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSession } from "../src/agent/conversation.mjs";
import { EventBus } from "../src/core/events/bus.mjs";

const hangBin = fileURLToPath(new URL("./fixtures/cli-agent-hang.mjs", import.meta.url));

describe("AgentSession.runTurn idle watchdog", () => {
  let savedIdle;
  beforeEach(() => { savedIdle = process.env.PROCWAY_TURN_IDLE_TIMEOUT_MS; });
  afterEach(() => {
    if (savedIdle === undefined) delete process.env.PROCWAY_TURN_IDLE_TIMEOUT_MS;
    else process.env.PROCWAY_TURN_IDLE_TIMEOUT_MS = savedIdle;
  });

  it("aborts a turn that produces no progress within the idle window and surfaces turn.failed", async () => {
    // Short idle window; keep the agent's own timeout FAR higher so a pass
    // proves the WATCHDOG fired (not the cli-agent timeout).
    process.env.PROCWAY_TURN_IDLE_TIMEOUT_MS = "400";
    const cwd = await mkdtemp(path.join(os.tmpdir(), "procway-idle-"));
    const session = new AgentSession({
      settings: {
        defaultProvider: "hang-agent",
        approvalMode: "auto-readonly",
        agents: { defaultTimeoutMs: 30_000 },
        tools: { maxToolRounds: 1, maxParallelTools: 1 },
        providers: { "hang-agent": { type: "cli-agent", command: process.execPath, args: [hangBin], stdinMode: "json" } },
        session: { enabled: false }
      },
      cwd,
      sessionId: "s-idle-1",
      events: new EventBus()
    });
    await session.initialize();
    session.messages = [];

    const failed = [];
    session.events.on("turn.failed", (e) => failed.push(e));

    const t0 = Date.now();
    // runTurn rejects when the aborted provider call throws; swallow so we can
    // assert on the emitted events + timing.
    await session.runTurn("hello").catch(() => {});
    const elapsedMs = Date.now() - t0;

    expect(failed.length).toBeGreaterThanOrEqual(1);
    // Watchdog (400ms) fired well before the agent's 30s timeout would have.
    expect(elapsedMs).toBeLessThan(10_000);
    expect(session.runningTurn).toBe(false);
    // The abort is mapped to a clear, distinguishable message/code — NOT the raw
    // DOMException "This operation was aborted" (and NOT the user-Stop wording).
    expect(failed[0].error.code).toBe("idle_timeout");
    expect(failed[0].error.message).toContain("中断");
    expect(failed[0].error.message).not.toContain("operation was aborted");

    await rm(cwd, { recursive: true, force: true });
  }, 20_000);

  it("does NOT abort a fast, healthy turn (watchdog is a safety net, not a per-turn cap)", async () => {
    // A generous window (the default-ish) must never trip on a quick turn.
    process.env.PROCWAY_TURN_IDLE_TIMEOUT_MS = "5000";
    const echoBin = fileURLToPath(new URL("./fixtures/cli-agent-echo.mjs", import.meta.url));
    const cwd = await mkdtemp(path.join(os.tmpdir(), "procway-idle-ok-"));
    const session = new AgentSession({
      settings: {
        defaultProvider: "echo-agent",
        approvalMode: "auto-readonly",
        agents: { defaultTimeoutMs: 10_000 },
        tools: { maxToolRounds: 1, maxParallelTools: 1 },
        providers: { "echo-agent": { type: "cli-agent", command: process.execPath, args: [echoBin], stdinMode: "json" } },
        session: { enabled: false }
      },
      cwd,
      sessionId: "s-idle-ok",
      events: new EventBus()
    });
    await session.initialize();
    session.messages = [];

    const failed = [];
    session.events.on("turn.failed", (e) => failed.push(e));

    await session.runTurn("hello");

    expect(failed).toHaveLength(0); // healthy turn, no watchdog abort
    expect(session.runningTurn).toBe(false);

    await rm(cwd, { recursive: true, force: true });
  }, 20_000);
});
