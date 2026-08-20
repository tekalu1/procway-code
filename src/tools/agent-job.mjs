import { getSharedJobRegistry } from "../jobs/delegated-jobs.mjs";
import { USER_INTERRUPT_MESSAGE } from "../agent/abort.mjs";

/**
 * `agent_job` — the management tool for BACKGROUND child agents (issue #142,
 * ADR 0029 Phase 3 follow-up).
 *
 * `spawn_agent` with `runInBackground:true` starts an `agent` kind delegated
 * job and returns its jobId immediately instead of awaiting the first yield.
 * That is what lets several children run at once (the global semaphore in
 * child-agent.mjs already queues them), but it also means the parent now needs
 * a JOIN primitive. This module is that primitive, and it is deliberately the
 * SAME shape as `shell.mjs`'s shell_job actions (status/logs/wait/kill) — the
 * background shell and the background child agent are the same lifecycle seen
 * through two different drivers, so they read the same way to the model.
 *
 * Access boundary (why every entry point takes `sessionId`):
 *   - only `kind === "agent"` jobs are reachable — a `process` (background
 *     shell) or `run-loop` job must never be killed through this tool;
 *   - when the caller's session is known, only jobs whose `meta.sessionId`
 *     matches are reachable, so one conversation cannot wait on / kill
 *     another's children. `sessionId: null` (direct / headless callers) means
 *     "no session scoping", matching how the rest of the tool layer degrades.
 * An out-of-scope or unknown id is an ok RESULT ("not found"), never a throw:
 * the tool_use block already exists in the transcript and must get its paired
 * tool_result.
 */

const AGENT_JOB_DEFAULT_WAIT_MS = 600000;
const AGENT_JOB_DEFAULT_TAIL = 20;
const HEARTBEAT_MS = 15000;

function resolveRegistry(jobRegistry) {
  return jobRegistry ?? getSharedJobRegistry();
}

/** True when `job` is an agent-kind job this caller is allowed to touch. */
function isVisibleAgentJob(job, sessionId) {
  if (!job || job.kind !== "agent") return false;
  if (sessionId && job.meta?.sessionId !== sessionId) return false;
  return true;
}

/** The job state for `jobId`, or null when unknown / out of this caller's scope. */
function resolveAgentJob(jobId, { registry, sessionId }) {
  if (typeof jobId !== "string" || jobId.length === 0) return null;
  const job = registry.getJob(jobId);
  return isVisibleAgentJob(job, sessionId) ? job : null;
}

function shortId(jobId) {
  return typeof jobId === "string" ? jobId.slice(0, 8) : "?";
}

/**
 * The child's task text, as recorded at spawn. Exported because callers outside
 * this module (the wake supervisor names a settled child by its task) need it
 * while the job registry stays behind this module.
 */
export function agentJobTaskExcerpt(job) {
  // The task text lives on the `agent.started` event the driver emits
  // synchronously at spawn (already clipped to 120 chars there).
  const started = (job?.events ?? []).find((e) => e?.type === "agent.started");
  return typeof started?.task === "string" ? started.task : "";
}

function eventsTail(job, tail) {
  const limit = Number.isFinite(tail) && tail >= 0 ? Math.floor(tail) : AGENT_JOB_DEFAULT_TAIL;
  const events = Array.isArray(job?.events) ? job.events : [];
  return limit === 0 ? [] : events.slice(-limit);
}

function describeJob(job, tail) {
  return {
    jobId: job.jobId,
    kind: job.kind,
    status: job.status,
    ...(job.result !== undefined ? { result: job.result } : {}),
    ...(job.error !== undefined ? { error: job.error } : {}),
    ...(job.awaiting !== undefined ? { awaiting: job.awaiting } : {}),
    ...(job.restored === true ? { restored: true } : {}),
    task: agentJobTaskExcerpt(job),
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    events: eventsTail(job, tail)
  };
}

function makeMissingResult(tool, jobId) {
  return {
    kind: "spawn_agent",
    summary: `Unknown child agent jobId: ${jobId ?? ""}`,
    data: {
      tool,
      jobId: jobId ?? null,
      error: "jobId not found (it is unknown, already evicted, not a child-agent job, or belongs to another session)"
    }
  };
}

function summariseSettled(job) {
  if (job.status === "completed") {
    const text = typeof job.result?.text === "string" ? job.result.text.replace(/\s+/g, " ").trim() : "";
    return text ? `completed: ${text.slice(0, 80)}` : `completed (exit ${job.result?.exitCode ?? 0})`;
  }
  if (job.status === "failed") return `failed: ${job.error ?? "unknown error"}`;
  return job.status;
}

/**
 * `action: "status"` — one-shot inspection of a background child. Never blocks.
 * A job restored from a session snapshot (ADR 0037 D4) answers truthfully here
 * (`restored: true`, `status: "failed"`, an explicit lost-to-restart error)
 * instead of pretending the id is unknown.
 */
export async function runAgentJobStatus({ jobId, tail, jobRegistry, sessionId = null } = {}) {
  const registry = resolveRegistry(jobRegistry);
  const job = resolveAgentJob(jobId, { registry, sessionId });
  if (!job) return makeMissingResult("agent_status", jobId);
  const described = describeJob(job, tail);
  const restoredNote = job.restored === true
    ? { note: "This child predates an agent restart and did not survive it; start it again if its work is still needed." }
    : {};
  return {
    kind: "spawn_agent",
    summary: `child ${shortId(job.jobId)}: ${job.status === "running" ? "running" : summariseSettled(job)}`,
    data: { tool: "agent_status", ...described, ...restoredNote }
  };
}

/**
 * `action: "wait"` — BLOCK until the child yields (completed / failed /
 * awaiting-input), `waitMs` elapses, or the turn is aborted. This is how a
 * background child's result is COLLECTED.
 *
 * Why this does not just call `registry.awaitJobYield(jobId)`: that helper
 * attaches an emitter listener that is only removed when the yield actually
 * arrives, so a timed-out (or aborted) wait would leave a listener attached to
 * the job's emitter forever — one leak per timed-out wait, on the long-lived
 * process-wide registry. `subscribeJob` hands back an unsubscribe, so we race
 * it against the timer / abort ourselves and always clean up.
 */
export async function runAgentJobWait({
  jobId,
  waitMs = AGENT_JOB_DEFAULT_WAIT_MS,
  tail,
  onProgress = null,
  signal = null,
  jobRegistry,
  sessionId = null
} = {}) {
  const registry = resolveRegistry(jobRegistry);
  const job = resolveAgentJob(jobId, { registry, sessionId });
  if (!job) return makeMissingResult("agent_wait", jobId);

  const startedAtMs = Date.now();
  const emitProgress = (detail) => {
    if (typeof onProgress !== "function") return;
    try { onProgress({ detail }); } catch { /* progress is best-effort */ }
  };

  // Already settled (or restored from a snapshot) → answer immediately.
  if (job.status !== "running") {
    return makeWaitResult({ job, tail, waitedMs: 0 });
  }
  if (signal?.aborted) {
    return makeWaitResult({ job, tail, waitedMs: 0, interrupted: true });
  }

  const effectiveWaitMs = Number.isFinite(waitMs) && waitMs > 0 ? waitMs : AGENT_JOB_DEFAULT_WAIT_MS;
  const outcome = await new Promise((resolve) => {
    let done = false;
    let unsubscribe = null;
    let sawYieldBeforeSubscribeReturned = false;
    let timer = null;
    let heartbeat = null;
    let onAbort = null;

    const finish = (value) => {
      if (done) return;
      done = true;
      try { unsubscribe?.(); } catch { /* best-effort */ }
      if (timer) clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
      if (onAbort) {
        try { signal.removeEventListener?.("abort", onAbort); } catch { /* ignore */ }
      }
      resolve(value);
    };

    const handler = (env) => {
      if (env?.type !== "yield") return;
      // subscribeJob replays a settle synchronously, i.e. BEFORE it has handed
      // back the unsubscribe — finishing here would leak the listener we are
      // standing in. Flag it and finish once the handle exists.
      if (unsubscribe === null) {
        sawYieldBeforeSubscribeReturned = true;
        return;
      }
      finish("settled");
    };
    unsubscribe = registry.subscribeJob(jobId, handler);
    if (sawYieldBeforeSubscribeReturned) {
      finish("settled");
      return;
    }

    timer = setTimeout(() => finish("timedOut"), effectiveWaitMs);
    timer?.unref?.();

    heartbeat = setInterval(() => {
      const runningSec = Math.floor((Date.now() - startedAtMs) / 1000);
      emitProgress(`waiting on child agent ${shortId(jobId)} (${runningSec}s)`);
    }, HEARTBEAT_MS);
    heartbeat?.unref?.();

    if (signal) {
      onAbort = () => finish("interrupted");
      signal.addEventListener?.("abort", onAbort, { once: true });
    }
  });

  // Re-read: the state object is live, but a terminal settle may have replaced
  // result/error since the pre-check above.
  const latest = registry.getJob(jobId) ?? job;
  return makeWaitResult({
    job: latest,
    tail,
    waitedMs: Date.now() - startedAtMs,
    timedOut: outcome === "timedOut",
    interrupted: outcome === "interrupted"
  });
}

function makeWaitResult({ job, tail, waitedMs, timedOut = false, interrupted = false }) {
  const described = describeJob(job, tail);
  const data = { tool: "agent_wait", ...described, waitedMs };
  if (interrupted) {
    return {
      kind: "spawn_agent",
      summary: `${USER_INTERRUPT_MESSAGE} while waiting on child ${shortId(job.jobId)}`,
      data: { ...data, interrupted: true }
    };
  }
  if (timedOut) {
    return {
      kind: "spawn_agent",
      summary: `child ${shortId(job.jobId)} still running after ${Math.floor(waitedMs / 1000)}s wait`,
      data: { ...data, timedOut: true },
      diagnostics: {
        warnings: [`child agent ${shortId(job.jobId)} did not finish within ${waitedMs}ms — still running. Wait again, check status, or kill it.`]
      }
    };
  }
  return {
    kind: "spawn_agent",
    summary: `child ${shortId(job.jobId)}: ${summariseSettled(job)}`,
    data: {
      ...data,
      ...(typeof job.result?.text === "string" ? { text: job.result.text } : {}),
      ...(job.restored === true
        ? { note: "This child predates an agent restart and did not survive it; start it again if its work is still needed." }
        : {})
    }
  };
}

/**
 * `action: "kill"` — stop a background child. Routed through `abortJob` (fires
 * the job's AbortSignal AND calls the driver handle's kill), so the child's own
 * settle path still produces the terminal state.
 */
export async function runAgentJobKill({ jobId, jobRegistry, sessionId = null } = {}) {
  const registry = resolveRegistry(jobRegistry);
  const job = resolveAgentJob(jobId, { registry, sessionId });
  if (!job) return makeMissingResult("agent_kill", jobId);
  registry.abortJob(jobId);
  const latest = registry.getJob(jobId) ?? job;
  return {
    kind: "spawn_agent",
    summary: `kill sent to child ${shortId(jobId)} (status ${latest.status})`,
    data: { tool: "agent_kill", jobId, killed: true, status: latest.status, task: agentJobTaskExcerpt(latest) }
  };
}

/** Every agent-kind job this caller owns (running and settled alike). */
function listAgentJobs({ jobRegistry, sessionId = null } = {}) {
  const registry = resolveRegistry(jobRegistry);
  return registry.listJobs().filter((job) => isVisibleAgentJob(job, sessionId));
}

/** `action: "list"` — the caller's own child-agent jobs, newest activity first. */
export async function runAgentJobList({ jobRegistry, sessionId = null } = {}) {
  const jobs = listAgentJobs({ jobRegistry, sessionId })
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((job) => ({
      jobId: job.jobId,
      status: job.status,
      task: agentJobTaskExcerpt(job),
      startedAt: job.startedAt,
      updatedAt: job.updatedAt
    }));
  const running = jobs.filter((job) => job.status === "running").length;
  return {
    kind: "spawn_agent",
    summary: `${jobs.length} child agent job(s), ${running} running`,
    data: { tool: "agent_list", jobs, running }
  };
}
