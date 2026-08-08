import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DelegatedJobRegistry } from "../src/jobs/delegated-jobs.mjs";
import { saveSessionState } from "../src/session/store.mjs";
import { readSnapshot } from "../src/session/snapshot.mjs";
import { runShellStatus } from "../src/tools/shell.mjs";

// ADR 0037 D4 — delegated jobs survive a session snapshot round-trip.

function makeRegistry(overrides = {}) {
  return new DelegatedJobRegistry({ ttlMs: 60_000, ...overrides });
}

/** A driver that never settles (job stays 'running'). */
const idleDriver = { start: () => ({ kill: () => null }) };

/** A driver that settles immediately with the given yield. */
const settleDriver = (y) => ({ start: (_spec, { onYield }) => { onYield(y); return { kill: () => null }; } });

describe("DelegatedJobRegistry dehydrate/rehydrate (ADR 0037 D4)", () => {
  it("dehydrates only the requested session's jobs, with spec + meta", () => {
    const reg = makeRegistry();
    reg.spawnJob({ kind: "process", driver: idleDriver, spec: { command: "sleep 999" }, meta: { sessionId: "s1" } });
    reg.spawnJob({ kind: "process", driver: idleDriver, spec: { command: "other" }, meta: { sessionId: "s2" } });
    reg.spawnJob({ kind: "process", driver: idleDriver, spec: { command: "orphan" } });

    const jobs = reg.dehydrateJobs({ sessionId: "s1" });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual(expect.objectContaining({
      kind: "process",
      status: "running",
      spec: { command: "sleep 999" },
      meta: { sessionId: "s1" }
    }));
    // No filter → everything.
    expect(reg.dehydrateJobs()).toHaveLength(3);
    reg.__resetForTest();
  });

  it("rehydrates a 'running' job as failed (lost to restart)", () => {
    const reg = makeRegistry();
    reg.spawnJob({ jobId: "job-run", kind: "process", driver: idleDriver, spec: { command: "x" }, meta: { sessionId: "s1" } });
    const dehydrated = reg.dehydrateJobs({ sessionId: "s1" });
    reg.__resetForTest();

    const fresh = makeRegistry();
    expect(fresh.rehydrateJobs(dehydrated)).toBe(1);
    const job = fresh.getJob("job-run");
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/lost to an agent restart/);
    expect(job.restored).toBe(true);
    fresh.__resetForTest();
  });

  it("rehydrates terminal and awaiting-input jobs verbatim", () => {
    const reg = makeRegistry();
    reg.spawnJob({ jobId: "job-done", kind: "agent", driver: settleDriver({ status: "completed", result: { text: "hi" } }), spec: { task: "t" }, meta: { sessionId: "s1" } });
    reg.spawnJob({ jobId: "job-wait", kind: "agent", driver: settleDriver({ status: "awaiting-input", awaiting: { inputKind: "conversational", payload: { q: "?" } } }), spec: { task: "u" }, meta: { sessionId: "s1" } });
    const dehydrated = reg.dehydrateJobs({ sessionId: "s1" });
    reg.__resetForTest();

    const fresh = makeRegistry();
    fresh.rehydrateJobs(dehydrated);
    expect(fresh.getJob("job-done")).toEqual(expect.objectContaining({ status: "completed", result: { text: "hi" } }));
    expect(fresh.getJob("job-wait")).toEqual(expect.objectContaining({
      status: "awaiting-input",
      awaiting: { inputKind: "conversational", payload: { q: "?" } }
    }));
    fresh.__resetForTest();
  });

  it("does not clobber a live job on id collision", () => {
    const reg = makeRegistry();
    reg.spawnJob({ jobId: "dup", kind: "process", driver: idleDriver, spec: {}, meta: { sessionId: "s1" } });
    const before = reg.getJob("dup");
    expect(reg.rehydrateJobs([{ jobId: "dup", kind: "process", status: "completed" }])).toBe(0);
    expect(reg.getJob("dup")).toBe(before);
    expect(reg.getJob("dup").status).toBe("running");
    reg.__resetForTest();
  });

  it("resume of a restored job without a cold-resume settles it failed (no zombie)", () => {
    const fresh = makeRegistry();
    fresh.rehydrateJobs([{ jobId: "job-wait", kind: "agent", status: "awaiting-input", awaiting: { inputKind: "conversational" } }]);
    fresh.resumeJob("job-wait", { answer: "yes" });
    const job = fresh.getJob("job-wait");
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/cannot be cold-resumed/);
    fresh.__resetForTest();
  });

  it("resume of a restored job delegates to a kind cold-resume when provided", () => {
    const fresh = makeRegistry();
    fresh.rehydrateJobs(
      [{ jobId: "job-wait", kind: "agent", status: "awaiting-input", awaiting: { inputKind: "conversational" }, spec: { task: "t" } }],
      {
        coldResumes: {
          agent: (dehydrated, input, { onYield }) => {
            onYield({ status: "completed", result: { text: `resumed:${input.answer}:${dehydrated.spec.task}` } });
            return { kill: () => null };
          }
        }
      }
    );
    fresh.resumeJob("job-wait", { answer: "yes" });
    expect(fresh.getJob("job-wait")).toEqual(expect.objectContaining({
      status: "completed",
      result: { text: "resumed:yes:t" }
    }));
    fresh.__resetForTest();
  });

  it("shell_job status answers from the restored state instead of 'unknown shellId'", async () => {
    const fresh = makeRegistry();
    fresh.rehydrateJobs([{ jobId: "shell-lost", kind: "process", status: "running", spec: { command: "sleep" } }]);
    const result = await runShellStatus({ shellId: "shell-lost", jobRegistry: fresh });
    expect(result.data.restored).toBe(true);
    expect(result.data.status).toBe("failed");
    expect(result.data.error).toMatch(/lost to an agent restart/);
    fresh.__resetForTest();
  });
});

describe("session snapshot round-trip carries delegatedJobs + loadedTools", () => {
  it("saveSessionState → readSnapshot preserves both", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "procway-djobs-"));
    const delegatedJobs = [
      { jobId: "j1", kind: "process", status: "running", spec: { command: "x" }, meta: { sessionId: "sess-1" }, startedAt: 1, updatedAt: 2 }
    ];
    await saveSessionState({
      homeDir,
      sessionId: "sess-1",
      state: {
        sessionId: "sess-1",
        messages: [{ id: "m1", role: "user", content: [{ kind: "text", text: "hi" }] }],
        eventCount: 3,
        loadedTools: ["web_browser"],
        delegatedJobs
      }
    });
    const snapshot = await readSnapshot({ homeDir, sessionId: "sess-1" });
    expect(snapshot.delegatedJobs).toEqual(delegatedJobs);
    expect(snapshot.loadedTools).toEqual(["web_browser"]);
    // Raw file too (no whitelist drop).
    const raw = JSON.parse(await readFile(path.join(homeDir, ".procway", "ai-agent", "sessions", "sess-1", "snapshot.json"), "utf8"));
    expect(raw.delegatedJobs).toHaveLength(1);
  });
});
