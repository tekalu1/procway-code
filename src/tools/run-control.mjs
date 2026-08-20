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
 *  - attach_run    → POST   $PROCWAY_DASHBOARD_URL/api/run/jobs/<runId>/attach (declare), then await-yield
 *  - get_run_status→ GET    $PROCWAY_DASHBOARD_URL/api/run/jobs/<jobId>
 *  - resume_run    → POST   $PROCWAY_DASHBOARD_URL/api/run/jobs/resume
 *  - reply_run     → POST   $PROCWAY_DASHBOARD_URL/api/run/jobs/conversational-resume
 *
 * ADR 0029 await-yield: start_run / attach_run / resume_run / reply_run are NO LONGER
 * fire-and-forget. After minting the jobId they WAIT for the job to leave
 * `running` (the run pauses for input, or finishes), then RETURN a normalized
 * yield — the side-panel AI thus "awaits the run as a sub-agent" and receives
 * the hearing the loop paused on. ADR 0028 Phase 2's fire-and-forget lost the
 * plan-todo hearing (TK-8) because the AI ended its turn before the loop
 * paused; await-yield restores the rendezvous.
 *
 * ADR 0029 addendum A1 Phase 2 (issue #143) replaced the TRANSPORT of that
 * wait. It used to be a 2s `GET /api/run/jobs/:jobId` poll loop; now the host
 * PUSHES every settle of an accompanied run (the `wake` command), so the wait
 * is an in-process event wait on the session's wake supervisor
 * (`awaitSettle`) — injected as a function, because this module deliberately
 * knows nothing about sessions. One wait model, no polling.
 *
 * Two invariants survive the swap and must not be quietly dropped:
 *  - HEARTBEAT: `awaitSettle` calls back every ~20s and each callback fires
 *    `onProgress`, so the turn-idle watchdog (180s of event silence aborts the
 *    turn — conversation.mjs #startIdleWatchdog) stays fed through a
 *    minutes-long await. The poll used to supply this implicitly.
 *  - BUDGET: the scheduler grants these tools the long-running tool budget
 *    (turn-orchestrator toolCallBudgetMs); the wait's own deadline is set just
 *    BELOW it so the tool returns its own honest answer instead of being killed.
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

import { DEFAULT_LONG_RUNNING_SHELL_TIMEOUT_MS } from "../safety/command-classifier.mjs";

/** Header carrying the session-scoped token to the dashboard (02.auth.ts). */
const SESSION_TOKEN_HEADER = "x-procway-session";

/** Default timeout for one job API call (the POST, and the confirming read). */
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/**
 * How often the JOIN reports progress while it waits for the settle. Well under
 * the turn-idle watchdog's 180s default (conversation.mjs) — this is the only
 * thing keeping a long await from looking idle now that nothing polls.
 */
const DEFAULT_JOIN_HEARTBEAT_MS = 20_000;

/**
 * How far the JOIN's own deadline sits BELOW the scheduler's tool budget.
 *
 * turn-orchestrator's toolCallBudgetMs gives start_run / attach_run /
 * resume_run / reply_run `longRunningShellTimeoutMs + 30s`. The wait must end
 * FIRST, so the tool returns an honest "still running, you'll be woken when it
 * settles" instead of being SIGTERMed with no answer at all. The dispatcher
 * (tools/registry.mjs) recomputes this from the session's configured
 * longRunningShellTimeoutMs and passes it in; the constants below are the
 * default-settings case.
 */
const JOIN_BUDGET_MARGIN_MS = 60_000;

/** Default JOIN deadline: the long-running ceiling minus the budget margin. */
const DEFAULT_JOIN_TIMEOUT_MS = Math.max(
  60_000,
  DEFAULT_LONG_RUNNING_SHELL_TIMEOUT_MS - JOIN_BUDGET_MARGIN_MS
);

/**
 * The JOIN deadline for a session whose long-running ceiling is configured.
 * Exported so the dispatcher derives it from the SAME rule the scheduler budget
 * uses, instead of two constants drifting apart.
 *
 * @param {number | undefined} longRunningShellTimeoutMs
 * @returns {number}
 */
export function joinTimeoutMsFor(longRunningShellTimeoutMs) {
  const lr = Number.isFinite(longRunningShellTimeoutMs)
    ? Number(longRunningShellTimeoutMs)
    : DEFAULT_LONG_RUNNING_SHELL_TIMEOUT_MS;
  return Math.max(60_000, lr - JOIN_BUDGET_MARGIN_MS);
}

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
  let detail;
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

/**
 * The normalized yield every awaiting tool returns. UNCHANGED across the Phase 2
 * transport swap — in particular `project` / `ticket`, which are REQUIRED
 * arguments of `resume_run` / `reply_run` and which the model has no other way
 * to learn (attach_run's schema carries only `runId`). Dropping them would leave
 * a paused run unresumable.
 */
function buildYield({ kind, jobId, project, ticket, status, inputKind, hearing, interaction, sessionId, pendingTask, result, error, note }) {
  return {
    kind,
    jobId,
    status,
    ...(inputKind !== undefined ? { inputKind } : {}),
    ...(hearing !== undefined ? { hearing } : {}),
    ...(interaction !== undefined ? { interaction } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(pendingTask !== undefined ? { pendingTask } : {}),
    ...(result !== undefined ? { result } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(note !== undefined ? { note } : {}),
    // attach_run knows only the runId, so fall back to what the job itself
    // reports. The launching callers always pass both.
    project: project || undefined,
    ticket: ticket || undefined
  };
}

/** Wake item (wake-supervisor normalizeRunSettle) → the tool's yield. */
function yieldFromSettle({ kind, jobId, project, ticket, item }) {
  return buildYield({
    kind,
    jobId: item.jobId || jobId,
    project: project || item.project,
    ticket: ticket || item.ticket,
    status: item.status,
    inputKind: item.inputKind,
    hearing: item.hearing,
    interaction: item.interaction,
    // The wake item names the paused WORKER session `runSessionId`; the yield
    // has always called it `sessionId` (it is reply_run's argument).
    sessionId: item.runSessionId,
    pendingTask: item.pendingTask,
    result: item.result,
    error: item.error
  });
}

/** GET snapshot (get_run_status shape) → the tool's yield. */
function yieldFromSnapshot({ kind, jobId, project, ticket, snapshot, note }) {
  const result = snapshot?.result;
  return buildYield({
    kind,
    jobId: snapshot?.jobId || jobId,
    project: project || snapshot?.project,
    ticket: ticket || snapshot?.ticket,
    status: snapshot?.status,
    inputKind: snapshot?.inputKind,
    hearing: snapshot?.hearing,
    interaction: snapshot?.interaction,
    sessionId: result?.sessionId,
    pendingTask: result?.pendingTask,
    result,
    error: snapshot?.error,
    note
  });
}

/**
 * ADR 0029 await-yield, Phase 2 transport (issue #143): WAIT for the minted job
 * to settle, then return the normalized yield.
 *
 * The wait is an event wait, not a poll: `awaitSettle` is the session's wake
 * supervisor, which already receives every settle of an accompanied run from the
 * host's `wake` push. It resolves with the settle, or with `null` when the wait
 * ran out (deadline, abort, or the settle was already delivered as a wake).
 *
 * `null` is answered with exactly ONE confirming `get_run_status` read — never a
 * poll loop. That read is what makes a host that sets PROCWAY_DASHBOARD_URL but
 * never implements `wake` degrade to "slow but correct" instead of hanging: the
 * JOIN returns the run's real state, and if it is still running it says so and
 * points at the automatic wake.
 */
async function awaitJobYield({
  jobId,
  kind,
  project,
  ticket,
  dashboardUrl,
  proxyToken,
  fetchImpl,
  /** (jobId, { timeoutMs, signal, onHeartbeat, heartbeatMs }) => Promise<item|null> */
  awaitSettle = null,
  joinTimeoutMs = DEFAULT_JOIN_TIMEOUT_MS,
  heartbeatMs = DEFAULT_JOIN_HEARTBEAT_MS,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  onProgress = null,
  signal = null
}) {
  const tick = (detail) => {
    if (typeof onProgress !== "function") return;
    try { onProgress({ detail }); } catch { /* best-effort heartbeat */ }
  };

  let item = null;
  if (typeof awaitSettle === "function") {
    // One tick up front so the watchdog sees the JOIN start, then one per
    // heartbeat for as long as it blocks.
    tick(`run ${jobId}: running — waiting for it to settle`);
    item = await awaitSettle(jobId, {
      timeoutMs: joinTimeoutMs,
      heartbeatMs,
      signal,
      onHeartbeat: ({ waitedMs } = {}) => {
        const secs = Math.round((Number(waitedMs) || 0) / 1000);
        tick(`run ${jobId}: running — waiting for it to settle (${secs}s)`);
      }
    });
  }

  if (item) {
    tick(`run ${jobId}: ${item.status ?? "?"}`);
    return yieldFromSettle({ kind, jobId, project, ticket, item });
  }

  if (signal?.aborted) {
    return buildYield({
      kind,
      jobId,
      project,
      ticket,
      status: "running",
      note: `Interrupted while waiting for run ${jobId}. The run itself was NOT stopped.`
    });
  }

  // ONE confirming read. Not a loop — if this says the run is still going, the
  // honest answer is "still running", and the settle will arrive as a wake.
  let snapshot;
  try {
    snapshot = await getRunStatus({ jobId, dashboardUrl, proxyToken, fetchImpl, timeoutMs });
  } catch (err) {
    return buildYield({
      kind,
      jobId,
      project,
      ticket,
      status: "unknown",
      note: `Could not read run ${jobId} after waiting for it (${err?.message ?? err}). Do not restart it — check \`get_run_status\` (jobId="${jobId}") before doing anything else.`
    });
  }

  const settled = snapshot?.status && snapshot.status !== "running";
  return yieldFromSnapshot({
    kind,
    jobId,
    project,
    ticket,
    snapshot,
    note: settled
      ? undefined
      : `Run ${jobId} is STILL RUNNING — waiting for it here timed out. It was NOT stopped and must NOT be restarted: when it settles you are woken automatically in a new turn with its outcome.`
  });
}

/**
 * Start a ticket's run loop as an async job, then AWAIT it as a sub-agent
 * (ADR 0029): wait for the job to pause for input or finish, and return the
 * normalized yield. A `conversational` pause carries the `hearing` text for the
 * AI to relay (then `reply_run`); a `structured` pause carries the `interaction`
 * for the user's widget (then `resume_run`).
 *
 * `runInBackground:true` (issue #141) stops after the POST and returns the
 * minted jobId instead of awaiting the yield, so an orchestrator can drive
 * several runs at once. The JOIN half already exists and is unchanged:
 * `attach_run` is exactly this function MINUS the POST. The default is
 * deliberately untouched — accompanying a run turn-by-turn is the product's
 * core behaviour (ADR 0028 / ADR 0038 D6), background is the opt-in.
 */
export async function startRun({
  project,
  ticket,
  autoApprove,
  runnerId,
  /** Issue #141: POST only, return the jobId, do NOT await the first yield. */
  runInBackground = false,
  // ADR 0038 D1 (attach): the id of the conversation this call is being made
  // from. Supplied by the HOST (the tool dispatcher passes the owning
  // AgentSession id) — NOT by the model, and deliberately absent from the
  // start_run tool schema, so it cannot be forged in tool arguments. The
  // dashboard records it on the run and verifies the claim against the calling
  // session's principal. Omitted → the run starts unattached (the pre-0038
  // behaviour, which an older dashboard also falls back to).
  conversationId,
  dashboardUrl = process.env.PROCWAY_DASHBOARD_URL,
  proxyToken = process.env.PROCWAY_PROXY_TOKEN,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  awaitSettle = null,
  joinTimeoutMs = DEFAULT_JOIN_TIMEOUT_MS,
  heartbeatMs = DEFAULT_JOIN_HEARTBEAT_MS,
  onProgress = null,
  signal = null
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
  // Only sent when known — an empty attach is the same as no attach, and older
  // dashboards simply ignore the extra field.
  if (typeof conversationId === "string" && conversationId.trim()) body.conversationId = conversationId.trim();

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
  if (runInBackground === true) {
    // Issue #141: hand the jobId back immediately — nothing is awaited, so N
    // background starts cost N POSTs and the turn is free to do other work.
    // `onProgress` is deliberately unused: there is nothing to heartbeat for.
    // The run is still attached to `conversationId` (ADR 0038 D1) above, so its
    // settle still reaches this conversation — as a wake.
    return { kind: "start_run", jobId, status: "running", background: true, project: proj, ticket: tick };
  }
  return awaitJobYield({
    jobId, kind: "start_run", project: proj, ticket: tick,
    dashboardUrl, proxyToken, fetchImpl, timeoutMs, awaitSettle, joinTimeoutMs, heartbeatMs, onProgress, signal
  });
}

/**
 * ADR 0038 D2 — ACCOMPANY a run that somebody else already started (the ticket
 * detail's「実行」button now POSTs /api/run/jobs itself and hands the AI the
 * jobId). This is `startRun` MINUS the POST: no side effect, just the same
 * await-yield rendezvous, so the AI relays hearings and drives the resume exactly
 * as it does for a run it started itself.
 *
 * Issue #141 gave this a second job: it is also the JOIN for a run this session
 * started itself with `startRun({ runInBackground: true })`. Same call, same
 * rendezvous — "started by the button" and "started in the background by me"
 * differ only in who did the POST.
 *
 * `project` / `ticket` are deliberately NOT parameters: the model is given only
 * the runId, and the job itself reports which ticket it belongs to (the settle
 * — and the confirming read — carry both, and awaitJobYield lifts them into the
 * yield, because resume_run / reply_run cannot be called without them).
 *
 * A job that has not settled yet is simply waited on; one that settled BEFORE
 * this call (the dashboard minted it and the run finished in a second) is
 * resolved from the settle the supervisor is already holding, or failing that
 * by the single confirming read.
 *
 * Issue #143 follow-up — it now DECLARES the attach before waiting. The host
 * pushes a run's settle only to the conversation recorded ON the run, and the
 * ticket header's 「実行」button deliberately starts its run with NO conversation
 * (ADR 0038 D2: at button-press time none is accompanying it). Waiting without
 * declaring therefore blocked to the full JOIN deadline for exactly the flow
 * this tool exists for. `attach_run` IS the declaration — so it posts it, and
 * from then on the settle has somewhere to go. Same shape as ADR 0038 D1's
 * re-declaration on `resume_run` / `reply_run`, which mint new jobIds.
 *
 * The declaration is BEST-EFFORT. procway-code ships standalone on npm and a
 * host may not implement the endpoint at all; a 404 (or any other failure) is
 * reported in the yield's `note` and the call falls back to exactly the
 * previous behaviour — wait, then one confirming read.
 */
export async function attachRun({
  runId,
  // ADR 0038 D1 attach — host-supplied (the dispatcher passes the owning
  // AgentSession id), deliberately absent from the attach_run tool schema so
  // the model cannot point it at somebody else's conversation. Omitted → no
  // declaration is sent and the call behaves exactly as it did before.
  conversationId,
  dashboardUrl = process.env.PROCWAY_DASHBOARD_URL,
  proxyToken = process.env.PROCWAY_PROXY_TOKEN,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  awaitSettle = null,
  joinTimeoutMs = DEFAULT_JOIN_TIMEOUT_MS,
  heartbeatMs = DEFAULT_JOIN_HEARTBEAT_MS,
  onProgress = null,
  signal = null
} = {}) {
  const jobId = typeof runId === "string" ? runId.trim() : "";
  if (!jobId) throw new Error("runId is required");
  if (!proxyToken) throw new Error("PROCWAY_PROXY_TOKEN is not set");

  const { snapshot, note } = await declareAttach({
    jobId, conversationId, dashboardUrl, proxyToken, fetchImpl, timeoutMs, signal
  });

  // The declaration answers with the job's state right now. If the run is
  // ALREADY settled there is no settle left to be pushed — waiting for one
  // would burn the whole JOIN deadline — so return its yield straight away.
  // This also closes the "it finished between the button press and this call"
  // race that the confirming read used to absorb minutes later.
  if (snapshot?.status && snapshot.status !== "running") {
    return yieldFromSnapshot({ kind: "attach_run", jobId, snapshot, note });
  }

  const result = await awaitJobYield({
    jobId, kind: "attach_run", project: snapshot?.project, ticket: snapshot?.ticket,
    dashboardUrl, proxyToken, fetchImpl, timeoutMs, awaitSettle, joinTimeoutMs, heartbeatMs, onProgress, signal
  });
  if (note) result.note = result.note ? `${note} ${result.note}` : note;
  return result;
}

/**
 * POST the ADR 0038 D1 attach declaration and return the job state it answers
 * with. NEVER throws: an older/foreign host has no such endpoint, and the JOIN
 * must degrade to its pre-#143 behaviour rather than fail the tool call. The
 * returned `note` is what tells the model (and the logs) that the declaration
 * did not land, so a subsequent full-deadline wait is explicable instead of
 * mysterious.
 *
 * Sends nothing at all when there is no conversation to declare, no host URL to
 * declare it to, or an already-interrupted turn — there is no such thing as an
 * empty attach, and an interrupted JOIN issues no requests (the pre-existing
 * contract).
 */
async function declareAttach({ jobId, conversationId, dashboardUrl, proxyToken, fetchImpl, timeoutMs, signal = null }) {
  const conv = typeof conversationId === "string" ? conversationId.trim() : "";
  if (!conv || !dashboardUrl || signal?.aborted) return { snapshot: null, note: undefined };
  const url = `${resolveBase(dashboardUrl)}/api/run/jobs/${encodeURIComponent(jobId)}/attach`;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: authHeaders(proxyToken, { "content-type": "application/json" }),
      body: JSON.stringify({ conversationId: conv }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) {
      const err = await errorFromResponse(res, "attach_run declare");
      return { snapshot: null, note: attachDeclineNote(jobId, err.message) };
    }
    return { snapshot: await res.json(), note: undefined };
  } catch (err) {
    return { snapshot: null, note: attachDeclineNote(jobId, err?.message ?? String(err)) };
  }
}

/** The note attached to a yield when the attach declaration did not land. */
function attachDeclineNote(jobId, detail) {
  const note = `Could not declare this conversation as accompanying run ${jobId} (${detail}).`
    + " The run itself is unaffected, but this host may not push its settle here —"
    + " if the wait below times out, re-check with `get_run_status`.";
  console.warn(`[run-control] ${note}`);
  return note;
}

/** Read one run-loop job's current state (status, terminal result, awaiting interaction). */
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
    // inputKind / hearing / project / ticket are what the endpoint derives for a
    // PAUSED run. They used to be read only by the poll loop; the JOIN's single
    // confirming read now goes through here, and without them a run that paused
    // on a conversational hearing while nothing was listening would come back
    // unanswerable (no hearing text, and no project/ticket for reply_run).
    ...(json?.inputKind !== undefined ? { inputKind: json.inputKind } : {}),
    ...(json?.hearing !== undefined ? { hearing: json.hearing } : {}),
    ...(json?.project !== undefined ? { project: json.project } : {}),
    ...(json?.ticket !== undefined ? { ticket: json.ticket } : {}),
    ...(json?.error !== undefined ? { error: json.error } : {})
  };
}

/**
 * Resume a paused run loop as a fresh async job and AWAIT it (ADR 0029). The
 * STRUCTURED-pause counterpart: after the user has answered a pending UIR via
 * the dashboard/Slack widget (the answer is already saved), this re-opens the
 * saved worker session and continues the loop — WITHOUT shelling out to the
 * procway CLI — then waits for the next pause/finish and returns the yield.
 */
export async function resumeRun({
  project,
  ticket,
  /** ADR 0038 D1 attach — host-supplied, see startRun. A resume mints a NEW
   *  jobId, so the attach must be re-declared or the conversation would keep
   *  pointing at the settled job it started. */
  conversationId,
  dashboardUrl = process.env.PROCWAY_DASHBOARD_URL,
  proxyToken = process.env.PROCWAY_PROXY_TOKEN,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  awaitSettle = null,
  joinTimeoutMs = DEFAULT_JOIN_TIMEOUT_MS,
  heartbeatMs = DEFAULT_JOIN_HEARTBEAT_MS,
  onProgress = null,
  signal = null
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
    body: JSON.stringify({
      project: proj,
      ticket: tick,
      ...(typeof conversationId === "string" && conversationId.trim() ? { conversationId: conversationId.trim() } : {})
    }),
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
    dashboardUrl, proxyToken, fetchImpl, timeoutMs, awaitSettle, joinTimeoutMs, heartbeatMs, onProgress, signal
  });
}

/**
 * Reply to a CONVERSATIONAL (plain-text) hearing and AWAIT the resumed run
 * (ADR 0029 Phase 1). The conversational counterpart of resume_run: a plain-text
 * hearing has NO UIR widget / pending_interactions row, so instead of a saved
 * answer the AI passes the user's raw `answer` plus the paused worker `sessionId`
 * (from the start_run/reply_run yield). POSTs the conversational-resume endpoint,
 * which re-opens that worker session, injects the answer, continues the loop, and
 * the tool waits for the next pause/finish and returns the yield.
 */
export async function replyRun({
  project,
  ticket,
  sessionId,
  answer,
  /** ADR 0038 D1 attach — host-supplied, see startRun/resumeRun. NOTE: this is
   *  the CONVERSATION id, not the paused worker `sessionId` above. */
  conversationId,
  dashboardUrl = process.env.PROCWAY_DASHBOARD_URL,
  proxyToken = process.env.PROCWAY_PROXY_TOKEN,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  awaitSettle = null,
  joinTimeoutMs = DEFAULT_JOIN_TIMEOUT_MS,
  heartbeatMs = DEFAULT_JOIN_HEARTBEAT_MS,
  onProgress = null,
  signal = null
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
    body: JSON.stringify({
      project: proj,
      ticket: tick,
      sessionId: sess,
      answer: ans,
      ...(typeof conversationId === "string" && conversationId.trim() ? { conversationId: conversationId.trim() } : {})
    }),
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
    dashboardUrl, proxyToken, fetchImpl, timeoutMs, awaitSettle, joinTimeoutMs, heartbeatMs, onProgress, signal
  });
}
