import { describe, expect, it } from "vitest";
import { DelegatedJobRegistry } from "../src/jobs/delegated-jobs.mjs";
import { buildWakePrompt, createWakeSupervisor } from "../src/agent/wake-supervisor.mjs";

// event-wake (issue #143) — the supervisor is exercised with plain dependency
// injection (fake registry driver, fake clock, a recording injector), matching
// how delegated-jobs.test.mjs drives the registry: no vi.fn mocks, the test
// decides when a job settles and when the debounce fires.

/** A controllable fake driver (same shape as delegated-jobs.test.mjs). */
function makeFakeDriver({ throwOnStart = false } = {}) {
  let cbs = null;
  const driver = {
    kind: "agent",
    start(spec, { onEvent, onYield }) {
      cbs = { onEvent, onYield };
      if (throwOnStart) throw new Error("driver boom");
      return { kill: () => {} };
    }
  };
  return { driver, yield: (y) => cbs.onYield(y) };
}

/** A fake timer pair so the debounce is stepped by hand. */
function makeClock() {
  const timers = new Map();
  let seq = 0;
  return {
    timers,
    setTimeoutImpl(fn) {
      const id = (seq += 1);
      timers.set(id, fn);
      return { id, unref() { return this; } };
    },
    clearTimeoutImpl(token) {
      if (token?.id != null) timers.delete(token.id);
    },
    runAll() {
      const due = [...timers.values()];
      timers.clear();
      for (const fn of due) fn();
    }
  };
}

/** Let the detached injection promise settle. */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeHarness({ sessionId = "s1", turnRunning = false, injector, ...opts } = {}) {
  const registry = new DelegatedJobRegistry();
  const clock = makeClock();
  const injected = [];
  const errors = [];
  const state = { turnRunning, nowMs: 1_000 };
  const supervisor = createWakeSupervisor({
    sessionId,
    registry,
    injectTurn: injector ?? (async (text) => { injected.push(text); }),
    isTurnRunning: () => state.turnRunning,
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
    now: () => state.nowMs,
    onError: (err, context) => errors.push({ err, context }),
    ...opts
  }).start();
  const spawn = (meta, { throwOnStart = false } = {}) => {
    const fake = makeFakeDriver({ throwOnStart });
    const { jobId } = registry.spawnJob({ kind: "agent", spec: { task: "t" }, driver: fake.driver, meta });
    return { jobId, settle: fake.yield };
  };
  return { registry, clock, injected, errors, state, supervisor, spawn };
}

describe("createWakeSupervisor", () => {
  it("wakes once when a background child of this session settles", async () => {
    const h = makeHarness();
    const job = h.spawn({ sessionId: "s1", wake: true, task: "summarise the docs" });
    job.settle({ status: "completed", result: { text: "all done", exitCode: 0 } });

    h.clock.runAll();
    await tick();

    expect(h.injected).toHaveLength(1);
    expect(h.injected[0]).toContain(job.jobId);
    expect(h.injected[0]).toContain("summarise the docs");
    expect(h.injected[0]).toContain("all done");
    expect(h.injected[0]).toContain("NOT a message from the user");
  });

  it("coalesces three settles into ONE wake turn", async () => {
    const h = makeHarness();
    const a = h.spawn({ sessionId: "s1", wake: true, task: "a" });
    const b = h.spawn({ sessionId: "s1", wake: true, task: "b" });
    const c = h.spawn({ sessionId: "s1", wake: true, task: "c" });

    a.settle({ status: "completed", result: { text: "ra" } });
    b.settle({ status: "completed", result: { text: "rb" } });
    c.settle({ status: "failed", error: "rc blew up" });
    // The debounce is re-armed by each settle, so only one timer is ever live.
    expect(h.clock.timers.size).toBe(1);

    h.clock.runAll();
    await tick();

    expect(h.injected).toHaveLength(1);
    expect(h.injected[0]).toContain(a.jobId);
    expect(h.injected[0]).toContain(b.jobId);
    expect(h.injected[0]).toContain(c.jobId);
    expect(h.injected[0]).toContain("rc blew up");
  });

  it("holds a settle while a turn is running and fires on notifyTurnSettled", async () => {
    const h = makeHarness({ turnRunning: true });
    const job = h.spawn({ sessionId: "s1", wake: true, task: "a" });
    job.settle({ status: "completed", result: { text: "done" } });

    expect(h.clock.timers.size).toBe(0);
    await h.supervisor.flushNow();
    expect(h.injected).toHaveLength(0);
    expect(h.supervisor.__inspect().pending).toHaveLength(1);

    h.state.turnRunning = false;
    h.supervisor.notifyTurnSettled();
    h.clock.runAll();
    await tick();

    expect(h.injected).toHaveLength(1);
  });

  it("does not wake for work the turn already collected", async () => {
    const h = makeHarness();
    const job = h.spawn({ sessionId: "s1", wake: true, task: "a" });
    job.settle({ status: "completed", result: { text: "done" } });

    expect(h.supervisor.collect(job.jobId)).toBe(true);
    await h.supervisor.flushNow();
    h.clock.runAll();
    await tick();

    expect(h.injected).toHaveLength(0);
  });

  it("ignores another session's jobs and foreground (unmarked) jobs", async () => {
    const h = makeHarness();
    const other = h.spawn({ sessionId: "s2", wake: true, task: "other session" });
    const foreground = h.spawn({ sessionId: "s1", task: "foreground" });
    const anonymous = h.spawn(undefined);

    other.settle({ status: "completed", result: { text: "x" } });
    foreground.settle({ status: "completed", result: { text: "y" } });
    anonymous.settle({ status: "completed", result: { text: "z" } });

    await h.supervisor.flushNow();
    h.clock.runAll();
    await tick();

    expect(h.injected).toHaveLength(0);
    expect(h.supervisor.hasOutstanding()).toBe(false);
  });

  it("wakes when driver.start throws (the _fail settle path)", async () => {
    const h = makeHarness();
    const job = h.spawn({ sessionId: "s1", wake: true, task: "explodes" }, { throwOnStart: true });

    h.clock.runAll();
    await tick();

    expect(h.injected).toHaveLength(1);
    expect(h.injected[0]).toContain(job.jobId);
    expect(h.injected[0]).toContain("driver boom");
  });

  it("carries a run's project / ticket / inputKind / hearing into the wake", async () => {
    const h = makeHarness();
    h.supervisor.trackRun({ jobId: "run-1", project: "procway", ticket: "TK-7" });
    expect(h.supervisor.hasOutstanding()).toBe(true);

    h.supervisor.pushExternal({
      jobId: "run-1",
      kind: "run",
      status: "awaiting-user-input",
      project: "procway",
      ticket: "TK-7",
      inputKind: "conversational",
      hearing: "Which database should the migration target?",
      sessionId: "worker-session-9"
    });

    h.clock.runAll();
    await tick();

    expect(h.injected).toHaveLength(1);
    const text = h.injected[0];
    expect(text).toContain("run-1");
    expect(text).toContain("procway");
    expect(text).toContain("TK-7");
    expect(text).toContain("conversational");
    expect(text).toContain("Which database should the migration target?");
    expect(text).toContain("reply_run");
    expect(h.supervisor.hasOutstanding()).toBe(false);
  });

  it("clears a tracked run by ticket (resume_run mints a fresh jobId)", () => {
    const h = makeHarness();
    h.supervisor.trackRun({ jobId: "run-1", project: "procway", ticket: "TK-7" });
    expect(h.supervisor.collect({ jobId: "run-2", project: "procway", ticket: "TK-7" })).toBe(true);
    expect(h.supervisor.hasOutstanding()).toBe(false);
  });

  it("re-queues an item when injection fails, then gives up at the attempt cap", async () => {
    const attempts = [];
    const h = makeHarness({
      maxInjectAttempts: 3,
      injector: async (text) => {
        attempts.push(text);
        throw new Error("no surface");
      }
    });
    const job = h.spawn({ sessionId: "s1", wake: true, task: "a" });
    job.settle({ status: "completed", result: { text: "done" } });

    await h.supervisor.flushNow();
    expect(attempts).toHaveLength(1);
    expect(h.supervisor.__inspect().pending).toHaveLength(1);

    await h.supervisor.flushNow();
    expect(attempts).toHaveLength(2);
    expect(h.supervisor.__inspect().pending).toHaveLength(1);

    await h.supervisor.flushNow();
    expect(attempts).toHaveLength(3);
    expect(h.supervisor.__inspect().pending).toHaveLength(0);
    expect(h.errors.some((e) => e.context?.gaveUp === true && e.context.jobId === job.jobId)).toBe(true);

    // Given up means given up: no fourth attempt.
    await h.supervisor.flushNow();
    expect(attempts).toHaveLength(3);
  });

  it("tombstones a collected jobId so the host's late push cannot wake twice", async () => {
    // The host pushes EVERY settle of a run that carries a conversationId — it
    // cannot tell a background run from one the turn joined itself. So the
    // duplicate arrives after attach_run already delivered the yield.
    const h = makeHarness();
    h.supervisor.trackRun({ jobId: "run-1", project: "p", ticket: "TK-1" });
    h.supervisor.collect({ jobId: "run-1", project: "p", ticket: "TK-1", status: "completed" });

    h.supervisor.pushExternal({ jobId: "run-1", kind: "run", status: "completed", project: "p", ticket: "TK-1" });
    h.clock.runAll();
    await tick();

    expect(h.injected).toHaveLength(0);
    expect(h.supervisor.hasOutstanding()).toBe(false);
  });

  it("lets a push through once the tombstone TTL has elapsed", async () => {
    const h = makeHarness({ collectedTtlMs: 60_000 });
    h.supervisor.collect({ jobId: "run-1", status: "completed" });

    h.supervisor.pushExternal({ jobId: "run-1", kind: "run", status: "completed", project: "p", ticket: "TK-1" });
    h.clock.runAll();
    await tick();
    expect(h.injected).toHaveLength(0);

    h.state.nowMs += 60_001;
    h.supervisor.pushExternal({ jobId: "run-1", kind: "run", status: "completed", project: "p", ticket: "TK-1" });
    h.clock.runAll();
    await tick();
    expect(h.injected).toHaveLength(1);
  });

  it("lets a push through when its status differs from the collected one", async () => {
    const h = makeHarness();
    h.supervisor.collect({ jobId: "run-1", status: "completed" });

    h.supervisor.pushExternal({ jobId: "run-1", kind: "run", status: "awaiting-user-input", project: "p", ticket: "TK-1", hearing: "which?" });
    h.clock.runAll();
    await tick();

    expect(h.injected).toHaveLength(1);
    expect(h.injected[0]).toContain("which?");
  });

  it("trackRun on a tombstoned id lifts the tombstone (it is new work)", async () => {
    const h = makeHarness();
    h.supervisor.collect({ jobId: "run-1", status: "completed" });
    h.supervisor.trackRun({ jobId: "run-1", project: "p", ticket: "TK-1" });

    h.supervisor.pushExternal({ jobId: "run-1", kind: "run", status: "completed", project: "p", ticket: "TK-1" });
    h.clock.runAll();
    await tick();

    expect(h.injected).toHaveLength(1);
  });

  it("tombstones a job the wake itself delivered", async () => {
    const h = makeHarness();
    const job = h.spawn({ sessionId: "s1", wake: true, task: "a" });
    job.settle({ status: "completed", result: { text: "done" } });
    h.clock.runAll();
    await tick();
    expect(h.injected).toHaveLength(1);

    // A host push for the same settle (or a replayed one) must not re-wake.
    h.supervisor.pushExternal({ jobId: job.jobId, kind: "agent", status: "completed", task: "a" });
    h.clock.runAll();
    await tick();
    expect(h.injected).toHaveLength(1);
  });

  it("stop() unsubscribes and cancels a pending wake", async () => {
    const h = makeHarness();
    const job = h.spawn({ sessionId: "s1", wake: true, task: "a" });
    h.supervisor.stop();
    job.settle({ status: "completed", result: { text: "done" } });

    h.clock.runAll();
    await tick();
    expect(h.injected).toHaveLength(0);
  });

  it("hasOutstanding reports a background job that is still running", () => {
    const h = makeHarness();
    h.spawn({ sessionId: "s1", wake: true, task: "a" });
    expect(h.supervisor.hasOutstanding()).toBe(true);
  });
});

describe("buildWakePrompt", () => {
  it("returns empty for nothing to report", () => {
    expect(buildWakePrompt([])).toBe("");
    expect(buildWakePrompt(undefined)).toBe("");
  });

  it("clips an oversized child result and says so", () => {
    const text = buildWakePrompt(
      [{ jobId: "job-1", kind: "agent", status: "completed", task: "long one", text: "x".repeat(5000) }],
      { maxChars: 400 }
    );
    expect(text).not.toContain("x".repeat(1000));
    expect(text).toContain("clipped");
    expect(text).toContain('agent_job` action:"status"');
  });

  it("instructs to answer a paused run, and to continue finished work", () => {
    const awaiting = buildWakePrompt([
      { jobId: "run-1", kind: "run", status: "awaiting-user-input", project: "p", ticket: "TK-1", inputKind: "conversational", hearing: "which one?" }
    ]);
    expect(awaiting).toContain("PAUSED waiting for an answer");
    expect(awaiting).toContain("reply_run");
    expect(awaiting).not.toContain("use the result and CONTINUE");

    const done = buildWakePrompt([
      { jobId: "job-1", kind: "agent", status: "completed", text: "finished" }
    ]);
    expect(done).toContain("use the result and CONTINUE");
    expect(done).not.toContain("PAUSED waiting for an answer");
  });

  it("marks the wake as an automatic resume, not a user message", () => {
    const text = buildWakePrompt([{ jobId: "job-1", kind: "agent", status: "completed", text: "ok" }]);
    expect(text).toContain("AUTOMATIC RESUME");
    expect(text).toContain("NOT a message from the user");
  });
});

/**
 * Phase 2 (issue #143) — `awaitSettle`, the replacement for run-control's 2s
 * poll loop. Everything here is driven with a virtual clock and explicit
 * settles: no real timers, no sleeping.
 */
function makeVirtualClock(startMs = 1_000) {
  let nowMs = startMs;
  let seq = 0;
  /** @type {Map<number, { dueAt: number, fn: () => void }>} */
  const timers = new Map();
  return {
    now: () => nowMs,
    setTimeoutImpl(fn, delay = 0) {
      const id = (seq += 1);
      timers.set(id, { dueAt: nowMs + (Number(delay) || 0), fn });
      return { id, unref() { return this; } };
    },
    clearTimeoutImpl(token) {
      if (token?.id != null) timers.delete(token.id);
    },
    /** Move virtual time forward, firing (and re-arming) timers as they come due. */
    advance(ms) {
      const target = nowMs + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.dueAt <= target)
          .sort((a, b) => a[1].dueAt - b[1].dueAt);
        if (due.length === 0) break;
        const [id, timer] = due[0];
        timers.delete(id);
        nowMs = Math.max(nowMs, timer.dueAt);
        timer.fn();
      }
      nowMs = target;
    },
    pendingCount() { return timers.size; }
  };
}

function makeAwaitHarness({ sessionId = "s1", ...opts } = {}) {
  const registry = new DelegatedJobRegistry();
  const clock = makeVirtualClock();
  const injected = [];
  const supervisor = createWakeSupervisor({
    sessionId,
    registry,
    injectTurn: async (text) => { injected.push(text); },
    isTurnRunning: () => false,
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
    now: clock.now,
    ...opts
  }).start();
  const spawn = (meta) => {
    let cbs = null;
    const driver = { kind: "agent", start(spec, handlers) { cbs = handlers; return { kill: () => {} }; } };
    const { jobId } = registry.spawnJob({ kind: "agent", spec: { task: "t" }, driver, meta });
    return { jobId, settle: (y) => cbs.onYield(y) };
  };
  return { registry, clock, injected, supervisor, spawn };
}

/** Let a resolved promise's continuations run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createWakeSupervisor: awaitSettle (the JOIN's wait — issue #143 Phase 2)", () => {
  it("resolves with the host-pushed settle, and does NOT also wake about it", async () => {
    const h = makeAwaitHarness();
    const waiting = h.supervisor.awaitSettle("run_1", { timeoutMs: 60_000 });
    await flush();

    h.supervisor.pushExternal({
      jobId: "run_1", status: "awaiting-user-input", inputKind: "conversational",
      hearing: "Which DB?", project: "p", ticket: "TK-1", runSessionId: "sess-1"
    });

    const item = await waiting;
    expect(item).toMatchObject({
      jobId: "run_1", kind: "run", status: "awaiting-user-input",
      hearing: "Which DB?", project: "p", ticket: "TK-1", runSessionId: "sess-1"
    });
    // The JOIN delivered it: nothing queued, nothing injected, and a late
    // duplicate push from the host is dropped as already-collected.
    const state = h.supervisor.__inspect();
    expect(state.pending).toEqual([]);
    expect(state.waiters).toEqual([]);
    h.clock.advance(10_000);
    await flush();
    expect(h.injected).toEqual([]);
    expect(h.supervisor.pushExternal({ jobId: "run_1", status: "awaiting-user-input" })).toBeNull();
  });

  it("carries `result` through to the JOIN (the yield used to lose it)", async () => {
    const h = makeAwaitHarness();
    const waiting = h.supervisor.awaitSettle("run_1", { timeoutMs: 60_000 });
    await flush();
    h.supervisor.pushExternal({ jobId: "run_1", status: "completed", result: { status: "completed", runCount: 3 } });
    expect((await waiting).result).toEqual({ status: "completed", runCount: 3 });
  });

  it("resolves IMMEDIATELY when the settle arrived before the await (the POST→await race)", async () => {
    // A run can settle within a second of being started, i.e. before startRun
    // even gets to wait for it. Missing this would hang the JOIN until timeout.
    const h = makeAwaitHarness();
    h.supervisor.pushExternal({ jobId: "run_1", status: "completed", project: "p", ticket: "TK-1" });
    expect(h.supervisor.__inspect().pending).toHaveLength(1);

    const item = await h.supervisor.awaitSettle("run_1", { timeoutMs: 60_000 });
    expect(item).toMatchObject({ jobId: "run_1", status: "completed" });
    // Taken OUT of the wake queue: it must not be injected as well.
    expect(h.supervisor.__inspect().pending).toEqual([]);
    h.clock.advance(60_000);
    await flush();
    expect(h.injected).toEqual([]);
  });

  it("resolves from an in-process job settle too (not only host pushes)", async () => {
    const h = makeAwaitHarness();
    const job = h.spawn({ sessionId: "s1", wake: true, task: "summarise" });
    const waiting = h.supervisor.awaitSettle(job.jobId, { timeoutMs: 60_000 });
    await flush();
    job.settle({ status: "completed", result: { text: "done", exitCode: 0 } });
    await flush();
    const item = await waiting;
    expect(item).toMatchObject({ jobId: job.jobId, kind: "agent", status: "completed", text: "done" });
    expect(h.injected).toEqual([]);
  });

  it("returns null when the deadline passes, and stops heartbeating", async () => {
    const h = makeAwaitHarness();
    const beats = [];
    const waiting = h.supervisor.awaitSettle("run_1", {
      timeoutMs: 100_000, heartbeatMs: 20_000, onHeartbeat: (info) => beats.push(info)
    });
    await flush();
    h.clock.advance(99_000);
    expect(beats).toHaveLength(4);
    h.clock.advance(2_000);
    expect(await waiting).toBeNull();
    // Every timer of this wait is cleared — no leaked heartbeat loop.
    h.clock.advance(1_000_000);
    expect(beats).toHaveLength(4);
    expect(h.supervisor.__inspect().waiters).toEqual([]);
  });

  it("heartbeats at the requested cadence with the elapsed wait", async () => {
    const h = makeAwaitHarness();
    const beats = [];
    const waiting = h.supervisor.awaitSettle("run_1", {
      timeoutMs: 600_000, heartbeatMs: 20_000, onHeartbeat: (info) => beats.push(info)
    });
    await flush();
    h.clock.advance(65_000);
    expect(beats.map((b) => b.waitedMs)).toEqual([20_000, 40_000, 60_000]);
    expect(beats.every((b) => b.jobId === "run_1")).toBe(true);
    h.supervisor.pushExternal({ jobId: "run_1", status: "completed" });
    await waiting;
    h.clock.advance(100_000);
    expect(beats).toHaveLength(3); // silent once resolved
  });

  it("resolves promptly when the turn is aborted", async () => {
    const h = makeAwaitHarness();
    const controller = new AbortController();
    const waiting = h.supervisor.awaitSettle("run_1", { timeoutMs: 600_000, signal: controller.signal });
    await flush();
    controller.abort();
    expect(await waiting).toBeNull();
    expect(h.supervisor.__inspect().waiters).toEqual([]);

    // An ALREADY-aborted signal never registers a waiter at all.
    expect(await h.supervisor.awaitSettle("run_2", { signal: controller.signal })).toBeNull();
  });

  it("releases every blocked JOIN when the supervisor is stopped", async () => {
    const h = makeAwaitHarness();
    const a = h.supervisor.awaitSettle("run_1", { timeoutMs: 600_000 });
    const b = h.supervisor.awaitSettle("run_2", { timeoutMs: 600_000 });
    await flush();
    h.supervisor.stop();
    expect(await a).toBeNull();
    expect(await b).toBeNull();
    // A stopped supervisor never blocks a caller either.
    expect(await h.supervisor.awaitSettle("run_3", { timeoutMs: 600_000 })).toBeNull();
  });

  it("returns null at once for work already DELIVERED (a wake beat the JOIN to it)", async () => {
    // Without this the JOIN would block for its whole deadline waiting for a
    // settle that can never arrive twice; run-control answers the null with one
    // confirming read instead.
    const h = makeAwaitHarness();
    h.supervisor.collect({ jobId: "run_1", status: "completed" });
    expect(await h.supervisor.awaitSettle("run_1", { timeoutMs: 600_000 })).toBeNull();
  });

  it("answers every waiter on the same run, and ignores a blank id", async () => {
    const h = makeAwaitHarness();
    const first = h.supervisor.awaitSettle("run_1", { timeoutMs: 600_000 });
    const second = h.supervisor.awaitSettle("run_1", { timeoutMs: 600_000 });
    await flush();
    expect(h.supervisor.__inspect().waiters).toEqual(["run_1"]);
    h.supervisor.pushExternal({ jobId: "run_1", status: "completed", ticket: "TK-1" });
    expect((await first).ticket).toBe("TK-1");
    expect((await second).ticket).toBe("TK-1");

    expect(await h.supervisor.awaitSettle("  ", { timeoutMs: 600_000 })).toBeNull();
  });
});
