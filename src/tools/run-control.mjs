/**
 * run-control — typed facade over the dashboard's async run-loop job API
 * (ADR 0028 Phase 2 / ADR 0029 Phase 1).
 *
 * The side-panel AI is the DRIVER of a ticket's run loop, but it must drive it
 * through a structured tool, NOT by improvising a `node "$PROCWAY_CLI" run loop`
 * shell string (the #122 層2b hazard — free-form `run_shell` lets the model
 * impersonate the worker / orchestrate the loop itself).
 *
 *  - start_run     → POST   $PROCWAY_DASHBOARD_URL/api/run/jobs
 *  - get_run_status→ GET    $PROCWAY_DASHBOARD_URL/api/run/jobs/<jobId>
 *  - resume_run    → POST   $PROCWAY_DASHBOARD_URL/api/run/jobs/resume
 *  - reply_run     → POST   $PROCWAY_DASHBOARD_URL/api/run/jobs/conversational-resume
 *
 * ADR 0029 await-yield: start_run / resume_run / reply_run are NO LONGER
 * fire-and-forget. After minting the jobId they INTERNALLY poll the job until it
 * leaves `running` (the run pauses for input, or finishes), then RETURN a
 * normalized yield — the side-panel AI thus "awaits the run as a sub-agent" and
 * receives the hearing the loop paused on. ADR 0028 Phase 2's fire-and-forget
 * lost the plan-todo hearing (TK-8) because the AI ended its turn before the
 * loop paused; await-yield restores the rendezvous. The poll is a transport
 * detail: each poll fires `onProgress` so the turn-idle watchdog stays fed
 * during the (minutes-long) await, and the scheduler grants these tools the
 * long-running budget (turn-orchestrator toolCallBudgetMs).
 *
 * The yield's `inputKind` tells the AI how to resolve a pause:
 *  - 'conversational' → a plain-text hearing (no UIR widget); the AI relays the
 *    `hearing` text to the user and calls `reply_run` with their answer.
 *  - 'structured'     → a UIR widget pause; the user answers the widget (the
 *    authenticity gate — a callback/chat session self-resolving is blocked 403),
 *    then the AI calls `resume_run`.
 *
 * Requests carry the session-scoped token in the `x-procway-session` header
 * (the same single transport save_attachment / attach_file use).
 */

/** Header carrying the session-scoped token to the dashboard (02.auth.ts). */
const SESSION_TOKEN_HEADER = "x-procway-session";

/** Default timeout for one job API call. */
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/** await-yield poll cadence: how long between status polls. */
const DEFAULT_POLL_INTERVAL_MS = 2_000;

/** await-yield per-poll abort (mirrors the existing per-fetch AbortSignal). */
const DEFAULT_POLL_TIMEOUT_MS = 5_000;

/** Real sleep (injectable in tests so await-yield resolves instantly). */
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function resolveBase(dashboardUrl) {
  if (!dashboardUrl) throw new Error("PROCWAY_DASHBOARD_URL is not set");
  return dashboardUrl.replace(/\/+$/, "");
}

function authHeaders(proxyToken, extra = {}) {
  return proxyToken ? { ...extra, [SESSION_TOKEN_HEADER]: proxyToken } : { ...extra };
}

/**
 * Read a useful error message off a non-OK response so the model sees what went
 * wrong (status + body, JSON `error.message` when present, else raw text).
 */
async function errorFromResponse(res, label) {
  let detail = "";
  try {
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      detail = json?.data?.error?.message ?? json?.error?.message ?? json?.message ?? json?.statusMessage ?? text;
    } catch {
      detail = text;
    }
  } catch {
    detail = "";
  }
  const suffix = detail ? `: ${String(detail).slice(0, 500)}` : "";
  return new Error(`${label} failed: ${res.status} ${res.statusText ?? ""}`.trim() + suffix);
}

/** GET one raw job-state snapshot (the await-yield transport — keeps the
 *  poll-endpoint's `inputKind`/`hearing` which getRunStatus's normalized shape
 *  drops). Per-poll abort mirrors the existing per-fetch AbortSignal. */
async function pollJobOnce({ jobId, dashboardUrl, proxyToken, fetchImpl, timeoutMs }) {
  const url = `${resolveBase(dashboardUrl)}/api/run/jobs/${encodeURIComponent(jobId)}`;
  const res = await fetchImpl(url, {
    headers: authHeaders(proxyToken),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw await errorFromResponse(res, "get_run_status");
  return res.json();
}

/**
 * ADR 0029 await-yield: poll a minted job until it leaves `running`, then return
 * a normalized yield. Each poll fires `onProgress` (heartbeat for the turn-idle
 * watchdog) so a minutes-long await never looks idle. `sleepImpl`/`pollIntervalMs`
 * are injectable so tests resolve instantly.
 */
async function awaitJobYield({
  jobId,
  kind,
  project,
  ticket,
  dashboardUrl,
  proxyToken,
  fetchImpl,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
  onProgress = null,
  sleepImpl = realSleep
}) {
  // Tolerate a transient run of poll failures (a brief 404 while the job TTL/
  // eviction settles, a network blip, or the tight per-poll abort) so one hiccup
  // doesn't lose a minutes-long rendezvous. Give up only after a sustained outage.
  const MAX_CONSECUTIVE_POLL_MISSES = 15; // ~30s at the 2s cadence
  let json;
  let misses = 0;
  for (;;) {
    try {
      json = await pollJobOnce({ jobId, dashboardUrl, proxyToken, fetchImpl, timeoutMs: pollTimeoutMs });
      misses = 0;
    } catch (err) {
      misses += 1;
      if (misses >= MAX_CONSECUTIVE_POLL_MISSES) throw err;
      if (typeof onProgress === "function") {
        try { onProgress({ detail: `run ${jobId}: poll retry ${misses}` }); } catch { /* best-effort */ }
      }
      await sleepImpl(pollIntervalMs);
      continue;
    }
    const status = json?.status;
    if (typeof onProgress === "function") {
      try { onProgress({ detail: `run ${jobId}: ${status ?? "?"}` }); } catch { /* best-effort heartbeat */ }
    }
    if (status && status !== "running") break;
    await sleepImpl(pollIntervalMs);
  }
  const result = json?.result;
  return {
    kind,
    jobId,
    status: json?.status,
    ...(json?.inputKind !== undefined ? { inputKind: json.inputKind } : {}),
    ...(json?.hearing !== undefined ? { hearing: json.hearing } : {}),
    ...(json?.interaction !== undefined ? { interaction: json.interaction } : {}),
    ...(result?.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
    ...(result?.pendingTask !== undefined ? { pendingTask: result.pendingTask } : {}),
    ...(result !== undefined ? { result } : {}),
    project,
    ticket
  };
}

/**
 * Start a ticket's run loop as an async job, then AWAIT it as a sub-agent
 * (ADR 0029): poll the job until it pauses for input or finishes, and return the
 * normalized yield. A `conversational` pause carries the `hearing` text for the
 * AI to relay (then `reply_run`); a `structured` pause carries the `interaction`
 * for the user's widget (then `resume_run`).
 */
export async function startRun({
  project,
  ticket,
  autoApprove,
  runnerId,
  dashboardUrl = process.env.PROCWAY_DASHBOARD_URL,
  proxyToken = process.env.PROCWAY_PROXY_TOKEN,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
  onProgress = null,
  sleepImpl = realSleep
} = {}) {
  const proj = typeof project === "string" ? project.trim() : "";
  const tick = typeof ticket === "string" ? ticket.trim() : "";
  if (!proj) throw new Error("project is required");
  if (!tick) throw new Error("ticket is required");
  if (!proxyToken) throw new Error("PROCWAY_PROXY_TOKEN is not set");

  const url = `${resolveBase(dashboardUrl)}/api/run/jobs`;
  const body = { project: proj, ticket: tick };
  if (typeof autoApprove === "boolean") body.autoApprove = autoApprove;
  if (typeof runnerId === "string" && runnerId.trim()) body.runnerId = runnerId.trim();

  const res = await fetchImpl(url, {
    method: "POST",
    headers: authHeaders(proxyToken, { "content-type": "application/json" }),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw await errorFromResponse(res, "start_run");
  const json = await res.json();
  const jobId = json?.jobId;
  if (!jobId) {
    // No jobId to await (defensive) — return what the POST gave us.
    return { kind: "start_run", jobId, status: json?.status, project: proj, ticket: tick };
  }
  return awaitJobYield({
    jobId, kind: "start_run", project: proj, ticket: tick,
    dashboardUrl, proxyToken, fetchImpl, pollIntervalMs, pollTimeoutMs, onProgress, sleepImpl
  });
}

/** Poll one run-loop job's current state (status, terminal result, awaiting interaction). */
export async function getRunStatus({
  jobId,
  dashboardUrl = process.env.PROCWAY_DASHBOARD_URL,
  proxyToken = process.env.PROCWAY_PROXY_TOKEN,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS
} = {}) {
  const id = typeof jobId === "string" ? jobId.trim() : "";
  if (!id) throw new Error("jobId is required");
  if (!proxyToken) throw new Error("PROCWAY_PROXY_TOKEN is not set");

  const url = `${resolveBase(dashboardUrl)}/api/run/jobs/${encodeURIComponent(id)}`;
  const res = await fetchImpl(url, {
    headers: authHeaders(proxyToken),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw await errorFromResponse(res, "get_run_status");
  const json = await res.json();
  return {
    kind: "get_run_status",
    jobId: json?.jobId ?? id,
    status: json?.status,
    ...(json?.result !== undefined ? { result: json.result } : {}),
    ...(json?.interaction !== undefined ? { interaction: json.interaction } : {}),
    ...(json?.error !== undefined ? { error: json.error } : {})
  };
}

/**
 * Resume a paused run loop as a fresh async job and AWAIT it (ADR 0029). The
 * STRUCTURED-pause counterpart: after the user has answered a pending UIR via
 * the dashboard/Slack widget (the answer is already saved), this re-opens the
 * saved worker session and continues the loop — WITHOUT shelling out to the
 * procway CLI — then polls until the next pause/finish and returns the yield.
 */
export async function resumeRun({
  project,
  ticket,
  dashboardUrl = process.env.PROCWAY_DASHBOARD_URL,
  proxyToken = process.env.PROCWAY_PROXY_TOKEN,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
  onProgress = null,
  sleepImpl = realSleep
} = {}) {
  const proj = typeof project === "string" ? project.trim() : "";
  const tick = typeof ticket === "string" ? ticket.trim() : "";
  if (!proj) throw new Error("project is required");
  if (!tick) throw new Error("ticket is required");
  if (!proxyToken) throw new Error("PROCWAY_PROXY_TOKEN is not set");

  const url = `${resolveBase(dashboardUrl)}/api/run/jobs/resume`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: authHeaders(proxyToken, { "content-type": "application/json" }),
    body: JSON.stringify({ project: proj, ticket: tick }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw await errorFromResponse(res, "resume_run");
  const json = await res.json();
  const jobId = json?.jobId;
  if (!jobId) {
    return { kind: "resume_run", jobId, status: json?.status, project: proj, ticket: tick };
  }
  return awaitJobYield({
    jobId, kind: "resume_run", project: proj, ticket: tick,
    dashboardUrl, proxyToken, fetchImpl, pollIntervalMs, pollTimeoutMs, onProgress, sleepImpl
  });
}

/**
 * Reply to a CONVERSATIONAL (plain-text) hearing and AWAIT the resumed run
 * (ADR 0029 Phase 1). The conversational counterpart of resume_run: a plain-text
 * hearing has NO UIR widget / pending_interactions row, so instead of a saved
 * answer the AI passes the user's raw `answer` plus the paused worker `sessionId`
 * (from the start_run/reply_run yield). POSTs the conversational-resume endpoint,
 * which re-opens that worker session, injects the answer, continues the loop, and
 * the tool polls until the next pause/finish and returns the yield.
 */
export async function replyRun({
  project,
  ticket,
  sessionId,
  answer,
  dashboardUrl = process.env.PROCWAY_DASHBOARD_URL,
  proxyToken = process.env.PROCWAY_PROXY_TOKEN,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
  onProgress = null,
  sleepImpl = realSleep
} = {}) {
  const proj = typeof project === "string" ? project.trim() : "";
  const tick = typeof ticket === "string" ? ticket.trim() : "";
  const sess = typeof sessionId === "string" ? sessionId.trim() : "";
  const ans = typeof answer === "string" ? answer : "";
  if (!proj) throw new Error("project is required");
  if (!tick) throw new Error("ticket is required");
  if (!sess) throw new Error("sessionId is required");
  if (!ans.trim()) throw new Error("answer is required");
  if (!proxyToken) throw new Error("PROCWAY_PROXY_TOKEN is not set");

  const url = `${resolveBase(dashboardUrl)}/api/run/jobs/conversational-resume`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: authHeaders(proxyToken, { "content-type": "application/json" }),
    body: JSON.stringify({ project: proj, ticket: tick, sessionId: sess, answer: ans }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw await errorFromResponse(res, "reply_run");
  const json = await res.json();
  const jobId = json?.jobId;
  if (!jobId) {
    return { kind: "reply_run", jobId, status: json?.status, project: proj, ticket: tick };
  }
  return awaitJobYield({
    jobId, kind: "reply_run", project: proj, ticket: tick,
    dashboardUrl, proxyToken, fetchImpl, pollIntervalMs, pollTimeoutMs, onProgress, sleepImpl
  });
}
