import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "../src/agent/loop.mjs";
import { EventBus } from "../src/core/index.mjs";
import { getSharedJobRegistry } from "../src/jobs/delegated-jobs.mjs";
import {
  DEFAULT_WAKE_DRAIN_MAX_TURNS,
  DEFAULT_WAKE_DRAIN_TIMEOUT_MS,
  drainWakeWork,
  formatWakeDrainAbandonNotice,
  resolveWakeDrainLimits
} from "../src/agent/wake-drain.mjs";

// event-wake (issue #143) — the `-p` surface's terminating condition. The unit
// under test is the wait loop, so the supervisor is a hand-driven fake: the
// test decides when work settles and when a wake is injected, and a fake clock
// makes the deadline deterministic (no real waiting).

/** A supervisor stub with the two methods the drain uses. */
function fakeSupervisor({ outstanding = false } = {}) {
  const state = { outstanding, injector: null };
  return {
    state,
    hasOutstanding: () => state.outstanding === true,
    setInjector(fn) { state.injector = fn; return this; },
    /** Simulate the supervisor firing a wake batch (detached, like the real one). */
    fire(text = "<wake>") { return state.injector?.(text); }
  };
}

/** A fake clock whose `sleep` advances time and lets queued work run. */
function fakeClock({ step = 100 } = {}) {
  const state = { nowMs: 1_000 };
  return {
    state,
    now: () => state.nowMs,
    sleep: async (ms) => {
      state.nowMs += Math.max(ms, step);
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
}

describe("wake drain — `-p` waits for uncollected background work", () => {
  it("returns immediately when nothing is outstanding", async () => {
    const supervisor = fakeSupervisor({ outstanding: false });
    const clock = fakeClock();
    const result = await drainWakeWork({
      supervisor,
      injectTurn: async () => {},
      now: clock.now,
      sleep: clock.sleep
    });
    expect(result).toEqual({ turns: 0, reason: "settled" });
    // The clock never moved: no polling happened at all.
    expect(clock.state.nowMs).toBe(1_000);
  });

  it("waits while work is outstanding and runs the wake turns the supervisor injects", async () => {
    const supervisor = fakeSupervisor({ outstanding: true });
    const clock = fakeClock();
    const injected = [];
    let polls = 0;

    const drain = drainWakeWork({
      supervisor,
      injectTurn: async (text) => { injected.push(text); },
      now: clock.now,
      sleep: async (ms) => {
        polls += 1;
        // After a couple of polls the background job settles and the
        // supervisor injects its wake; the work is only collected once that
        // wake turn has run.
        if (polls === 2) {
          await supervisor.fire("<system-reminder>child finished</system-reminder>");
          supervisor.state.outstanding = false;
        }
        await clock.sleep(ms);
      }
    });

    const result = await drain;
    expect(result).toEqual({ turns: 1, reason: "settled" });
    expect(injected).toEqual(["<system-reminder>child finished</system-reminder>"]);
  });

  it("does not return while an injected wake turn is still running", async () => {
    // hasOutstanding() goes false the moment the batch leaves the supervisor's
    // queue — i.e. WHILE its turn is still executing. Returning there would let
    // the caller reap the background shells out from under a live turn.
    const supervisor = fakeSupervisor({ outstanding: true });
    const clock = fakeClock();
    let releaseTurn;
    const turnGate = new Promise((resolve) => { releaseTurn = resolve; });
    const order = [];
    let fired = false;

    const drain = drainWakeWork({
      supervisor,
      injectTurn: async () => {
        order.push("turn-start");
        await turnGate;
        order.push("turn-end");
      },
      now: clock.now,
      sleep: async (ms) => {
        if (!fired) {
          fired = true;
          supervisor.state.outstanding = false;
          void supervisor.fire();       // detached, exactly like the real fire()
          await new Promise((resolve) => setImmediate(resolve));
        }
        await clock.sleep(ms);
      }
    });

    let settled = false;
    void drain.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["turn-start"]);
    expect(settled).toBe(false);

    releaseTurn();
    const result = await drain;
    expect(order).toEqual(["turn-start", "turn-end"]);
    expect(result).toEqual({ turns: 1, reason: "settled" });
  });

  it("gives up at the wake-turn limit and reports it", async () => {
    // A model that starts new background work on every wake would loop forever.
    const supervisor = fakeSupervisor({ outstanding: true });
    const clock = fakeClock();
    const abandoned = [];

    const result = await drainWakeWork({
      supervisor,
      maxTurns: 3,
      injectTurn: async () => {},
      now: clock.now,
      sleep: async (ms) => {
        await supervisor.fire();  // every poll settles a batch and starts new work
        await clock.sleep(ms);
      },
      onAbandon: (info) => abandoned.push(info)
    });

    expect(result).toEqual({ turns: 3, reason: "turn-limit" });
    expect(abandoned).toEqual([{ reason: "turn-limit", turns: 3 }]);
  });

  it("gives up at the wall-clock deadline when nothing can ever settle here", async () => {
    // A background `start_run` settles in the HOST's registry; its wake arrives
    // over the serve bridge, which a `-p` process does not have. Only the
    // deadline can end that wait.
    const supervisor = fakeSupervisor({ outstanding: true });
    const clock = fakeClock({ step: 250 });
    const abandoned = [];

    const result = await drainWakeWork({
      supervisor,
      timeoutMs: 1_000,
      injectTurn: async () => {},
      now: clock.now,
      sleep: clock.sleep,
      onAbandon: (info) => abandoned.push(info)
    });

    expect(result).toEqual({ turns: 0, reason: "deadline" });
    expect(abandoned).toEqual([{ reason: "deadline", turns: 0 }]);
    expect(clock.state.nowMs).toBeGreaterThanOrEqual(2_000);
  });

  it("is a no-op for a session without a supervisor, and when disabled", async () => {
    expect(await drainWakeWork({ supervisor: null })).toEqual({ turns: 0, reason: "no-supervisor" });
    const supervisor = fakeSupervisor({ outstanding: true });
    expect(await drainWakeWork({ supervisor, timeoutMs: 0 })).toEqual({ turns: 0, reason: "disabled" });
    expect(await drainWakeWork({ supervisor, maxTurns: 0 })).toEqual({ turns: 0, reason: "disabled" });
    // Disabled means the injector was never swapped either.
    expect(supervisor.state.injector).toBeNull();
  });

  it("reads its bounds from the environment with documented defaults", () => {
    expect(resolveWakeDrainLimits({})).toEqual({
      maxTurns: DEFAULT_WAKE_DRAIN_MAX_TURNS,
      timeoutMs: DEFAULT_WAKE_DRAIN_TIMEOUT_MS
    });
    expect(resolveWakeDrainLimits({
      PROCWAY_WAKE_DRAIN_MAX_TURNS: "3",
      PROCWAY_WAKE_DRAIN_TIMEOUT_MS: "1500"
    })).toEqual({ maxTurns: 3, timeoutMs: 1500 });
    // `0` is a legal value (disables the drain); junk falls back to the default.
    expect(resolveWakeDrainLimits({ PROCWAY_WAKE_DRAIN_TIMEOUT_MS: "0" }).timeoutMs).toBe(0);
    expect(resolveWakeDrainLimits({ PROCWAY_WAKE_DRAIN_TIMEOUT_MS: "nope" }).timeoutMs)
      .toBe(DEFAULT_WAKE_DRAIN_TIMEOUT_MS);
    expect(resolveWakeDrainLimits({ PROCWAY_WAKE_DRAIN_MAX_TURNS: "-2" }).maxTurns)
      .toBe(DEFAULT_WAKE_DRAIN_MAX_TURNS);
  });

  it("names the env knob in the give-up notice", () => {
    expect(formatWakeDrainAbandonNotice({ reason: "deadline", turns: 2 }))
      .toContain("PROCWAY_WAKE_DRAIN_TIMEOUT_MS");
    expect(formatWakeDrainAbandonNotice({ reason: "turn-limit", turns: 20 }))
      .toContain("PROCWAY_WAKE_DRAIN_MAX_TURNS");
  });
});

// The `-p` entry point itself: `runAgent` must not return (and therefore the
// caller in cli.mjs must not reap the background shells) while the session
// still has uncollected background work.

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

describe("runAgent (`-p`) — drains before it returns", () => {
  let cwd;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "procway-wake-drain-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("waits for a background child to settle, runs its wake turn, and only then returns", async () => {
    const registry = getSharedJobRegistry();
    const events = new EventBus();
    const completions = [];
    events.on("assistant.message.completed", () => completions.push(Date.now()));

    // A hand-driven background job of THIS session (what
    // `spawn_agent runInBackground:true` registers), spawned as soon as the
    // session id is known — it must be running when the first turn ends.
    let settle = null;
    let spawned = null;
    events.on("*", (event) => {
      if (spawned || !event?.sessionId) return;
      spawned = registry.spawnJob({
        kind: "spawn_agent",
        spec: {},
        meta: { sessionId: event.sessionId, wake: true, task: "background child" },
        driver: {
          start(_spec, { onYield }) {
            settle = () => onYield({ status: "completed", result: { text: "child result" } });
            return { kill: () => {} };
          }
        }
      });
    });

    let returned = false;
    const run = runAgent({ settings: settingsForCliAgent(), prompt: "hello", cwd, events })
      .then((value) => { returned = true; return value; });

    // The first turn is over (one assistant message) but the child is still
    // running: runAgent must still be waiting.
    await waitFor(() => completions.length >= 1 && spawned);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(returned).toBe(false);

    settle();
    const result = await run;

    expect(result.drain).toEqual({ turns: 1, reason: "settled" });
    // Two turns ran in total: the user's prompt and the wake it produced.
    expect(completions.length).toBe(2);
    expect(registry.getJob(spawned.jobId)?.status).toBe("completed");
  }, 20_000);

  it("returns straight away when no background work was started", async () => {
    const events = new EventBus();
    const result = await runAgent({ settings: settingsForCliAgent(), prompt: "hello", cwd, events });
    expect(result.drain).toEqual({ turns: 0, reason: "settled" });
    expect(result.text).toContain("echo:");
  }, 20_000);
});

async function waitFor(predicate, { timeoutMs = 10_000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("waitFor: timed out");
}
