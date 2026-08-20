/**
 * Issue #142 — `spawn_agent` background mode + the `agent_job` management tool.
 *
 * The three things worth nailing down here, in order of how expensive they are
 * to discover in production:
 *   1. the DEFAULT (foreground) spawn_agent contract is untouched — same result
 *      shape, same throw-on-failure, same progress unsubscribe;
 *   2. `agent_job action:"wait"` leaves NO listener behind when it times out or
 *      is aborted (it runs against the process-wide shared registry, so a leak
 *      per timed-out wait is a real leak);
 *   3. a caller can only reach agent-kind jobs its OWN session started.
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeToolCall } from "../src/tools/registry.mjs";
import { DelegatedJobRegistry } from "../src/jobs/delegated-jobs.mjs";
import { createChildAgentManager } from "../src/agent/child-agent.mjs";
import { isToolResult } from "../src/core/types/tool-result.mjs";

let tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

async function makeWorkspace() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "procway-agent-job-"));
  tempDirs.push(dir);
  return dir;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Spawn through the real dispatch, capturing the ids the registry minted. */
function trackSpawns(registry) {
  const spawned = [];
  const original = registry.spawnJob.bind(registry);
  registry.spawnJob = (opts) => {
    const out = original(opts);
    spawned.push({ ...opts, jobId: out.jobId });
    return out;
  };
  return spawned;
}

function callSpawnAgent({ args, registry, childAgentRunner, sessionId = "s-1", onProgress = null }) {
  return executeToolCall({
    name: "spawn_agent",
    args,
    cwd: process.cwd(),
    settings: { approvalMode: "full-auto" },
    approvalRequester: vi.fn(async () => true),
    childAgentRunner,
    jobRegistry: registry,
    sessionId,
    onProgress
  });
}

function callAgentJob({ args, registry, sessionId = "s-1", onProgress = null, signal = null }) {
  return executeToolCall({
    name: "agent_job",
    args,
    cwd: process.cwd(),
    settings: { approvalMode: "full-auto" },
    approvalRequester: vi.fn(async () => true),
    jobRegistry: registry,
    sessionId,
    onProgress,
    signal
  });
}

/** Emitter listener counts for a live job — the leak detector. */
function listenerCounts(registry, jobId) {
  const emitter = registry.jobs.get(jobId)?.emitter;
  return {
    event: emitter?.listenerCount("event") ?? -1,
    yield: emitter?.listenerCount("yield") ?? -1
  };
}

describe("spawn_agent foreground (default) is unchanged", () => {
  it("still awaits the child, returns its text, and unsubscribes its progress tap", async () => {
    const registry = new DelegatedJobRegistry();
    const spawned = trackSpawns(registry);
    const progress = [];
    const result = await callSpawnAgent({
      args: { task: "inspect" },
      registry,
      childAgentRunner: async () => ({ text: "child said hi", exitCode: 0 }),
      onProgress: (p) => progress.push(p)
    });

    expect(isToolResult(result)).toBe(true);
    expect(result.kind).toBe("spawn_agent");
    expect(result.data.text).toBe("child said hi");
    // No background markers on the default path.
    expect(result.data.background).toBeUndefined();
    expect(result.data.jobId).toBeUndefined();
    // The onProgress tap fired (agent.started at minimum) and was removed.
    expect(progress.length).toBeGreaterThan(0);
    expect(listenerCounts(registry, spawned[0].jobId)).toEqual({ event: 0, yield: 0 });
    // Issue #143: a FOREGROUND spawn is not wakeable — this call awaited the
    // child's yield itself, so a wake would deliver the same result twice.
    expect(registry.getJob(spawned[0].jobId).meta).toEqual({ sessionId: "s-1" });
  });

  it("still propagates a failed child as a throw and unsubscribes anyway", async () => {
    const registry = new DelegatedJobRegistry();
    const spawned = trackSpawns(registry);
    await expect(callSpawnAgent({
      args: { task: "boom" },
      registry,
      childAgentRunner: async () => { throw new Error("child kaboom"); }
    })).rejects.toThrow(/child kaboom/);
    expect(listenerCounts(registry, spawned[0].jobId)).toEqual({ event: 0, yield: 0 });
  });
});

describe("spawn_agent runInBackground:true", () => {
  it("returns a jobId immediately without waiting for the child", async () => {
    const registry = new DelegatedJobRegistry();
    const gate = deferred();
    let finished = false;
    const result = await callSpawnAgent({
      args: { task: "long child", cwd: "sub", runInBackground: true },
      registry,
      childAgentRunner: async () => {
        await gate.promise;
        finished = true;
        return { text: "late", exitCode: 0 };
      }
    });

    expect(isToolResult(result)).toBe(true);
    expect(finished).toBe(false);
    expect(result.data.background).toBe(true);
    expect(result.data.status).toBe("running");
    expect(typeof result.data.jobId).toBe("string");
    expect(result.data.task).toBe("long child");
    expect(result.data.cwd).toBe("sub");
    expect(result.data.note).toContain('agent_job');
    expect(result.data.note).toContain(result.data.jobId);
    expect(result.summary).toContain("background");
    // The dispatch returns at once, so nothing could ever unsubscribe a
    // progress tap — it must not have subscribed one.
    expect(listenerCounts(registry, result.data.jobId)).toEqual({ event: 0, yield: 0 });
    expect(registry.getJob(result.data.jobId).status).toBe("running");
    // Issue #143: a BACKGROUND child is marked wakeable, and carries its task
    // in meta (the settle payload has no spec, so the wake prompt reads it
    // from here). A foreground spawn stays unmarked — see the case above.
    expect(registry.getJob(result.data.jobId).meta).toEqual({ sessionId: "s-1", wake: true, task: "long child" });

    gate.resolve();
    await callAgentJob({ args: { action: "wait", jobId: result.data.jobId }, registry });
  });

  it("runs several background children concurrently, up to the global semaphore", async () => {
    const cwd = await makeWorkspace();
    const registry = new DelegatedJobRegistry();
    let active = 0;
    let maxActive = 0;
    const release = deferred();
    const manager = createChildAgentManager({
      cwd,
      settings: { agents: { maxDepth: 3, maxConcurrentAgents: 2 } },
      runAgentImpl: async ({ prompt }) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await release.promise;
        active -= 1;
        return { exitCode: 0, text: `done:${prompt}` };
      }
    });

    const started = [];
    for (const task of ["a", "b", "c", "d"]) {
      started.push(await callSpawnAgent({
        args: { task, runInBackground: true },
        registry,
        childAgentRunner: (childArgs) => manager.run(childArgs)
      }));
    }

    // All four dispatches returned while every child is still unfinished.
    expect(started.map((r) => r.data.status)).toEqual(["running", "running", "running", "running"]);
    // ...and two of them are genuinely running at the same time (the semaphore
    // ceiling), which is the whole point of the background mode. Before #142
    // each spawn_agent awaited its child, so maxActive could never exceed 1.
    await vi.waitFor(() => expect(maxActive).toBe(2));

    release.resolve();
    const results = await Promise.all(started.map((r) => callAgentJob({
      args: { action: "wait", jobId: r.data.jobId },
      registry
    })));
    expect(results.map((r) => r.data.status)).toEqual(["completed", "completed", "completed", "completed"]);
    expect(results.map((r) => r.data.text).sort()).toEqual(["done:a", "done:b", "done:c", "done:d"]);
  });
});

describe("agent_job actions", () => {
  it("status reports a running child and then its completed result", async () => {
    const registry = new DelegatedJobRegistry();
    const gate = deferred();
    const started = await callSpawnAgent({
      args: { task: "scan the repo", runInBackground: true },
      registry,
      childAgentRunner: async () => { await gate.promise; return { text: "scan done", exitCode: 0 }; }
    });
    const jobId = started.data.jobId;

    const running = await callAgentJob({ args: { action: "status", jobId }, registry });
    expect(running.data.tool).toBe("agent_status");
    expect(running.data.status).toBe("running");
    expect(running.data.kind).toBe("agent");
    expect(running.data.task).toBe("scan the repo");
    expect(running.data.events.some((e) => e.type === "agent.started")).toBe(true);

    gate.resolve();
    await callAgentJob({ args: { action: "wait", jobId }, registry });

    const done = await callAgentJob({ args: { action: "status", jobId }, registry });
    expect(done.data.status).toBe("completed");
    expect(done.data.result.text).toBe("scan done");
  });

  it("status clips the event tail", async () => {
    const registry = new DelegatedJobRegistry();
    const started = await callSpawnAgent({
      args: { task: "noisy", runInBackground: true },
      registry,
      childAgentRunner: async ({ onEvent }) => {
        for (let i = 0; i < 5; i += 1) onEvent?.({ type: `tick-${i}` });
        return { text: "ok", exitCode: 0 };
      }
    });
    const jobId = started.data.jobId;
    await callAgentJob({ args: { action: "wait", jobId }, registry });

    const clipped = await callAgentJob({ args: { action: "status", jobId, tail: 2 }, registry });
    expect(clipped.data.events).toHaveLength(2);
  });

  it("wait returns the child's result (and answers instantly when already settled)", async () => {
    const registry = new DelegatedJobRegistry();
    const started = await callSpawnAgent({
      args: { task: "quick", runInBackground: true },
      registry,
      childAgentRunner: async () => ({ text: "quick result", exitCode: 0, sessionId: "child-1" })
    });
    const jobId = started.data.jobId;

    const first = await callAgentJob({ args: { action: "wait", jobId }, registry });
    expect(first.data.tool).toBe("agent_wait");
    expect(first.data.status).toBe("completed");
    expect(first.data.text).toBe("quick result");
    expect(first.data.result.sessionId).toBe("child-1");
    expect(first.data.timedOut).toBeUndefined();

    // A second wait on a settled job is a no-op read, not another block.
    const second = await callAgentJob({ args: { action: "wait", jobId }, registry });
    expect(second.data.status).toBe("completed");
    expect(second.data.waitedMs).toBe(0);
    expect(listenerCounts(registry, jobId)).toEqual({ event: 0, yield: 0 });
  });

  it("wait surfaces a failed child as an ok result carrying the error (not a throw)", async () => {
    const registry = new DelegatedJobRegistry();
    const started = await callSpawnAgent({
      args: { task: "doomed", runInBackground: true },
      registry,
      childAgentRunner: async () => { throw new Error("child exploded"); }
    });
    const result = await callAgentJob({ args: { action: "wait", jobId: started.data.jobId }, registry });
    expect(isToolResult(result)).toBe(true);
    expect(result.data.status).toBe("failed");
    expect(result.data.error).toMatch(/child exploded/);
  });

  it("wait times out with timedOut:true and leaves NO listener behind", async () => {
    const registry = new DelegatedJobRegistry();
    const gate = deferred();
    const started = await callSpawnAgent({
      args: { task: "endless", runInBackground: true },
      registry,
      childAgentRunner: async () => { await gate.promise; return { text: "eventually", exitCode: 0 }; }
    });
    const jobId = started.data.jobId;
    const before = listenerCounts(registry, jobId);

    const result = await callAgentJob({ args: { action: "wait", jobId, waitMs: 30 }, registry });
    expect(result.data.timedOut).toBe(true);
    expect(result.data.status).toBe("running");
    expect(result.diagnostics.warnings[0]).toMatch(/still running/);
    // THE regression this guards: registry.awaitJobYield would have left its
    // 'yield' listener attached forever on the timed-out path.
    expect(listenerCounts(registry, jobId)).toEqual(before);
    expect(listenerCounts(registry, jobId)).toEqual({ event: 0, yield: 0 });

    gate.resolve();
    await callAgentJob({ args: { action: "wait", jobId }, registry });
  });

  it("wait folds on the turn's abort signal and cleans up its listener", async () => {
    const registry = new DelegatedJobRegistry();
    const gate = deferred();
    const started = await callSpawnAgent({
      args: { task: "endless", runInBackground: true },
      registry,
      childAgentRunner: async () => { await gate.promise; return { text: "eventually", exitCode: 0 }; }
    });
    const jobId = started.data.jobId;
    const controller = new AbortController();
    const pending = callAgentJob({ args: { action: "wait", jobId }, registry, signal: controller.signal });
    controller.abort();
    const result = await pending;

    expect(result.data.interrupted).toBe(true);
    expect(result.data.status).toBe("running");
    expect(listenerCounts(registry, jobId)).toEqual({ event: 0, yield: 0 });

    gate.resolve();
    await callAgentJob({ args: { action: "wait", jobId }, registry });
  });

  it("kill aborts the child and reports it", async () => {
    const registry = new DelegatedJobRegistry();
    let sawAbort = false;
    const started = await callSpawnAgent({
      args: { task: "kill me", runInBackground: true },
      registry,
      childAgentRunner: ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          sawAbort = true;
          reject(new Error("child aborted"));
        }, { once: true });
      })
    });
    const jobId = started.data.jobId;

    const killed = await callAgentJob({ args: { action: "kill", jobId }, registry });
    expect(killed.data.tool).toBe("agent_kill");
    expect(killed.data.killed).toBe(true);
    expect(sawAbort).toBe(true);

    const after = await callAgentJob({ args: { action: "wait", jobId }, registry });
    expect(after.data.status).toBe("failed");
  });

  it("kill is the only action gated as a mutation", async () => {
    const registry = new DelegatedJobRegistry();
    const started = await callSpawnAgent({
      args: { task: "gates", runInBackground: true },
      registry,
      childAgentRunner: async () => ({ text: "ok", exitCode: 0 })
    });
    const jobId = started.data.jobId;
    const gates = [];
    const approvalRequester = vi.fn(async (req) => { gates.push(req); return true; });
    const run = (args) => executeToolCall({
      name: "agent_job",
      args,
      cwd: process.cwd(),
      settings: { approvalMode: "full-auto" },
      approvalRequester,
      jobRegistry: registry,
      sessionId: "s-1"
    });

    await run({ action: "status", jobId });
    await run({ action: "wait", jobId });
    await run({ action: "list" });
    await run({ action: "kill", jobId });

    expect(gates.map((g) => [g.kind, g.mutation])).toEqual([
      ["agent_status", false],
      ["agent_wait", false],
      ["agent_list", false],
      ["agent_kill", true]
    ]);
  });

  it("list returns this session's child agent jobs", async () => {
    const registry = new DelegatedJobRegistry();
    const gate = deferred();
    const a = await callSpawnAgent({
      args: { task: "alpha", runInBackground: true },
      registry,
      childAgentRunner: async () => ({ text: "a", exitCode: 0 })
    });
    const b = await callSpawnAgent({
      args: { task: "beta", runInBackground: true },
      registry,
      childAgentRunner: async () => { await gate.promise; return { text: "b", exitCode: 0 }; }
    });
    // A job owned by ANOTHER session must not show up.
    await callSpawnAgent({
      args: { task: "gamma", runInBackground: true },
      registry,
      childAgentRunner: async () => ({ text: "c", exitCode: 0 }),
      sessionId: "other-session"
    });
    await callAgentJob({ args: { action: "wait", jobId: a.data.jobId }, registry });

    const listed = await callAgentJob({ args: { action: "list" }, registry });
    expect(listed.data.tool).toBe("agent_list");
    expect(listed.data.jobs.map((j) => j.jobId).sort()).toEqual([a.data.jobId, b.data.jobId].sort());
    expect(listed.data.jobs.map((j) => j.task).sort()).toEqual(["alpha", "beta"]);
    expect(listed.data.running).toBe(1);

    gate.resolve();
    await callAgentJob({ args: { action: "wait", jobId: b.data.jobId }, registry });
  });

  it("reports an unknown action instead of throwing", async () => {
    const registry = new DelegatedJobRegistry();
    const result = await callAgentJob({ args: { action: "logs", jobId: "x" }, registry });
    expect(isToolResult(result)).toBe(true);
    expect(result.data.error).toMatch(/status\|wait\|kill\|list/);
  });
});

describe("agent_job access boundary", () => {
  it("cannot see a job owned by another session", async () => {
    const registry = new DelegatedJobRegistry();
    const gate = deferred();
    const other = await callSpawnAgent({
      args: { task: "not yours", runInBackground: true },
      registry,
      childAgentRunner: async () => { await gate.promise; return { text: "x", exitCode: 0 }; },
      sessionId: "other-session"
    });

    for (const action of ["status", "wait", "kill"]) {
      const result = await callAgentJob({ args: { action, jobId: other.data.jobId }, registry, sessionId: "s-1" });
      expect(isToolResult(result)).toBe(true);
      expect(result.data.error).toMatch(/not found/);
      expect(result.summary).toMatch(/Unknown child agent jobId/);
    }
    // ...and the other session's job was untouched by the refused kill.
    expect(registry.getJob(other.data.jobId).status).toBe("running");

    gate.resolve();
    await callAgentJob({ args: { action: "wait", jobId: other.data.jobId }, registry, sessionId: "other-session" });
  });

  it("cannot touch a non-agent (process / run-loop) job", async () => {
    const registry = new DelegatedJobRegistry();
    let killed = false;
    const { jobId } = registry.spawnJob({
      kind: "process",
      driver: { start: () => ({ kill: () => { killed = true; } }) },
      spec: { command: "sleep 1000" },
      meta: { sessionId: "s-1" }
    });

    const status = await callAgentJob({ args: { action: "status", jobId }, registry });
    expect(status.data.error).toMatch(/not found/);
    const kill = await callAgentJob({ args: { action: "kill", jobId }, registry });
    expect(kill.data.error).toMatch(/not found/);
    expect(killed).toBe(false);
  });

  it("does not scope by session when the caller has none (direct / headless)", async () => {
    const registry = new DelegatedJobRegistry();
    const started = await callSpawnAgent({
      args: { task: "headless", runInBackground: true },
      registry,
      childAgentRunner: async () => ({ text: "ok", exitCode: 0 }),
      sessionId: "s-1"
    });
    const result = await callAgentJob({
      args: { action: "wait", jobId: started.data.jobId },
      registry,
      sessionId: null
    });
    expect(result.data.status).toBe("completed");
  });
});

describe("agent_job after a restart (ADR 0037 D4 rehydrate)", () => {
  it("shows a rehydrated running job as failed + restored, not 'unknown job'", async () => {
    // A live registry snapshots its jobs; a FRESH one (the post-restart
    // process) restores them. A job that was running did not survive.
    const live = new DelegatedJobRegistry();
    const gate = deferred();
    const started = await callSpawnAgent({
      args: { task: "survives a restart?", runInBackground: true },
      registry: live,
      childAgentRunner: async () => { await gate.promise; return { text: "never", exitCode: 0 }; }
    });
    const snapshot = live.dehydrateJobs({ sessionId: "s-1" });
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].kind).toBe("agent");

    const restarted = new DelegatedJobRegistry();
    expect(restarted.rehydrateJobs(snapshot)).toBe(1);

    const status = await callAgentJob({
      args: { action: "status", jobId: started.data.jobId },
      registry: restarted
    });
    expect(status.data.status).toBe("failed");
    expect(status.data.restored).toBe(true);
    expect(status.data.error).toMatch(/lost to an agent restart/);
    expect(status.data.note).toMatch(/restart/);
    // wait must not block on a job that can never yield again.
    const waited = await callAgentJob({
      args: { action: "wait", jobId: started.data.jobId },
      registry: restarted
    });
    expect(waited.data.status).toBe("failed");
    expect(waited.data.waitedMs).toBe(0);
    gate.resolve();
    await callAgentJob({ args: { action: "wait", jobId: started.data.jobId }, registry: live });
  });
});
