import { getSharedShellManager } from "../tools/shell-manager.mjs";

/**
 * ADR 0029 Phase 2 — `process` kind driver for the delegated-job registry.
 *
 * This is a thin adapter over the existing `ShellManager` (P4 removes the
 * redundancy): the registry becomes the front door, ShellManager stays the
 * process-management impl. We do NOT reimplement spawn / ring buffers / kill —
 * the driver just translates ShellManager's lifecycle into the driver contract:
 *
 *   start({ command, cwd, env }, { onEvent, onYield })
 *     → shellManager.start(...) (detached, output captured into ring buffers)
 *     → emits a `process.started` event (carries pid/shellId)
 *     → polls the child; emits throttled `process.progress` events
 *     → on child exit, onYield({ status: exit===0 ? completed : failed,
 *                                result: { exitCode, stdoutTail, stderrTail } })
 *
 * The returned handle hangs `status()` / `logs()` off itself (delegating to
 * ShellManager) so the shell_job tool can read LIVE status/output with full
 * ring-buffer fidelity — the registry itself stays kind-agnostic.
 *
 * Every OBSERVABLE id is the public registry jobId (ADR 0029 P4 review #1): the
 * driver receives `jobId` in its start context and reports it on events, yield
 * results, and the remapped status()/logs() payloads, so ShellManager's internal
 * shellId never leaks out of the process kind.
 *
 * TODO(ADR 0029 P2/P3): interactive stdin — `awaiting-input{inputKind:'stdin'}`
 * + a real resume(input) that writes to the child's stdin — is OUT OF SCOPE for
 * P2 (output-only, matching today's shell_job). ShellManager spawns with
 * stdin:'ignore'; wiring a pipe + prompt detection is future work.
 */

const PROGRESS_THROTTLE_MS = 2000;
// 250ms exit-detection poll. Background jobs (dev servers) can run for hours, so
// a tighter cadence is wasted churn; exit latency of ≤250ms is imperceptible.
const POLL_MS = 250;

export function createProcessDriver({ shellManager } = {}) {
  const manager = shellManager ?? getSharedShellManager();
  return {
    kind: "process",
    start(spec, { onEvent, onYield, jobId }) {
      const { command, cwd, env, label } = spec ?? {};
      // ShellManager's own id stays INTERNAL — only used to reach the manager.
      // Everything observable is keyed by the public jobId so the nested id can
      // never leak out of a process-kind job (P4 review #1).
      const { shellId: managerShellId, pid } = manager.start({ command, cwd, env, label });

      // Synchronous first event so spawnJob's caller can read pid off the job
      // immediately (the registry buffers this before spawnJob returns).
      onEvent({ type: "process.started", jobId, pid });

      let settled = false;
      let lastTick = 0;
      const poll = setInterval(() => {
        try {
          // The manager dropped the job (reaped / closeAll) without us observing
          // 'exited' — settle as failed and stop polling so the interval can't
          // leak for the rest of the host's lifetime.
          if (!settled && typeof manager.has === "function" && !manager.has(managerShellId)) {
            settled = true;
            clearInterval(poll);
            onYield({ status: "failed", result: { exitCode: null, jobId, pid }, error: "process job no longer tracked" });
            return;
          }
          const status = manager.status(managerShellId);
          const nowMs = Date.now();
          if (nowMs - lastTick >= PROGRESS_THROTTLE_MS) {
            lastTick = nowMs;
            const tail = manager.logs(managerShellId, { stream: "both", tail: 1 });
            const line = (tail.stdout || tail.stderr || "").trim().split("\n").pop() ?? "";
            onEvent({ type: "process.progress", runningSec: status.runningSec, line: line.slice(-300) });
          }
          if (status.status === "exited" && !settled) {
            settled = true;
            clearInterval(poll);
            const logs = manager.logs(managerShellId, { stream: "both", tail: 50 });
            const ok = status.exitCode === 0;
            onYield({
              status: ok ? "completed" : "failed",
              result: { exitCode: status.exitCode, jobId, pid, stdoutTail: logs.stdout, stderrTail: logs.stderr },
              ...(ok ? {} : { error: `process exited with code ${status.exitCode ?? "?"}` }),
            });
          }
        } catch { /* best-effort poll: a status/logs throw must not crash the loop */ }
      }, POLL_MS);
      // Never pin the agent event loop on a background job's poll.
      poll.unref?.();

      // Remap ShellManager's nested `shellId` to the public jobId on every
      // payload the shell_job tool reads, so status/logs (and logsTail) only
      // ever surface the public id.
      const remap = (obj) => (obj && typeof obj === "object" ? { ...obj, shellId: jobId } : obj);
      return {
        pid,
        jobId,
        kill: (opts) => manager.kill(managerShellId, opts).then(remap),
        // Process-kind extensions read directly by the shell_job tool — full
        // ring-buffer fidelity, no event-buffer reconstruction.
        status: () => remap(manager.status(managerShellId)),
        logs: (opts) => remap(manager.logs(managerShellId, opts)),
        has: () => manager.has(managerShellId),
        // resume is intentionally absent: stdin injection is P2 out-of-scope.
      };
    },
  };
}
