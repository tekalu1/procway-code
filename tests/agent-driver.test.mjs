import { describe, expect, it } from "vitest";
import { DelegatedJobRegistry } from "../src/jobs/delegated-jobs.mjs";
import { createAgentDriver } from "../src/jobs/agent-driver.mjs";

// ADR 0029 P3 — exercise the `agent` kind driver over the generic registry with
// a FAKE child runner (plain dependency injection, no real sub-agent spawn). The
// fake hands the test control over when the child resolves / rejects / aborts.

function makeFakeManager(opts = {}) {
  const calls = { run: 0, args: null, resolve: null, reject: null, emit: null, aborted: false };
  const manager = {
    run(args) {
      calls.run += 1;
      calls.args = args;
      calls.emit = typeof args.onEvent === "function" ? args.onEvent : null;
      if (opts.throwSync) throw new Error("sync boom");
      return new Promise((resolve, reject) => {
        calls.resolve = resolve;
        calls.reject = reject;
        if (args.signal) {
          args.signal.addEventListener?.("abort", () => {
            calls.aborted = true;
            reject(new Error("aborted"));
          }, { once: true });
        }
      });
    },
  };
  return { manager, calls };
}

describe("createAgentDriver", () => {
  it("spawns DETACHED, emits started + forwards child progress, yields completed", async () => {
    const reg = new DelegatedJobRegistry();
    const { manager, calls } = makeFakeManager();
    const driver = createAgentDriver({ childAgentManager: manager });

    const { jobId, status } = reg.spawnJob({ kind: "agent", driver, spec: { task: "inspect", childCwd: "." } });
    expect(status).toBe("running");
    expect(calls.run).toBe(1);
    // The child runner receives the load-bearing args plus the driver's plumbing.
    expect(calls.args).toMatchObject({ task: "inspect", childCwd: "." });
    expect(typeof calls.args.onEvent).toBe("function");
    expect(calls.args.signal).toBeInstanceOf(AbortSignal);

    // Synchronous first event is buffered before spawnJob returns.
    const before = reg.getJob(jobId);
    expect(before.status).toBe("running");
    expect(before.events.some((e) => e.type === "agent.started")).toBe(true);

    // Child progress is forwarded as a throttled `agent.activity` event.
    calls.emit({ type: "tool.started", name: "read_file" });
    expect(reg.getJob(jobId).events.some((e) => e.type === "agent.activity" && e.name === "read_file")).toBe(true);

    calls.resolve({ text: "done\n", sessionId: "s1", exitCode: 0, depth: 1, cwd: "/x" });
    const y = await reg.awaitJobYield(jobId);
    expect(y.status).toBe("completed");
    expect(y.result).toMatchObject({ text: "done\n", sessionId: "s1", exitCode: 0, depth: 1, cwd: "/x" });
  });

  it("omits depth when the spec has none (the manager binding supplies it)", () => {
    const reg = new DelegatedJobRegistry();
    const { manager, calls } = makeFakeManager();
    const driver = createAgentDriver({ childAgentManager: manager });
    reg.spawnJob({ kind: "agent", driver, spec: { task: "t", childCwd: "." } });
    expect("depth" in calls.args).toBe(false);
  });

  it("yields failed when the child rejects", async () => {
    const reg = new DelegatedJobRegistry();
    const { manager, calls } = makeFakeManager();
    const driver = createAgentDriver({ childAgentManager: manager });
    const { jobId } = reg.spawnJob({ kind: "agent", driver, spec: { task: "t" } });

    calls.reject(new Error("kaboom"));
    const y = await reg.awaitJobYield(jobId);
    expect(y.status).toBe("failed");
    expect(y.error).toContain("kaboom");
  });

  it("yields failed when the child runner throws synchronously", async () => {
    const reg = new DelegatedJobRegistry();
    const { manager } = makeFakeManager({ throwSync: true });
    const driver = createAgentDriver({ childAgentManager: manager });
    const { jobId } = reg.spawnJob({ kind: "agent", driver, spec: { task: "t" } });
    const y = await reg.awaitJobYield(jobId);
    expect(y.status).toBe("failed");
    expect(y.error).toContain("sync boom");
  });

  it("kill() aborts the child via the signal and the job fails", async () => {
    const reg = new DelegatedJobRegistry();
    const { manager, calls } = makeFakeManager();
    const driver = createAgentDriver({ childAgentManager: manager });
    const { jobId } = reg.spawnJob({ kind: "agent", driver, spec: { task: "t" } });

    const killed = reg.killJob(jobId);
    expect(killed).toMatchObject({ killed: true });
    expect(calls.aborted).toBe(true);

    const y = await reg.awaitJobYield(jobId);
    expect(y.status).toBe("failed");
  });
});
