import { describe, expect, it } from "vitest";
import { DelegatedJobRegistry } from "../src/jobs/delegated-jobs.mjs";

// ADR 0029 P2 — exercise the generic registry with a FAKE driver (plain
// functions via dependency injection, no real process, no vi.fn mocks). The
// fake driver hands the test control over when/how the job yields.
// (ADR 0030 D2 moved the registry — and this test — from packages/core into
// procway-code; the contract is unchanged.)

/**
 * A controllable fake driver. `start` captures the registry callbacks and
 * records what happened so a test can drive the lifecycle by hand.
 */
function makeFakeDriver(opts = {}) {
  const calls = { start: 0, kill: 0, resume: [] };
  let cbs = null;
  const driver = {
    kind: "fake",
    start(spec, { onEvent, onYield }) {
      calls.start += 1;
      calls.spec = spec;
      cbs = { onEvent, onYield };
      if (opts.throwOnStart) throw new Error("driver boom");
      if (opts.autoYield) onYield(opts.autoYield);
      return {
        kill: () => { calls.kill += 1; return { killed: true }; },
        resume: (input) => { calls.resume.push(input); },
      };
    },
  };
  return {
    driver,
    calls,
    emit: (e) => cbs.onEvent(e),
    yield: (y) => cbs.onYield(y),
  };
}

describe("DelegatedJobRegistry", () => {
  it("spawnJob returns {jobId, running} and registers running state", () => {
    const reg = new DelegatedJobRegistry();
    const fake = makeFakeDriver();
    const out = reg.spawnJob({ kind: "fake", spec: { x: 1 }, driver: fake.driver });
    expect(typeof out.jobId).toBe("string");
    expect(out.status).toBe("running");
    expect(fake.calls.start).toBe(1);
    expect(fake.calls.spec).toEqual({ x: 1 });
    const state = reg.getJob(out.jobId);
    expect(state.status).toBe("running");
    expect(state.kind).toBe("fake");
  });

  it("onYield(completed) flips status to terminal with result", () => {
    const reg = new DelegatedJobRegistry();
    const fake = makeFakeDriver();
    const { jobId } = reg.spawnJob({ kind: "fake", spec: {}, driver: fake.driver });
    fake.yield({ status: "completed", result: { ok: 1 } });
    const state = reg.getJob(jobId);
    expect(state.status).toBe("completed");
    expect(state.result).toEqual({ ok: 1 });
  });

  it("onYield(failed) records the error message", () => {
    const reg = new DelegatedJobRegistry();
    const fake = makeFakeDriver();
    const { jobId } = reg.spawnJob({ kind: "fake", spec: {}, driver: fake.driver });
    fake.yield({ status: "failed", error: new Error("kaboom") });
    const state = reg.getJob(jobId);
    expect(state.status).toBe("failed");
    expect(state.error).toBe("kaboom");
  });

  it("awaitJobYield resolves at the next non-running yield", async () => {
    const reg = new DelegatedJobRegistry();
    const fake = makeFakeDriver();
    const { jobId } = reg.spawnJob({ kind: "fake", spec: {}, driver: fake.driver });
    const pending = reg.awaitJobYield(jobId);
    fake.yield({ status: "completed", result: 42 });
    const settled = await pending;
    expect(settled.status).toBe("completed");
    expect(settled.result).toBe(42);
  });

  it("awaitJobYield resolves immediately if already settled", async () => {
    const reg = new DelegatedJobRegistry();
    const fake = makeFakeDriver({ autoYield: { status: "completed", result: "done" } });
    const { jobId } = reg.spawnJob({ kind: "fake", spec: {}, driver: fake.driver });
    const settled = await reg.awaitJobYield(jobId);
    expect(settled.status).toBe("completed");
    expect(settled.result).toBe("done");
  });

  it("subscribeJob replays the ring buffer then forwards live events + yield", () => {
    const reg = new DelegatedJobRegistry();
    const fake = makeFakeDriver();
    const { jobId } = reg.spawnJob({ kind: "fake", spec: {}, driver: fake.driver });
    fake.emit({ type: "a" });
    const seen = [];
    const unsub = reg.subscribeJob(jobId, (env) => seen.push(env));
    // replayed buffered event
    expect(seen).toEqual([{ type: "event", data: { type: "a" } }]);
    fake.emit({ type: "b" });
    fake.yield({ status: "completed", result: 1 });
    expect(seen[1]).toEqual({ type: "event", data: { type: "b" } });
    expect(seen[2].type).toBe("yield");
    expect(seen[2].data.status).toBe("completed");
    unsub();
    fake.emit({ type: "c" }); // ignored after unsubscribe
    expect(seen.length).toBe(3);
  });

  it("a throwing subscriber callback cannot break the registry", () => {
    const reg = new DelegatedJobRegistry();
    const fake = makeFakeDriver();
    const { jobId } = reg.spawnJob({ kind: "fake", spec: {}, driver: fake.driver });
    reg.subscribeJob(jobId, () => { throw new Error("subscriber bug"); });
    expect(() => fake.emit({ type: "x" })).not.toThrow();
    expect(reg.getJob(jobId).events).toContainEqual({ type: "x" });
  });

  it("resumeJob flips back to running and calls driver.resume", () => {
    const reg = new DelegatedJobRegistry();
    const fake = makeFakeDriver();
    const { jobId } = reg.spawnJob({ kind: "fake", spec: {}, driver: fake.driver });
    fake.yield({ status: "awaiting-input", awaiting: { inputKind: "stdin" } });
    expect(reg.getJob(jobId).status).toBe("awaiting-input");
    const out = reg.resumeJob(jobId, "the answer");
    expect(out.status).toBe("running");
    expect(reg.getJob(jobId).status).toBe("running");
    expect(fake.calls.resume).toEqual(["the answer"]);
  });

  it("resumeJob is a no-op on a terminal job (guard: no zombie 'running')", () => {
    const reg = new DelegatedJobRegistry();
    const fake = makeFakeDriver();
    const { jobId } = reg.spawnJob({ kind: "fake", spec: {}, driver: fake.driver });
    fake.yield({ status: "completed", result: { ok: true } });
    expect(reg.getJob(jobId).status).toBe("completed");
    const out = reg.resumeJob(jobId, "late answer");
    expect(out.status).toBe("completed"); // not flipped to running
    expect(reg.getJob(jobId).status).toBe("completed");
    expect(fake.calls.resume).toEqual([]); // driver.resume NOT called
  });

  it("killJob calls driver.kill and returns its result", () => {
    const reg = new DelegatedJobRegistry();
    const fake = makeFakeDriver();
    const { jobId } = reg.spawnJob({ kind: "fake", spec: {}, driver: fake.driver });
    const res = reg.killJob(jobId);
    expect(fake.calls.kill).toBe(1);
    expect(res).toEqual({ killed: true });
  });

  it("a throwing driver.start settles the job as failed (no crash)", () => {
    const reg = new DelegatedJobRegistry();
    const fake = makeFakeDriver({ throwOnStart: true });
    const out = reg.spawnJob({ kind: "fake", spec: {}, driver: fake.driver });
    expect(out.status).toBe("running"); // spawn still returns running synchronously
    const state = reg.getJob(out.jobId);
    expect(state.status).toBe("failed");
    expect(state.error).toBe("driver boom");
  });

  it("TTL-evicts terminal jobs (injectable timer)", () => {
    let captured = null;
    const reg = new DelegatedJobRegistry({
      ttlMs: 1000,
      setTimeoutImpl: (fn) => { captured = fn; return { unref() {} }; },
      clearTimeoutImpl: () => {},
    });
    const fake = makeFakeDriver();
    const { jobId } = reg.spawnJob({ kind: "fake", spec: {}, driver: fake.driver });
    fake.yield({ status: "completed", result: 1 });
    // Not evicted until the timer fires.
    expect(reg.getJob(jobId)).not.toBeNull();
    captured(); // simulate TTL expiry
    expect(reg.getJob(jobId)).toBeNull();
  });

  it("awaiting-input is NOT scheduled for eviction (resumable pause)", () => {
    let scheduled = 0;
    const reg = new DelegatedJobRegistry({
      setTimeoutImpl: (fn) => { scheduled += 1; return { unref() {} }; },
      clearTimeoutImpl: () => {},
    });
    const fake = makeFakeDriver();
    const { jobId } = reg.spawnJob({ kind: "fake", spec: {}, driver: fake.driver });
    fake.yield({ status: "awaiting-input", awaiting: { inputKind: "stdin" } });
    expect(scheduled).toBe(0);
    expect(reg.getJob(jobId).status).toBe("awaiting-input");
  });

  // --- ADR 0029 P4: generic knobs the dashboard run-loop consumer needs ---

  it("spawnJob honors a pre-minted jobId and stores opaque meta on the state", () => {
    const reg = new DelegatedJobRegistry();
    const fake = makeFakeDriver();
    const out = reg.spawnJob({ kind: "fake", spec: {}, driver: fake.driver, jobId: "run-123", meta: { project: "demo", ticket: "TK-1" } });
    expect(out.jobId).toBe("run-123");
    const state = reg.getJob("run-123");
    expect(state.meta).toEqual({ project: "demo", ticket: "TK-1" });
  });

  it("start receives the jobId in its context", () => {
    const reg = new DelegatedJobRegistry();
    let seenJobId = null;
    const driver = { kind: "fake", start(_spec, { jobId }) { seenJobId = jobId; return { kill() {} }; } };
    const { jobId } = reg.spawnJob({ kind: "fake", spec: {}, driver, jobId: "abc" });
    expect(seenJobId).toBe(jobId);
    expect(seenJobId).toBe("abc");
  });

  it("a per-settle ttlMs on the yield overrides the registry default eviction window", () => {
    const captured = [];
    const reg = new DelegatedJobRegistry({
      ttlMs: 1000,
      setTimeoutImpl: (fn, ms) => { captured.push(ms); return { unref() {} }; },
      clearTimeoutImpl: () => {},
    });
    const fake = makeFakeDriver();
    reg.spawnJob({ kind: "fake", spec: {}, driver: fake.driver });
    fake.yield({ status: "completed", result: 1, ttlMs: 7200000 });
    expect(captured).toEqual([7200000]);
  });

  it("resumable and never-evict are DECOUPLED (run-loop config: resumable pause that still evicts)", () => {
    const scheduled = [];
    const reg = new DelegatedJobRegistry({
      // The run loop's awaiting-user-input is resumable BUT still evicted on a
      // long failsafe TTL (noEvictStatuses empty), unlike the generic
      // never-evict 'awaiting-input'.
      resumableStatuses: ["awaiting-user-input"],
      noEvictStatuses: [],
      setTimeoutImpl: (_fn, ms) => { scheduled.push(ms); return { unref() {} }; },
      clearTimeoutImpl: () => {},
    });
    const fake = makeFakeDriver();
    const { jobId } = reg.spawnJob({ kind: "fake", spec: {}, driver: fake.driver });
    fake.yield({ status: "awaiting-user-input", ttlMs: 7200000 });
    // It IS scheduled for eviction (with the per-settle failsafe ttl)...
    expect(scheduled).toEqual([7200000]);
    // ...and it is STILL resumable.
    const out = reg.resumeJob(jobId, "answer");
    expect(out.status).toBe("running");
    expect(fake.calls.resume).toEqual(["answer"]);
  });
});
