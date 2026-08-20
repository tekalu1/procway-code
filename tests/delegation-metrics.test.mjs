import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDelegationMetrics, METRICS_MARKER } from "../src/telemetry/delegation-metrics.mjs";
import { DelegatedJobRegistry } from "../src/jobs/delegated-jobs.mjs";
import { createWakeSupervisor } from "../src/agent/wake-supervisor.mjs";
import { executeToolCall } from "../src/tools/registry.mjs";
import { AgentSession } from "../src/agent/conversation.mjs";
import { EventBus } from "../src/core/events/bus.mjs";

// ADR 0029 追補 A1 E7 Phase 3 — the measurement behind "should background become
// the default?". Driven by plain dependency injection (fake clock, recording
// sink), matching wake-supervisor.test.mjs: no vi.fn mocks.

const ON = { PROCWAY_TELEMETRY: "on" };

function makeMetrics({ env = ON, sessionId = "s1" } = {}) {
  const lines = [];
  const state = { nowMs: 1_000 };
  const metrics = createDelegationMetrics({
    sessionId,
    env,
    now: () => state.nowMs,
    write: (line) => lines.push(line)
  });
  return {
    metrics,
    lines,
    state,
    advance(ms) { state.nowMs += ms; },
    lastPayload() {
      return lines.length === 0 ? null : JSON.parse(lines[lines.length - 1]);
    }
  };
}

describe("the telemetry switch", () => {
  it("hands back an inert no-op when PROCWAY_TELEMETRY is unset", () => {
    const { metrics, lines } = makeMetrics({ env: {} });
    expect(metrics.enabled).toBe(false);
    metrics.delegationStarted({ surface: "spawn_agent", background: true, jobId: "j1", cwd: "." });
    metrics.joinBlocked({ surface: "spawn_agent_foreground", ms: 5_000 });
    metrics.wakeQueued("j1");
    metrics.wakeInjected(["j1"]);
    metrics.collected("j1");
    expect(metrics.snapshot()).toBeNull();
    expect(metrics.flush()).toBe(false);
    // The whole point: an opt-in metric must produce NOTHING until opted in.
    expect(lines).toEqual([]);
  });

  it("stays off for the values that are not an opt-in", () => {
    for (const value of [undefined, "", "off", "0", "false", "no"]) {
      expect(createDelegationMetrics({ env: { PROCWAY_TELEMETRY: value } }).enabled).toBe(false);
    }
    for (const value of ["on", "1", "true", "yes", "ON", "True"]) {
      expect(createDelegationMetrics({ env: { PROCWAY_TELEMETRY: value } }).enabled).toBe(true);
    }
  });

  it("writes nothing for a session that never delegates", () => {
    const { metrics, lines } = makeMetrics();
    expect(metrics.flush()).toBe(false);
    expect(lines).toEqual([]);
  });
});

describe("1. usage split", () => {
  it("counts spawn_agent and start_run separately, foreground vs background", () => {
    const h = makeMetrics();
    h.metrics.delegationStarted({ surface: "spawn_agent", background: false });
    h.metrics.delegationStarted({ surface: "spawn_agent", background: true, jobId: "c1" });
    h.metrics.delegationStarted({ surface: "spawn_agent", background: true, jobId: "c2" });
    h.metrics.delegationStarted({ surface: "start_run", background: false });
    h.metrics.delegationStarted({ surface: "start_run", background: true, jobId: "r1" });
    h.metrics.flush();
    expect(h.lastPayload().usage).toEqual({
      spawn_agent: { foreground: 1, background: 2 },
      start_run: { foreground: 1, background: 1 }
    });
  });
});

describe("2. concurrency of uncollected background work", () => {
  it("pins the distribution at 1 when background work is always collected first", () => {
    const h = makeMetrics();
    for (const jobId of ["a", "b", "c"]) {
      h.metrics.delegationStarted({ surface: "spawn_agent", background: true, jobId });
      h.metrics.collected(jobId);
    }
    h.metrics.flush();
    const { concurrency } = h.lastPayload();
    // THE number the ADR turns on: serial background work looks exactly like
    // this, and it means backgrounding bought nothing.
    expect(concurrency.peak).toBe(1);
    expect(concurrency.histogram).toEqual({ 1: 3 });
    expect(concurrency.outstanding_now).toBe(0);
  });

  it("records the peak and the shape when work really overlaps", () => {
    const h = makeMetrics();
    h.metrics.delegationStarted({ surface: "spawn_agent", background: true, jobId: "a" });
    h.metrics.delegationStarted({ surface: "spawn_agent", background: true, jobId: "b" });
    h.metrics.delegationStarted({ surface: "start_run", background: true, jobId: "r" });
    h.metrics.collected("a");
    h.metrics.delegationStarted({ surface: "spawn_agent", background: true, jobId: "c" });
    h.metrics.flush();
    const { concurrency } = h.lastPayload();
    expect(concurrency.peak).toBe(3);
    expect(concurrency.histogram).toEqual({ 1: 1, 2: 1, 3: 2 });
    expect(concurrency.peak_by_surface).toEqual({ spawn_agent: 2, start_run: 1 });
    expect(concurrency.outstanding_now).toBe(3);
  });

  it("does not count foreground delegation as outstanding", () => {
    const h = makeMetrics();
    h.metrics.delegationStarted({ surface: "spawn_agent", background: false, jobId: "a" });
    h.metrics.delegationStarted({ surface: "start_run", background: false, jobId: "r" });
    h.metrics.flush();
    expect(h.lastPayload().concurrency).toMatchObject({ peak: 0, histogram: {}, outstanding_now: 0 });
  });

  it("folds a runaway fan-out into a bounded bucket", () => {
    const h = makeMetrics();
    for (let i = 0; i < 12; i += 1) {
      h.metrics.delegationStarted({ surface: "spawn_agent", background: true, jobId: `j${i}` });
    }
    h.metrics.flush();
    expect(h.lastPayload().concurrency.histogram[">10"]).toBe(2);
  });
});

describe("3. blocked JOIN wall clock", () => {
  it("separates the recoverable foreground blocks from the explicit joins", () => {
    const h = makeMetrics();
    h.metrics.joinBlocked({ surface: "spawn_agent_foreground", ms: 4_000 });
    h.metrics.joinBlocked({ surface: "spawn_agent_foreground", ms: 11_000 });
    h.metrics.joinBlocked({ surface: "start_run_foreground", ms: 60_000 });
    h.metrics.joinBlocked({ surface: "attach_run", ms: 30_000 });
    h.metrics.joinBlocked({ surface: "agent_job_wait", ms: 2_000 });
    h.metrics.flush();
    const payload = h.lastPayload();
    expect(payload.join_blocked_ms.spawn_agent_foreground).toEqual({ count: 2, total_ms: 15_000, max_ms: 11_000 });
    expect(payload.join_blocked_ms.attach_run).toEqual({ count: 1, total_ms: 30_000, max_ms: 30_000 });
    // attach_run / agent_job_wait join work that is ALREADY background, so they
    // are not wall clock a default flip could win back.
    expect(payload.recoverable_join_ms).toBe(75_000);
  });

  it("ignores a nonsense duration rather than poisoning the total", () => {
    const h = makeMetrics();
    h.metrics.joinBlocked({ surface: "spawn_agent_foreground", ms: 1_000 });
    h.metrics.joinBlocked({ surface: "spawn_agent_foreground", ms: -5 });
    h.metrics.joinBlocked({ surface: "spawn_agent_foreground", ms: NaN });
    h.metrics.joinBlocked({ surface: "nonexistent_surface", ms: 9_999 });
    h.metrics.flush();
    expect(h.lastPayload().join_blocked_ms.spawn_agent_foreground).toEqual({ count: 1, total_ms: 1_000, max_ms: 1_000 });
  });
});

describe("4. wake cost", () => {
  it("reports a coalesce ratio of 1.0 when nothing ever batched", () => {
    const h = makeMetrics();
    for (const jobId of ["a", "b", "c"]) {
      h.metrics.wakeQueued(jobId);
      h.metrics.wakeInjected([jobId]);
    }
    h.metrics.flush();
    const { wake } = h.lastPayload();
    expect(wake.turns).toBe(3);
    expect(wake.items).toBe(3);
    // 1.0 is the falsifier for "the debounce batches settles".
    expect(wake.coalesce_ratio).toBe(1);
    expect(wake.batch_histogram).toEqual({ 1: 3 });
  });

  it("measures the batch size and the settle→inject latency", () => {
    const h = makeMetrics();
    h.metrics.wakeQueued("a");
    h.advance(400);
    h.metrics.wakeQueued("b");
    h.advance(600);
    h.metrics.wakeInjected(["a", "b"]);
    h.metrics.flush();
    const { wake } = h.lastPayload();
    expect(wake.turns).toBe(1);
    expect(wake.items).toBe(2);
    expect(wake.coalesce_ratio).toBe(2);
    expect(wake.batch_histogram).toEqual({ 2: 1 });
    expect(wake.latency_ms).toEqual({ count: 2, total_ms: 1_600, max_ms: 1_000 });
  });

  it("splits out the latency of a run that woke us PAUSED for an answer", () => {
    const h = makeMetrics();
    h.metrics.wakeQueued("run-1");
    h.metrics.wakeQueued("child-1");
    h.advance(2_000);
    h.metrics.wakeInjected([
      { jobId: "run-1", kind: "run", status: "awaiting-user-input" },
      { jobId: "child-1", kind: "agent", status: "completed" }
    ]);
    h.metrics.flush();
    const { wake } = h.lastPayload();
    expect(wake.latency_ms.count).toBe(2);
    // A hearing waiting to be relayed is a delay the USER feels, so it must not
    // be averaged away against a finished child (ADR 0029 E7-P3, start_run).
    expect(wake.awaiting_run_latency_ms).toEqual({ count: 1, total_ms: 2_000, max_ms: 2_000 });
  });

  it("counts a failed injection without inventing a wake turn", () => {
    const h = makeMetrics();
    h.metrics.wakeQueued("a");
    h.metrics.wakeInjectFailed();
    h.metrics.flush();
    const { wake } = h.lastPayload();
    expect(wake.turns).toBe(0);
    expect(wake.inject_failures).toBe(1);
  });
});

describe("5. same-cwd hazard", () => {
  it("stays at zero when children never overlap", () => {
    const h = makeMetrics();
    for (const jobId of ["a", "b"]) {
      h.metrics.delegationStarted({ surface: "spawn_agent", background: true, jobId, cwd: ".", baseCwd: "/w" });
      h.metrics.childSettled(jobId);
    }
    h.metrics.flush();
    expect(h.lastPayload().hazard).toEqual({
      same_cwd_peak: 1,
      same_cwd_overlaps: 0,
      same_cwd_background_overlaps: 0,
      distinct_cwds: 1
    });
  });

  it("counts two background children writing one directory at the same time", () => {
    const h = makeMetrics();
    h.metrics.delegationStarted({ surface: "spawn_agent", background: true, jobId: "a", cwd: ".", baseCwd: "/w" });
    h.metrics.delegationStarted({ surface: "spawn_agent", background: true, jobId: "b", cwd: "./", baseCwd: "/w" });
    h.metrics.flush();
    const { hazard } = h.lastPayload();
    expect(hazard.same_cwd_peak).toBe(2);
    expect(hazard.same_cwd_overlaps).toBe(1);
    expect(hazard.same_cwd_background_overlaps).toBe(1);
    expect(hazard.distinct_cwds).toBe(1);
  });

  it("separates a foreground+background overlap from a background-only one", () => {
    const h = makeMetrics();
    h.metrics.delegationStarted({ surface: "spawn_agent", background: false, jobId: "fg", cwd: ".", baseCwd: "/w" });
    h.metrics.delegationStarted({ surface: "spawn_agent", background: true, jobId: "bg", cwd: ".", baseCwd: "/w" });
    h.metrics.flush();
    const { hazard } = h.lastPayload();
    expect(hazard.same_cwd_overlaps).toBe(1);
    // ADR E7 ① asks specifically about ≥2 BACKGROUND children.
    expect(hazard.same_cwd_background_overlaps).toBe(0);
  });

  it("does not treat children in different directories as a hazard", () => {
    const h = makeMetrics();
    h.metrics.delegationStarted({ surface: "spawn_agent", background: true, jobId: "a", cwd: "pkg-a", baseCwd: "/w" });
    h.metrics.delegationStarted({ surface: "spawn_agent", background: true, jobId: "b", cwd: "pkg-b", baseCwd: "/w" });
    h.metrics.flush();
    const { hazard } = h.lastPayload();
    expect(hazard.same_cwd_peak).toBe(1);
    expect(hazard.same_cwd_overlaps).toBe(0);
    expect(hazard.distinct_cwds).toBe(2);
  });

  it("releases the directory when a child settles, not when it is collected", () => {
    const h = makeMetrics();
    h.metrics.delegationStarted({ surface: "spawn_agent", background: true, jobId: "a", cwd: ".", baseCwd: "/w" });
    h.metrics.childSettled("a");
    // 'a' has stopped writing even though the model has not collected it yet.
    h.metrics.delegationStarted({ surface: "spawn_agent", background: true, jobId: "b", cwd: ".", baseCwd: "/w" });
    h.metrics.flush();
    const payload = h.lastPayload();
    expect(payload.hazard.same_cwd_overlaps).toBe(0);
    // …but it is still uncollected, so it still counts as concurrent for (2).
    expect(payload.concurrency.peak).toBe(2);
  });

  it("does not track runs — they execute on the host, not in this workspace", () => {
    const h = makeMetrics();
    h.metrics.delegationStarted({ surface: "start_run", background: true, jobId: "r1", cwd: ".", baseCwd: "/w" });
    h.metrics.delegationStarted({ surface: "start_run", background: true, jobId: "r2", cwd: ".", baseCwd: "/w" });
    h.metrics.flush();
    expect(h.lastPayload().hazard).toMatchObject({ same_cwd_peak: 0, distinct_cwds: 0 });
  });
});

describe("the emitted line", () => {
  it("carries the marker and no path, prompt or task text", () => {
    const h = makeMetrics();
    h.metrics.delegationStarted({
      surface: "spawn_agent",
      background: true,
      jobId: "job-1",
      cwd: "secret-project/apps/web",
      baseCwd: "/home/someone/work"
    });
    h.metrics.flush();
    const raw = h.lines[0];
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw)[METRICS_MARKER]).toBe(true);
    expect(JSON.parse(raw)).toMatchObject({ app: "ai-agent", metric: "delegation", session_id: "s1" });
    // No directory may ever leave the process — the hazard question is a
    // COMPARISON of directories, not a disclosure of them.
    expect(raw).not.toContain("secret-project");
    expect(raw).not.toContain("/home/someone");
    expect(raw).not.toContain("apps/web");
  });

  it("emits a cumulative line only when something changed", () => {
    const h = makeMetrics();
    h.metrics.delegationStarted({ surface: "spawn_agent", background: false });
    expect(h.metrics.flush()).toBe(true);
    expect(h.metrics.flush()).toBe(false);
    h.metrics.delegationStarted({ surface: "spawn_agent", background: false });
    expect(h.metrics.flush()).toBe(true);
    expect(h.lines).toHaveLength(2);
    // Cumulative, so the LAST line is the answer and an earlier one is a prefix.
    expect(JSON.parse(h.lines[0]).usage.spawn_agent.foreground).toBe(1);
    expect(JSON.parse(h.lines[1]).usage.spawn_agent.foreground).toBe(2);
  });

  it("never lets a broken sink break the caller", () => {
    const metrics = createDelegationMetrics({
      env: ON,
      write: () => { throw new Error("stderr is gone"); }
    });
    metrics.delegationStarted({ surface: "spawn_agent", background: false });
    expect(() => metrics.flush()).not.toThrow();
  });

  it("survives garbage arguments without throwing", () => {
    const { metrics } = makeMetrics();
    expect(() => {
      metrics.delegationStarted();
      metrics.delegationStarted({ surface: "unknown_tool", background: true, jobId: "x" });
      metrics.joinBlocked();
      metrics.childSettled(null);
      metrics.collected(undefined);
      metrics.wakeQueued(42);
      metrics.wakeInjected("not-an-array");
      metrics.wakeInjected([]);
    }).not.toThrow();
  });
});

describe("wired into the wake supervisor", () => {
  function makeClock() {
    const timers = new Map();
    let seq = 0;
    return {
      setTimeoutImpl(fn) {
        const id = (seq += 1);
        timers.set(id, fn);
        return { id, unref() { return this; } };
      },
      clearTimeoutImpl(token) { if (token?.id != null) timers.delete(token.id); },
      runAll() {
        const due = [...timers.values()];
        timers.clear();
        for (const fn of due) fn();
      }
    };
  }

  function makeFakeDriver() {
    let cbs = null;
    return {
      driver: { kind: "agent", start(spec, { onEvent, onYield }) { cbs = { onEvent, onYield }; return { kill: () => {} }; } },
      settle: (y) => cbs.onYield(y)
    };
  }

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("counts one wake turn for two settles that coalesce, and clears them as collected", async () => {
    const h = makeMetrics();
    const registry = new DelegatedJobRegistry();
    const clock = makeClock();
    const supervisor = createWakeSupervisor({
      sessionId: "s1",
      registry,
      injectTurn: async () => {},
      setTimeoutImpl: clock.setTimeoutImpl,
      clearTimeoutImpl: clock.clearTimeoutImpl,
      now: () => h.state.nowMs,
      metrics: h.metrics
    }).start();

    const jobs = ["a", "b"].map(() => {
      const fake = makeFakeDriver();
      const { jobId } = registry.spawnJob({
        kind: "agent",
        spec: { task: "t" },
        driver: fake.driver,
        meta: { sessionId: "s1", wake: true, task: "t" }
      });
      h.metrics.delegationStarted({ surface: "spawn_agent", background: true, jobId, cwd: ".", baseCwd: "/w" });
      return { jobId, fake };
    });

    expect(h.metrics.snapshot().concurrency.peak).toBe(2);
    expect(h.metrics.snapshot().hazard.same_cwd_background_overlaps).toBe(1);

    for (const job of jobs) job.fake.settle({ status: "completed", result: { text: "done" } });
    // Both children have stopped writing, so the hazard window is closed…
    expect(h.metrics.snapshot().hazard.same_cwd_peak).toBe(2);
    h.advance(1_500);
    clock.runAll();
    await tick();

    h.metrics.flush();
    const payload = h.lastPayload();
    // …and one wake turn carried both results.
    expect(payload.wake).toMatchObject({ turns: 1, items: 2, coalesce_ratio: 2 });
    expect(payload.wake.latency_ms.count).toBe(2);
    // Delivered ⇒ no longer uncollected.
    expect(payload.concurrency.outstanding_now).toBe(0);
    supervisor.stop();
  });

  it("clears an explicitly joined job without ever counting a wake turn", async () => {
    const h = makeMetrics();
    const registry = new DelegatedJobRegistry();
    const clock = makeClock();
    const supervisor = createWakeSupervisor({
      sessionId: "s1",
      registry,
      injectTurn: async () => {},
      setTimeoutImpl: clock.setTimeoutImpl,
      clearTimeoutImpl: clock.clearTimeoutImpl,
      now: () => h.state.nowMs,
      metrics: h.metrics
    }).start();

    h.metrics.delegationStarted({ surface: "start_run", background: true, jobId: "run-1" });
    supervisor.trackRun({ jobId: "run-1", project: "p", ticket: "TK-1" });
    supervisor.collect({ jobId: "run-1", project: "p", ticket: "TK-1", status: "completed" });

    h.metrics.flush();
    const payload = h.lastPayload();
    expect(payload.concurrency.peak).toBe(1);
    expect(payload.concurrency.outstanding_now).toBe(0);
    expect(payload.wake.turns).toBe(0);
    supervisor.stop();
  });
});

/**
 * The "green tests, broken production" shape this file exists to prevent: a
 * collector that is perfectly unit-tested and never called by anything that
 * ships. These drive the REAL dispatcher and the REAL session.
 */
describe("wired into the tool dispatcher", () => {
  function recorder() {
    const lines = [];
    return {
      lines,
      metrics: createDelegationMetrics({ sessionId: "s1", env: ON, write: (line) => lines.push(line) })
    };
  }

  it("counts a foreground spawn_agent, times its block, and releases the directory", async () => {
    const { metrics } = recorder();
    const jobRegistry = new DelegatedJobRegistry();
    await executeToolCall({
      name: "spawn_agent",
      args: { task: "scan", cwd: "sub" },
      cwd: "/ws",
      settings: { approvalMode: "full-auto" },
      approvalRequester: async () => true,
      childAgentRunner: async () => ({ text: "ok", exitCode: 0 }),
      jobRegistry,
      delegationMetrics: metrics
    });

    const snap = metrics.snapshot();
    expect(snap.usage.spawn_agent).toEqual({ foreground: 1, background: 0 });
    expect(snap.join_blocked_ms.spawn_agent_foreground.count).toBe(1);
    // Foreground work is never "uncollected" — the tool returned the result.
    expect(snap.concurrency.peak).toBe(0);
    // The child is done, so it holds no directory any more.
    expect(snap.hazard.same_cwd_peak).toBe(1);
    expect(snap.hazard.distinct_cwds).toBe(1);
  });

  it("counts a background spawn_agent as outstanding and holds its directory", async () => {
    const { metrics } = recorder();
    const jobRegistry = new DelegatedJobRegistry();
    let release;
    const started = new Promise((resolve) => { release = resolve; });
    const result = await executeToolCall({
      name: "spawn_agent",
      args: { task: "scan", cwd: ".", runInBackground: true },
      cwd: "/ws",
      settings: { approvalMode: "full-auto" },
      approvalRequester: async () => true,
      childAgentRunner: () => started.then(() => ({ text: "ok", exitCode: 0 })),
      jobRegistry,
      sessionId: "s1",
      delegationMetrics: metrics
    });

    const snap = metrics.snapshot();
    expect(result.data.background).toBe(true);
    expect(snap.usage.spawn_agent).toEqual({ foreground: 0, background: 1 });
    expect(snap.concurrency.peak).toBe(1);
    expect(snap.concurrency.outstanding_now).toBe(1);
    // Nothing blocked the turn — that is the whole point of background.
    expect(snap.join_blocked_ms.spawn_agent_foreground.count).toBe(0);
    expect(snap.hazard.same_cwd_peak).toBe(1);
    release();
  });

  it("counts a background start_run and does not attribute a directory to it", async () => {
    const { metrics } = recorder();
    const prev = {
      token: process.env.PROCWAY_PROXY_TOKEN,
      url: process.env.PROCWAY_DASHBOARD_URL,
      fetch: globalThis.fetch
    };
    process.env.PROCWAY_PROXY_TOKEN = "tkn";
    process.env.PROCWAY_DASHBOARD_URL = "https://dash.example.test";
    globalThis.fetch = async () => ({
      ok: true, status: 200, statusText: "OK",
      json: async () => ({ jobId: "run_1", status: "running" }),
      text: async () => "{}"
    });
    try {
      await executeToolCall({
        name: "start_run",
        args: { project: "proj-a", ticket: "TK-1", runInBackground: true },
        cwd: "/ws",
        settings: { approvalMode: "full-auto" },
        approvalRequester: async () => true,
        sessionId: "conv-1",
        delegationMetrics: metrics
      });
    } finally {
      if (prev.token === undefined) delete process.env.PROCWAY_PROXY_TOKEN;
      else process.env.PROCWAY_PROXY_TOKEN = prev.token;
      if (prev.url === undefined) delete process.env.PROCWAY_DASHBOARD_URL;
      else process.env.PROCWAY_DASHBOARD_URL = prev.url;
      globalThis.fetch = prev.fetch;
    }

    const snap = metrics.snapshot();
    expect(snap.usage.start_run).toEqual({ foreground: 0, background: 1 });
    expect(snap.concurrency.peak_by_surface.start_run).toBe(1);
    expect(snap.join_blocked_ms.start_run_foreground.count).toBe(0);
    // A run executes on the host, in its own worker session — not in this cwd.
    expect(snap.hazard.distinct_cwds).toBe(0);
  });

  it("changes nothing when no collector is supplied (the default everywhere)", async () => {
    const jobRegistry = new DelegatedJobRegistry();
    const result = await executeToolCall({
      name: "spawn_agent",
      args: { task: "scan" },
      cwd: "/ws",
      settings: { approvalMode: "full-auto" },
      approvalRequester: async () => true,
      childAgentRunner: async () => ({ text: "ok", exitCode: 0 }),
      jobRegistry
    });
    expect(result.data).toMatchObject({ text: "ok", exitCode: 0 });
  });
});

describe("wired into the session", () => {
  let dirs = [];
  let prevFlag;

  afterEach(async () => {
    if (prevFlag === undefined) delete process.env.PROCWAY_TELEMETRY;
    else process.env.PROCWAY_TELEMETRY = prevFlag;
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    dirs = [];
  });

  async function makeSession() {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "procway-delegation-metrics-"));
    dirs.push(cwd);
    const session = new AgentSession({
      settings: {
        defaultProvider: "scripted",
        approvalMode: "full-auto",
        tools: { maxToolRounds: 2 },
        providers: { scripted: { type: "openai-compatible", baseUrl: "https://example.test/v1", apiKeyEnv: "NOPE", defaultModel: "m" } },
        session: { enabled: false }
      },
      cwd,
      events: new EventBus()
    });
    await session.initialize();
    return session;
  }

  it("attaches a live collector only when the switch is on", async () => {
    prevFlag = process.env.PROCWAY_TELEMETRY;
    delete process.env.PROCWAY_TELEMETRY;
    const off = await makeSession();
    expect(off.delegationMetrics.enabled).toBe(false);

    process.env.PROCWAY_TELEMETRY = "on";
    const on = await makeSession();
    expect(on.delegationMetrics.enabled).toBe(true);
    on.wakeSupervisor?.stop();
    off.wakeSupervisor?.stop();
  });

  /**
   * The dispatcher tests above pass `delegationMetrics` themselves, which is
   * exactly failure mode #3 in docs/guides/tests-that-pass-while-production-is-
   * broken.md ("only the test passed the right argument"): the parameter
   * defaults to null, so a session that forgot to thread it would still be
   * green everywhere else. This runs a REAL turn through a REAL tool call.
   */
  it("threads the collector from a real turn into a real spawn_agent call", async () => {
    prevFlag = process.env.PROCWAY_TELEMETRY;
    process.env.PROCWAY_TELEMETRY = "on";
    const session = await makeSession();
    session.childAgentManager = { run: async () => ({ text: "child done", exitCode: 0 }) };
    const rounds = [
      { message: { role: "assistant", content: "" }, toolCalls: [{ id: "t1", name: "spawn_agent", args: { task: "scan" } }], usage: {} },
      { message: { role: "assistant", content: "ok" }, toolCalls: [], usage: {} }
    ];
    let call = 0;
    const runProviderImpl = async () => rounds[Math.min(call++, rounds.length - 1)];
    // The turn really does flush to stderr; capture it instead of printing it
    // into the suite's output.
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await session.runTurn("delegate please", { runProviderImpl });
      const snap = session.delegationMetrics.snapshot();
      expect(snap.usage.spawn_agent).toEqual({ foreground: 1, background: 0 });
      expect(snap.join_blocked_ms.spawn_agent_foreground.count).toBe(1);
      expect(snap.hazard.distinct_cwds).toBe(1);
      // And it reached the real sink, not just the in-memory accumulator.
      expect(write.mock.calls.some(([line]) => String(line).includes(METRICS_MARKER))).toBe(true);
    } finally {
      write.mockRestore();
      session.wakeSupervisor?.stop();
    }
  });

  it("flushes the line at the end of a turn, and stays silent when nothing was delegated", async () => {
    prevFlag = process.env.PROCWAY_TELEMETRY;
    process.env.PROCWAY_TELEMETRY = "on";
    const session = await makeSession();
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const answer = async () => ({ message: { role: "assistant", content: "done." } });
      await session.runTurn("hello", { runProviderImpl: answer });
      // A turn that delegated nothing must not print anything.
      expect(write.mock.calls.filter(([line]) => String(line).includes(METRICS_MARKER))).toHaveLength(0);

      session.delegationMetrics.delegationStarted({ surface: "spawn_agent", background: true, jobId: "j1", cwd: "." });
      await session.runTurn("again", { runProviderImpl: answer });
      const metricLines = write.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes(METRICS_MARKER));
      expect(metricLines).toHaveLength(1);
      expect(JSON.parse(metricLines[0])).toMatchObject({
        metric: "delegation",
        session_id: session.sessionId,
        usage: { spawn_agent: { background: 1 } }
      });
    } finally {
      write.mockRestore();
      session.wakeSupervisor?.stop();
    }
  });
});
