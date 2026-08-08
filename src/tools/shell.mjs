import { spawn } from "node:child_process";
import path from "node:path";
import { getShellProfile } from "../platform/shell-profile.mjs";
import { classifyCommand, detectTaskArtifactWrite, isLongRunningCommand, DEFAULT_LONG_RUNNING_SHELL_TIMEOUT_MS } from "../safety/command-classifier.mjs";
import { resolveSandbox, wrapShellCommand } from "../safety/sandbox.mjs";
import { getSharedJobRegistry } from "../jobs/delegated-jobs.mjs";
import { createProcessDriver } from "../jobs/process-driver.mjs";
import { decodeShellBytes } from "../adapters/tui/input-preprocessor.mjs";
import { USER_INTERRUPT_MESSAGE } from "../agent/abort.mjs";
import { KILL_ESCALATION_MS, SUPPORTS_PROCESS_GROUPS, killProcessTree } from "./process-tree.mjs";

/** Foreground shells currently running. Used only by the process-exit reaper
 *  below; entries are removed as soon as the child closes. */
const activeForegroundChildren = new Set();
let exitReaperInstalled = false;

function trackForegroundChild(child) {
  activeForegroundChildren.add(child);
  if (exitReaperInstalled) return;
  exitReaperInstalled = true;
  // 'exit' handlers must be synchronous — process.kill is, so this works even
  // for an immediate process.exit(130).
  process.on("exit", () => {
    for (const tracked of activeForegroundChildren) {
      killProcessTree(tracked, "SIGKILL");
    }
    activeForegroundChildren.clear();
  });
}

export async function runShell({
  command,
  cwd = process.cwd(),
  // 300s default (was 120s): with progress events keeping the turn-idle
  // watchdog fed (see onProgress below), waiting out an install / test run /
  // `task complete` checkAgant pass in the FOREGROUND is the intended happy
  // path — backgrounding is only for processes that never exit.
  timeoutMs = 300000,
  maxOutputBytes = 200000,
  runInBackground = false,
  settings,
  shellManager,
  // Delegated-job registry the background path routes through (ADR 0029 P2).
  // Injectable for tests; defaults to the process-wide shared registry.
  jobRegistry,
  // Owning AgentSession id (ADR 0037 D4): stamped onto the background job's
  // meta so the session snapshot can dehydrate/rehydrate ITS jobs across a
  // Pod restart. Null for direct/headless callers (job is then snapshot-less).
  sessionId = null,
  // Called with `{ detail }` while the foreground child runs: throttled
  // output tails as they stream in, plus a periodic heartbeat when the child
  // is silent. The caller (turn-orchestrator via registry) forwards these as
  // `activity.tick` events, which (a) feed the 90s turn-idle watchdog so a
  // long-but-healthy foreground command no longer aborts the TURN, and
  // (b) give the ChatPanel live output. Null → byte-identical to before.
  onProgress = null,
  // The turn's AbortSignal (user Stop / idle watchdog). On abort the child's
  // whole process GROUP is terminated and the tool settles as interrupted.
  signal = null
} = {}) {
  const classification = classifyCommand(command);
  // A Stop that landed while this call was queued must not start a process.
  if (signal?.aborted) {
    return {
      kind: "run_shell",
      summary: `${USER_INTERRUPT_MESSAGE}: ${truncateInline(command, 60)}`,
      data: {
        command,
        cwd: path.resolve(cwd),
        interrupted: true,
        exitCode: null,
        stdout: "",
        stderr: "",
        classification
      }
    };
  }

  // Hard guard: refuse direct writes to tasks/<task>/(memo.md|evidence/|report/).
  // These artifacts must be deposited via the `task put` API, which routes
  // through the dashboard's encoding-safe writer. Shell-level redirects on
  // Windows PowerShell 5.1 corrupt Japanese text into `?` and add a UTF-8
  // BOM (see backlogs/TK-9/tasks/plan-todo/memo.md for the actual
  // failure mode). The block fires before any approval gate because this
  // is a correctness contract, not a permission — auto-approve mode is
  // exactly the scenario where the worker bypassed `task put` last time.
  const artifactWrite = detectTaskArtifactWrite(command);
  if (artifactWrite) {
    return {
      kind: "run_shell",
      summary: `Refused: shell write to task ${artifactWrite.kind} (use task put)`,
      data: {
        command,
        cwd: path.resolve(cwd),
        refused: true,
        classification,
        artifactWrite,
        hint: buildArtifactWriteHint(artifactWrite)
      }
    };
  }

  const sandbox = resolveSandbox({ settings });
  const wrapped = wrapShellCommand({ command, sandbox });
  const effectiveCommand = wrapped.command;
  const sandboxNotes = wrapped.notes ?? [];
  const baseTimeout = Number.isFinite(sandbox?.timeoutMs) ? Number(sandbox.timeoutMs) : timeoutMs;
  // A procway orchestration drive (run loop / run task) legitimately runs for
  // hours; the short foreground wall-clock would SIGTERM the whole loop before
  // any task finishes. Raise (never lower) the ceiling for these — liveness is
  // already covered by the turn-idle watchdog (fed by the heartbeats below) and
  // the CLI's own per-task timeouts. See command-classifier isLongRunningCommand.
  const effectiveTimeout = isLongRunningCommand(command)
    ? Math.max(baseTimeout, settings?.tools?.longRunningShellTimeoutMs ?? DEFAULT_LONG_RUNNING_SHELL_TIMEOUT_MS)
    : baseTimeout;

  if (runInBackground) {
    // ADR 0029 P2: route the background shell through the delegated-job registry
    // as a `process` kind. The registry mints the jobId, which we surface AS the
    // shellId so the existing tool-result contract (and shell_job callers) are
    // unchanged — the process driver wraps the shared ShellManager underneath.
    const registry = jobRegistry ?? getSharedJobRegistry();
    const driver = createProcessDriver({ shellManager });
    const { jobId } = registry.spawnJob({
      kind: "process",
      driver,
      spec: { command: effectiveCommand, cwd },
      ...(sessionId ? { meta: { sessionId } } : {})
    });
    const handle = registry.getJobHandle(jobId);
    const pid = handle?.pid ?? null;
    return {
      kind: "run_shell",
      summary: `Started bg pid=${pid ?? "?"} shellId=${jobId.slice(0, 8)}`,
      data: {
        command,
        cwd: path.resolve(cwd),
        runInBackground: true,
        shellId: jobId,
        pid: pid ?? null,
        status: "running",
        classification,
        sandbox: sandboxNotes
      }
    };
  }

  const profile = getShellProfile();
  const child = spawn(profile.shell, [...profile.args, profile.commandPrefix + effectiveCommand], {
    cwd: path.resolve(cwd),
    env: { ...process.env, ...(profile.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    // Make the shell a process-group leader so timeout/abort can kill the
    // whole tree (see killProcessTree). We deliberately do NOT unref() — the
    // foreground path still awaits this child.
    detached: SUPPORTS_PROCESS_GROUPS
  });
  // Safety net for the paths that DON'T go through abort: a detached child no
  // longer receives the terminal's Ctrl+C (that is the point — we want the kill
  // to be deterministic), so a hard `process.exit()` (the TUI's second Ctrl+C)
  // would otherwise leave the group running. Sync group-SIGKILL on exit.
  trackForegroundChild(child);

  const stdoutChunks = [];
  const stderrChunks = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let timedOut = false;
  let interrupted = false;
  let escalationTimer = null;
  let settled = false;

  // Single termination path for BOTH the timeout and the abort: SIGTERM the
  // process group, then SIGKILL it if anything is still alive after the grace
  // window. Previously the timeout's lone child.kill("SIGTERM") was the only
  // stop mechanism and it never reached grandchildren.
  const terminate = () => {
    if (settled) return;
    killProcessTree(child, "SIGTERM");
    if (escalationTimer) return;
    escalationTimer = setTimeout(() => {
      if (settled) return;
      killProcessTree(child, "SIGKILL");
    }, KILL_ESCALATION_MS);
    try { escalationTimer.unref?.() } catch { /* mock timers */ }
  };

  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, effectiveTimeout);

  let onAbort = null;
  if (signal) {
    onAbort = () => {
      interrupted = true;
      terminate();
    };
    signal.addEventListener?.("abort", onAbort, { once: true });
  }

  // Progress plumbing: throttle streamed output to one event per window so a
  // chatty build doesn't flood the event log, and heartbeat when silent so
  // the idle watchdog still sees life (e.g. a long compile with no output).
  const PROGRESS_THROTTLE_MS = 2000;
  const HEARTBEAT_MS = 20000;
  const startedAtMs = Date.now();
  let lastProgressAt = 0;
  let pendingTail = "";
  const emitProgress = (detail) => {
    if (typeof onProgress !== "function") return;
    try { onProgress({ detail }) } catch { /* progress is best-effort */ }
  };
  const noteOutput = (chunk) => {
    if (typeof onProgress !== "function") return;
    pendingTail = (pendingTail + decodeShellBytes(chunk)).slice(-500);
    const now = Date.now();
    if (now - lastProgressAt >= PROGRESS_THROTTLE_MS) {
      lastProgressAt = now;
      const tail = pendingTail.trim().split("\n").pop() ?? "";
      pendingTail = "";
      emitProgress(`[${Math.floor((now - startedAtMs) / 1000)}s] ${tail.slice(-300)}`);
    }
  };
  let heartbeat = null;
  if (typeof onProgress === "function") {
    heartbeat = setInterval(() => {
      const now = Date.now();
      if (now - lastProgressAt < HEARTBEAT_MS) return; // recent output already reported
      lastProgressAt = now;
      emitProgress(`still running (${Math.floor((now - startedAtMs) / 1000)}s elapsed): ${truncateInline(command, 80)}`);
    }, HEARTBEAT_MS);
    try { heartbeat.unref?.() } catch { /* mock timers */ }
  }

  child.stdout.on("data", (chunk) => {
    noteOutput(chunk);
    if (stdoutBytes < maxOutputBytes) {
      const remain = maxOutputBytes - stdoutBytes;
      const slice = chunk.length > remain ? chunk.subarray(0, remain) : chunk;
      stdoutChunks.push(slice);
      stdoutBytes += slice.length;
    }
  });
  child.stderr.on("data", (chunk) => {
    noteOutput(chunk);
    if (stderrBytes < maxOutputBytes) {
      const remain = maxOutputBytes - stderrBytes;
      const slice = chunk.length > remain ? chunk.subarray(0, remain) : chunk;
      stderrChunks.push(slice);
      stderrBytes += slice.length;
    }
  });

  // A spawn failure (ENOENT: the shell binary is missing, or — far more
  // commonly — the resolved `cwd` does not exist) fires an asynchronous
  // 'error' event on the child. With no listener it becomes an unhandled
  // 'error' and CRASHES the whole ai-agent serve process (one bad tool call
  // takes the entire session down). Listen for it and resolve into a tool
  // error result instead, so the model sees the failure and can recover.
  let spawnError = null;
  const exitCode = await new Promise((resolve) => {
    child.on("error", (err) => {
      spawnError = err;
      resolve(null);
    });
    child.on("close", resolve);
  });
  settled = true;
  activeForegroundChildren.delete(child);
  clearTimeout(timer);
  if (escalationTimer) clearTimeout(escalationTimer);
  if (heartbeat) clearInterval(heartbeat);
  if (onAbort) {
    try { signal.removeEventListener?.("abort", onAbort); } catch { /* ignore */ }
  }

  if (spawnError) {
    const code = spawnError.code ?? spawnError.name ?? "SPAWN_ERROR";
    const hint = code === "ENOENT"
      ? ` (cwd "${path.resolve(cwd)}" may not exist, or the shell binary is missing)`
      : "";
    return {
      kind: "run_shell",
      summary: `Failed to start command: ${code}${hint}`,
      data: {
        command,
        cwd: path.resolve(cwd),
        failed: true,
        error: spawnError.message,
        code,
        classification
      },
      diagnostics: { warnings: [`spawn failed: ${spawnError.message}${hint}`] }
    };
  }

  // Decode after collecting bytes so OEM-codepage output (CP932 on Japanese
  // Windows) can be detected and re-decoded. cmd.exe built-ins like `dir`
  // emit OEM bytes regardless of the codepage prefix when stdout is piped.
  const stdout = decodeShellBytes(Buffer.concat(stdoutChunks));
  const stderr = decodeShellBytes(Buffer.concat(stderrChunks));

  const data = {
    command,
    cwd: path.resolve(cwd),
    exitCode,
    timedOut,
    ...(interrupted ? { interrupted: true } : {}),
    stdout,
    stderr,
    classification,
    ...(sandboxNotes.length > 0 ? { sandbox: sandboxNotes } : {})
  };
  // An interrupted run still returns a normal (non-throwing) ToolResult: the
  // tool_use block already exists in the transcript, so it MUST get its paired
  // tool_result or the next provider request is invalid.
  const summary = interrupted
    ? `${USER_INTERRUPT_MESSAGE}: ${truncateInline(command, 60)}`
    : `Ran: ${truncateInline(command, 60)} (exit ${exitCode}${timedOut ? ", timed out" : ""})`;
  const result = {
    kind: "run_shell",
    summary,
    data
  };
  if (interrupted) {
    result.diagnostics = { warnings: [`${USER_INTERRUPT_MESSAGE} — the command's process group was terminated.`] };
  } else if (timedOut) {
    result.diagnostics = { warnings: [`Process timed out after ${effectiveTimeout}ms`] };
  }
  return result;
}

/**
 * Resolve the process-kind driver handle for a job (the front door is the
 * delegated-job registry, ADR 0029 P2). Returns null when the job is unknown or
 * is not a process-kind job (no status()/logs() handle). The handle already
 * wraps whichever ShellManager the job was spawned with, so the shell_job
 * actions never touch a manager directly.
 */
function resolveProcessHandle(shellId, jobRegistry) {
  const registry = jobRegistry ?? getSharedJobRegistry();
  if (!registry.getJob(shellId)) return null;
  const handle = registry.getJobHandle(shellId);
  return handle && typeof handle.status === "function" ? handle : null;
}

/**
 * ADR 0037 D4: a job REHYDRATED from a session snapshot after a restart has no
 * live process handle (status()/logs() died with the old process) — but the
 * registry still knows its settled state. Answer from that state instead of
 * the misleading "unknown shellId" so callers see the truth (typically
 * `failed: job lost to an agent restart`).
 */
function makeRestoredJobResult(tool, shellId, job) {
  return {
    kind: "run_shell",
    summary: `${job.status} (restored after restart)`,
    data: {
      tool,
      shellId,
      status: job.status,
      restored: true,
      ...(job.error ? { error: job.error } : {}),
      note: "This job predates an agent restart; live status/logs are unavailable. Re-run the command if its work is still needed."
    }
  };
}

/** Job state when the registry knows the id but no live process handle exists
 *  (a snapshot-restored job). Null when the id is unknown or the job is live. */
function restoredJobState(shellId, jobRegistry) {
  const registry = jobRegistry ?? getSharedJobRegistry();
  const job = registry.getJob(shellId);
  if (!job) return null;
  const handle = registry.getJobHandle(shellId);
  return handle && typeof handle.status === "function" ? null : job;
}

export async function runShellStatus({ shellId, jobRegistry }) {
  const handle = resolveProcessHandle(shellId, jobRegistry);
  if (!handle) {
    const restored = restoredJobState(shellId, jobRegistry);
    if (restored) return makeRestoredJobResult("shell_status", shellId, restored);
    return makeMissingResult("shell_status", shellId);
  }
  const status = handle.status();
  return {
    kind: "run_shell",
    summary: `${status.status} (pid=${status.pid ?? "?"}, exit=${status.exitCode ?? "-"})`,
    data: { tool: "shell_status", ...status, shellId }
  };
}

export async function runShellLogs({ shellId, stream = "both", tail = null, jobRegistry }) {
  const handle = resolveProcessHandle(shellId, jobRegistry);
  if (!handle) {
    const restored = restoredJobState(shellId, jobRegistry);
    if (restored) return makeRestoredJobResult("shell_logs", shellId, restored);
    return makeMissingResult("shell_logs", shellId);
  }
  const logs = handle.logs({ stream, tail });
  return {
    kind: "run_shell",
    summary: `logs(${shellId.slice(0, 8)}) ${logs.truncated ? "[truncated]" : ""}`.trim(),
    data: { tool: "shell_logs", ...logs, shellId }
  };
}

/**
 * Block until a background shell exits (or `waitMs` elapses), emitting
 * heartbeat progress while waiting. This is the JOIN primitive for jobs
 * started with runInBackground:true — it collapses the old
 * "shell_status poll → think → poll again" loop (one LLM round per poll)
 * into a single tool call. Heartbeats ride the same onProgress channel as
 * runShell's foreground streaming, so the turn-idle watchdog stays fed.
 */
export async function runShellWait({
  shellId,
  waitMs = 600000,
  pollMs = 250,
  heartbeatMs = 15000,
  onProgress = null,
  jobRegistry,
  // A Stop must break this poll loop too — it can legitimately block for
  // minutes, which used to keep a "stopped" turn alive until waitMs elapsed.
  signal = null
} = {}) {
  // ADR 0029 P2: the job is owned by the registry; the process driver's handle
  // exposes live status()/logs() (full ring-buffer fidelity). We keep the poll
  // loop here (the ADR allows "poll getJob") so the rich shell_wait contract —
  // heartbeats, logsTail, timedOut-without-killing — is byte-preserved.
  const handle = resolveProcessHandle(shellId, jobRegistry);
  if (!handle) {
    const restored = restoredJobState(shellId, jobRegistry);
    if (restored) return makeRestoredJobResult("shell_wait", shellId, restored);
    return makeMissingResult("shell_wait", shellId);
  }
  const startedAtMs = Date.now();
  let lastBeat = startedAtMs;
  const emitProgress = (detail) => {
    if (typeof onProgress !== "function") return;
    try { onProgress({ detail }) } catch { /* best-effort */ }
  };
  while (true) {
    if (signal?.aborted) {
      const status = handle.status();
      return {
        kind: "run_shell",
        summary: `${USER_INTERRUPT_MESSAGE} while waiting on ${shellId.slice(0, 8)}`,
        data: {
          tool: "shell_wait",
          ...status,
          shellId,
          waitedMs: Date.now() - startedAtMs,
          interrupted: true
        }
      };
    }
    const status = handle.status();
    if (status.status === "exited") {
      const logs = handle.logs({ stream: "both", tail: 50 });
      return {
        kind: "run_shell",
        summary: `exited (code ${status.exitCode ?? "-"}) after ${status.runningSec}s`,
        data: { tool: "shell_wait", ...status, shellId, waitedMs: Date.now() - startedAtMs, logsTail: logs }
      };
    }
    const elapsed = Date.now() - startedAtMs;
    if (elapsed >= waitMs) {
      return {
        kind: "run_shell",
        summary: `still running after ${Math.floor(elapsed / 1000)}s wait (pid=${status.pid ?? "?"})`,
        data: { tool: "shell_wait", ...status, shellId, waitedMs: elapsed, timedOut: true },
        diagnostics: { warnings: [`shell ${shellId.slice(0, 8)} did not exit within ${waitMs}ms — still running. Wait again, check logs, or kill it.`] }
      };
    }
    if (Date.now() - lastBeat >= heartbeatMs) {
      lastBeat = Date.now();
      const tailLine = handle.logs({ stream: "both", tail: 1 });
      const line = (tailLine.stdout || tailLine.stderr || "").trim().split("\n").pop() ?? "";
      emitProgress(`waiting on ${shellId.slice(0, 8)} (${status.runningSec}s): ${line.slice(-200)}`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export async function runShellKill({ shellId, signal = "SIGTERM", graceMs = 0, jobRegistry }) {
  const handle = resolveProcessHandle(shellId, jobRegistry);
  if (!handle) {
    const restored = restoredJobState(shellId, jobRegistry);
    if (restored) return makeRestoredJobResult("shell_kill", shellId, restored);
    return makeMissingResult("shell_kill", shellId);
  }
  const result = await handle.kill({ signal, graceMs });
  return {
    kind: "run_shell",
    summary: result.alreadyExited
      ? `already exited (code ${result.exitCode ?? "-"})`
      : `kill sent (signal=${signal})`,
    data: { tool: "shell_kill", ...result, shellId }
  };
}

function makeMissingResult(tool, shellId) {
  return {
    kind: "run_shell",
    summary: `Unknown shellId: ${shellId}`,
    data: { tool, shellId, error: "shellId not found" }
  };
}

function truncateInline(text, max) {
  if (typeof text !== "string") return "";
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function buildArtifactWriteHint(artifactWrite) {
  const example = artifactWrite.kind === "memo"
    ? `node "$PROCWAY_CLI" task put <project> <ticket> <task> memo --content '<text>'`
    : `node "$PROCWAY_CLI" task put <project> <ticket> <task> ${artifactWrite.kind} <name> --from <path>`;
  return (
    `Direct shell writes to tasks/<task>/${artifactWrite.kind === "memo" ? "memo.md" : `${artifactWrite.kind}/<name>`} ` +
    `are blocked. They bypass the dashboard's encoding-safe writer and ` +
    `corrupt non-ASCII text on Windows PowerShell 5.1 (UTF-8 BOM + '?' ` +
    `substitution). Use the procway CLI instead:\n  ${example}`
  );
}

