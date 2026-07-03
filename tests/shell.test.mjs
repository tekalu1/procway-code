import { describe, expect, it } from "vitest";
import { runShell, runShellWait } from "../src/tools/shell.mjs";
import { ShellManager } from "../src/tools/shell-manager.mjs";
import { DelegatedJobRegistry } from "../src/jobs/delegated-jobs.mjs";

describe("runShell — task-artifact-write guard", () => {
  it("refuses POSIX redirect into a task memo.md without spawning", async () => {
    const result = await runShell({
      command: "echo hi > backlogs/TK-9/tasks/plan-todo/memo.md",
      cwd: process.cwd()
    });
    expect(result.kind).toBe("run_shell");
    expect(result.data.refused).toBe(true);
    expect(result.data.artifactWrite).toMatchObject({ kind: "memo" });
    // The hint must steer the agent to the `task put` CLI, since that's the
    // documented mitigation for the underlying memo.md corruption bug.
    expect(result.data.hint).toContain("task put");
    expect(result.data.classification.reasons).toContain("task-artifact-write");
  });

  it("refuses PowerShell Set-Content into a task memo.md", async () => {
    const result = await runShell({
      command: "Set-Content -Encoding utf8 backlogs/TK-9/tasks/lpt/memo.md 'x'",
      cwd: process.cwd()
    });
    expect(result.data.refused).toBe(true);
    expect(result.data.artifactWrite.verb).toBe("powershell-write");
  });

  it("refuses tee into evidence/ with kind=evidence in the hint", async () => {
    const result = await runShell({
      command: "echo x | tee backlogs/TK-9/tasks/lpt/evidence/log.txt",
      cwd: process.cwd()
    });
    expect(result.data.refused).toBe(true);
    expect(result.data.artifactWrite.kind).toBe("evidence");
    expect(result.data.hint).toContain("evidence");
  });
});

describe("runShell — spawn failure handling", () => {
  it("returns a tool error instead of crashing when cwd does not exist", async () => {
    // A non-existent cwd makes child_process emit an async 'error' (ENOENT).
    // Without a handler that becomes an unhandled 'error' and kills the whole
    // serve process; the tool must surface it as a normal error result.
    const result = await runShell({
      command: "echo hi",
      cwd: "/no/such/dir/procway-spawn-failure-test-zzz"
    });
    expect(result.kind).toBe("run_shell");
    expect(result.data.failed).toBe(true);
    expect(result.data.code).toBe("ENOENT");
    expect(result.summary).toContain("Failed to start");
    expect(result.diagnostics?.warnings?.[0]).toContain("spawn failed");
  });
});

// A (shell consolidation): foreground runs stream throttled output tails via
// onProgress so the turn-idle watchdog (90s event silence) and the scheduler
// budget no longer kill healthy long commands.
describe("runShell — foreground progress streaming", () => {
  it("invokes onProgress with output tails while the child runs", async () => {
    const ticks = [];
    const result = await runShell({
      command: "echo first; sleep 0.1; echo second",
      cwd: process.cwd(),
      onProgress: (p) => ticks.push(p.detail)
    });
    expect(result.data.exitCode).toBe(0);
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    expect(ticks[0]).toMatch(/\[\d+s\]/); // elapsed prefix
  });

  it("does not throw when onProgress is omitted (byte-identical legacy path)", async () => {
    const result = await runShell({ command: "echo ok", cwd: process.cwd() });
    expect(result.data.exitCode).toBe(0);
    expect(result.data.stdout).toContain("ok");
  });

  it("a throwing onProgress is swallowed (progress is best-effort)", async () => {
    const result = await runShell({
      command: "echo boom",
      cwd: process.cwd(),
      onProgress: () => { throw new Error("listener bug"); }
    });
    expect(result.data.exitCode).toBe(0);
  });
});

// Long-running orchestration drives (procway run loop / run task) must not be
// killed by the short foreground wall-clock — the outermost shell timer used to
// SIGTERM the whole loop at its base deadline (see
// temporary/investigation-run-loop-timeouts.md).
describe("runShell — long-running command timeout extension", () => {
  it("kills a normal command at its (short) base timeout", async () => {
    const result = await runShell({
      command: "sleep 0.5",
      cwd: process.cwd(),
      timeoutMs: 100
    });
    expect(result.data.timedOut).toBe(true);
    expect(result.data.exitCode).toBe(null);
    expect(result.diagnostics?.warnings?.[0]).toContain("Process timed out after 100ms");
  });

  it("does NOT kill a run-loop drive at the short base timeout (ceiling raised)", async () => {
    // The command text carries the procway run-loop anchor (in a trailing
    // comment so it actually just sleeps); isLongRunningCommand raises the
    // effective ceiling well above the 100ms base, so it runs to completion.
    const result = await runShell({
      command: "sleep 0.3 # procway run loop TK-8",
      cwd: process.cwd(),
      timeoutMs: 100,
      settings: { tools: { longRunningShellTimeoutMs: 60000 } }
    });
    expect(result.data.timedOut).toBe(false);
    expect(result.data.exitCode).toBe(0);
  });
});

// B (shell_job wait): join a background job in ONE call instead of a
// shell_status poll loop (each poll was a full LLM round). ADR 0029 P2: the
// background shell is now a `process` kind delegated job, so wait routes through
// the registry (handle.status()/logs()) — the observable contract is preserved.
describe("runShellWait", () => {
  it("blocks until the background shell exits and returns status + log tail", async () => {
    const registry = new DelegatedJobRegistry();
    const manager = new ShellManager();
    const start = await runShell({
      command: "sleep 0.2; echo done-marker",
      cwd: process.cwd(),
      runInBackground: true,
      shellManager: manager,
      jobRegistry: registry
    });
    const shellId = start.data.shellId;
    const ticks = [];
    const result = await runShellWait({
      shellId,
      waitMs: 10000,
      pollMs: 50,
      heartbeatMs: 100,
      onProgress: (p) => ticks.push(p.detail),
      jobRegistry: registry
    });
    expect(result.data.tool).toBe("shell_wait");
    expect(result.data.status).toBe("exited");
    expect(result.data.exitCode).toBe(0);
    expect(result.data.shellId).toBe(shellId);
    expect(result.summary).toContain("exited");
    // heartbeats fired while waiting
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    await manager.closeAll();
  });

  it("returns timedOut:true (without killing the job) when waitMs elapses first", async () => {
    const registry = new DelegatedJobRegistry();
    const manager = new ShellManager();
    const start = await runShell({
      command: "sleep 5",
      cwd: process.cwd(),
      runInBackground: true,
      shellManager: manager,
      jobRegistry: registry
    });
    const result = await runShellWait({ shellId: start.data.shellId, waitMs: 200, pollMs: 50, jobRegistry: registry });
    expect(result.data.timedOut).toBe(true);
    expect(result.data.status).toBe("running");
    expect(result.diagnostics?.warnings?.[0]).toContain("did not exit");
    await manager.closeAll();
  });

  it("unknown shellId returns the standard missing result", async () => {
    const registry = new DelegatedJobRegistry();
    const result = await runShellWait({ shellId: "nope", jobRegistry: registry });
    expect(result.data.error).toBe("shellId not found");
  });

  it("run_shell background → shell_job wait round-trips through the registry", async () => {
    const registry = new DelegatedJobRegistry();
    const manager = new ShellManager();
    const start = await runShell({
      command: "echo rt-marker",
      cwd: process.cwd(),
      runInBackground: true,
      shellManager: manager,
      jobRegistry: registry
    });
    // The returned shellId is the registry jobId, and the job is registered.
    expect(start.data.runInBackground).toBe(true);
    const job = registry.getJob(start.data.shellId);
    expect(job).not.toBeNull();
    expect(job.kind).toBe("process");
    // awaitJobYield resolves at the process's terminal yield (driver onYield).
    const settled = await registry.awaitJobYield(start.data.shellId);
    expect(["completed", "failed"]).toContain(settled.status);
    // And the wait tool surfaces the same exit through the registry handle.
    const waited = await runShellWait({ shellId: start.data.shellId, waitMs: 5000, pollMs: 50, jobRegistry: registry });
    expect(waited.data.status).toBe("exited");
    expect(waited.data.exitCode).toBe(0);
    expect(waited.data.logsTail.stdout).toContain("rt-marker");
    await manager.closeAll();
  });
});
