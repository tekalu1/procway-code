import { getSharedJobRegistry } from "../jobs/delegated-jobs.mjs";

/**
 * event-wake (issue #143) — the supervisor that RE-STARTS a conversation when
 * background work settles after its turn already ended.
 *
 * The problem it solves: `spawn_agent(runInBackground:true)` (#142) and
 * `start_run(runInBackground:true)` (#141) both hand the model an id and let
 * the turn end. If the child/run settles a minute later, nothing was listening
 * — the conversation is idle, the result sits in the registry (or on the
 * dashboard), and the work is delivered only if the NEXT user message happens
 * to remind the model to collect it. The turn-end nudge this replaced (#141 /
 * #142) only ever covered the case where the model tried to answer while the
 * work was still in flight; it could not cover "the turn is over and the answer
 * arrived afterwards", which is the case that actually loses work.
 *
 * The supervisor closes that gap with one rule: a settle that nobody collected
 * WAKES the session — it injects a synthetic turn describing what finished, so
 * the model continues on its own. Waking is deliberately conservative:
 *
 *   - only jobs of THIS session (`meta.sessionId`) that were started in the
 *     background (`meta.wake === true`) are eligible. Foreground `spawn_agent`
 *     awaits its own yield inside the turn, so it must never wake anything.
 *   - a wake NEVER interleaves with a live turn. While `isTurnRunning()` is
 *     true the settles are held; `notifyTurnSettled()` re-evaluates.
 *   - settles are COALESCED over a debounce window, so three children finishing
 *     within a second produce ONE wake turn, not three.
 *   - anything the turn already collected (`agent_job` wait/status, `attach_run`,
 *     `resume_run`, `reply_run`) is dropped via `collect()` — the model has seen
 *     it, waking about it again would be noise.
 *
 * Runs are tracked separately from children on purpose: a run-loop job does not
 * live in this process (the dashboard owns that registry),
 * so the host pushes its settles in with `pushExternal()` and the supervisor
 * only remembers, via `trackRun()`, that one is outstanding.
 *
 * Phase 2 (issue #143) gave the same settle stream a SECOND consumer:
 * `awaitSettle(jobId)`. An explicit JOIN (`attach_run`, and the foreground
 * `start_run` / `resume_run` / `reply_run` await-yield) used to hold its turn
 * open by polling the dashboard every 2s; now it simply WAITS on the settle the
 * host already pushes. A settle claimed by such a waiter is delivered to it and
 * NOT queued as a wake — the JOIN already put it in front of the model, so a
 * wake about it would be the same result twice.
 */

/** Default coalescing window for settles that arrive back to back. */
const DEFAULT_DEBOUNCE_MS = 1000;
/** Default budget for the whole wake prompt body (result text is clipped). */
const DEFAULT_MAX_WAKE_TEXT_CHARS = 8000;
/** How many times one item may fail to inject before it is dropped. */
const DEFAULT_MAX_INJECT_ATTEMPTS = 3;
/** How long a collected jobId keeps suppressing late settles (tombstone). */
const DEFAULT_COLLECTED_TTL_MS = 10 * 60_000;
/** Bound on the "already collected" memo (late settles for collected jobs). */
const COLLECTED_MEMO_CAP = 500;
/**
 * Default ceiling for one `awaitSettle`. Callers that block a TURN on it pass
 * their own, derived from the scheduler's tool budget (see run-control's
 * DEFAULT_JOIN_TIMEOUT_MS); this default only guards a caller that forgot to.
 */
const DEFAULT_AWAIT_TIMEOUT_MS = 10 * 60_000;
/**
 * Default `onHeartbeat` cadence while `awaitSettle` blocks. Must stay well
 * under the turn-idle watchdog's 180s (conversation.mjs #startIdleWatchdog):
 * the heartbeat is the ONLY thing keeping a minutes-long JOIN from looking idle
 * now that the 2s poll no longer exists.
 */
const DEFAULT_AWAIT_HEARTBEAT_MS = 20_000;

function str(value) {
  return typeof value === "string" ? value.trim() : "";
}

function clip(text, max) {
  const s = typeof text === "string" ? text : text == null ? "" : String(text);
  if (s.length <= max) return { text: s, clipped: false };
  return { text: `${s.slice(0, max)}…`, clipped: true };
}

/**
 * Normalize a registry settle payload (see `subscribeSettled`) into a wake item.
 * The payload is a SNAPSHOT — the job may already be evicted by the time the
 * wake is built — so everything the prompt needs is copied out here.
 */
function normalizeAgentSettle(payload) {
  const result = payload?.result ?? {};
  return {
    jobId: str(payload?.jobId),
    kind: "agent",
    status: str(payload?.status) || "completed",
    task: str(payload?.meta?.task),
    text: typeof result?.text === "string" ? result.text : "",
    exitCode: Number.isFinite(result?.exitCode) ? result.exitCode : undefined,
    error: str(payload?.error) || undefined
  };
}

/**
 * Normalize a run settle pushed in by the host. The field set mirrors
 * `attach_run`'s normalized yield (tools/run-control.mjs) — in particular
 * `project` / `ticket`, which are REQUIRED arguments of `resume_run` /
 * `reply_run`. Dropping them from a wake would leave the model unable to
 * continue the very run it was woken for.
 */
function normalizeRunSettle(item) {
  const runSessionId = str(item?.runSessionId) || str(item?.sessionId);
  return {
    jobId: str(item?.jobId),
    kind: "run",
    status: str(item?.status) || "completed",
    project: str(item?.project),
    ticket: str(item?.ticket),
    inputKind: str(item?.inputKind) || undefined,
    hearing: typeof item?.hearing === "string" ? item.hearing : undefined,
    interaction: item?.interaction ?? undefined,
    runSessionId: runSessionId || undefined,
    pendingTask: item?.pendingTask ?? undefined,
    // Carried through for `awaitSettle`'s consumers only: an explicit JOIN
    // returns this item AS the tool's yield, and the pre-event-wake yield
    // carried the job's `result` payload. The wake PROMPT never renders it
    // (describeRunItem ignores it), so this changes no wake text.
    result: item?.result ?? undefined,
    error: str(item?.error) || undefined
  };
}

function describeAgentItem(item, budget) {
  const lines = [`- child agent ${item.jobId} — ${item.status}`];
  if (item.task) lines.push(`  task: ${clip(item.task, 200).text}`);
  if (item.error) lines.push(`  error: ${clip(item.error, Math.min(budget, 500)).text}`);
  if (item.text) {
    const { text, clipped } = clip(item.text, budget);
    lines.push(`  result: ${text}`);
    if (clipped) lines.push(`  (result clipped — call \`agent_job\` action:"status" jobId:"${item.jobId}" for the full text)`);
  } else if (!item.error) {
    lines.push(`  result: (no text; exit code ${item.exitCode ?? 0})`);
  }
  return lines.join("\n");
}

function describeRunItem(item, budget) {
  const ticket = [item.project, item.ticket].filter(Boolean).join("#");
  const lines = [`- run ${item.jobId} — ${item.status}${ticket ? ` (${ticket})` : ""}`];
  if (item.project || item.ticket) {
    lines.push(`  project: ${item.project || "?"}  ticket: ${item.ticket || "?"}`);
  }
  if (item.inputKind) lines.push(`  inputKind: ${item.inputKind}`);
  if (item.hearing) {
    const { text, clipped } = clip(item.hearing, budget);
    lines.push(`  hearing: ${text}`);
    if (clipped) lines.push(`  (hearing clipped — \`attach_run\` runId:"${item.jobId}" for the full text)`);
  }
  if (item.interaction) {
    const { text, clipped } = clip(JSON.stringify(item.interaction), Math.min(budget, 800));
    lines.push(`  interaction: ${text}`);
    if (clipped) lines.push("  (interaction clipped)");
  }
  if (item.runSessionId) lines.push(`  run sessionId: ${item.runSessionId}`);
  if (item.error) lines.push(`  error: ${clip(item.error, Math.min(budget, 500)).text}`);
  return lines.join("\n");
}

/**
 * The synthetic prompt injected when background work settles with the
 * conversation idle. Pure function so the wording is testable on its own.
 *
 * Tone is English, terse and imperative, matching the other texts this model
 * reads in the same conversation. What this one must say above all: **this is
 * not the user talking**. A wake turn that reads like a user message makes the
 * model answer the "user" instead of finishing the work.
 *
 * @param {Array<object>} items  normalized wake items (agent / run kinds)
 * @param {{ maxChars?: number }} [opts]
 * @returns {string} "" when there is nothing to say
 */
export function buildWakePrompt(items, { maxChars = DEFAULT_MAX_WAKE_TEXT_CHARS } = {}) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (list.length === 0) return "";
  // Per-item body budget: the blocks share the text allowance so one enormous
  // child result cannot crowd the others out of the prompt.
  const budget = Math.max(200, Math.floor(maxChars / list.length));
  const blocks = list.map((item) => (item.kind === "run" ? describeRunItem(item, budget) : describeAgentItem(item, budget)));

  const awaiting = list.filter((item) => item.kind === "run" && String(item.status).startsWith("awaiting"));
  const finished = list.filter((item) => !(item.kind === "run" && String(item.status).startsWith("awaiting")));

  const next = [];
  if (awaiting.length > 0) {
    next.push(
      "- A run is PAUSED waiting for an answer. Relay its hearing to the user and get one: " +
      "reply with `reply_run` (project, ticket, sessionId, answer) for a conversational hearing, " +
      "or `resume_run` (project, ticket) once a structured interaction is answered."
    );
  }
  if (finished.length > 0) {
    next.push("- For the finished work above: use the result and CONTINUE the task it belongs to. Do not restart it.");
  }
  next.push(
    "- Need the full output? `agent_job` action:\"status\" (jobId) for a child, `attach_run` (runId) for a run."
  );
  next.push(
    "- If nothing is left to do, say what finished and stop. Do not ask the user to repeat their request."
  );

  return [
    "<system-reminder>",
    "AUTOMATIC RESUME — this is NOT a message from the user. Background work you " +
    `started has settled while no turn was running, so ${list.length === 1 ? "its result was" : "these results were"} never collected.`,
    "",
    `Settled (${list.length}):`,
    blocks.join("\n"),
    "",
    "What to do now:",
    next.join("\n"),
    "</system-reminder>"
  ].join("\n");
}

/**
 * Create the per-session wake supervisor.
 *
 * @param {object} opts
 * @param {string} opts.sessionId              the conversation this supervises
 * @param {object} [opts.registry]             delegated-job registry (default: shared singleton)
 * @param {(text: string) => Promise<unknown>} [opts.injectTurn]  how a wake turn is delivered
 * @param {() => boolean} [opts.isTurnRunning] true while a turn is in flight
 * @param {number} [opts.debounceMs]           coalescing window (default 1000)
 * @param {number} [opts.maxWakeTextChars]     wake body budget (default 8000)
 * @param {typeof setTimeout} [opts.setTimeoutImpl]
 * @param {typeof clearTimeout} [opts.clearTimeoutImpl]
 * @param {() => number} [opts.now]
 * @param {(err: unknown, context: object) => void} [opts.onError]  injection failures
 * @param {number} [opts.maxInjectAttempts]    give-up threshold per item (default 3)
 * @param {number} [opts.collectedTtlMs]       how long a collected jobId is tombstoned (default 10min)
 * @param {object} [opts.metrics]              ADR 0029 E7 Phase 3 delegation metrics
 *        collector (telemetry/delegation-metrics.mjs). Off by default — a plain
 *        no-op unless PROCWAY_TELEMETRY is on — and every call is
 *        optional-chained, so nothing here changes when it is absent.
 */
export function createWakeSupervisor({
  sessionId,
  registry = null,
  injectTurn = null,
  isTurnRunning = () => false,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  maxWakeTextChars = DEFAULT_MAX_WAKE_TEXT_CHARS,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  now = () => Date.now(),
  onError = null,
  maxInjectAttempts = DEFAULT_MAX_INJECT_ATTEMPTS,
  collectedTtlMs = DEFAULT_COLLECTED_TTL_MS,
  metrics = null
} = {}) {
  const ownerId = str(sessionId);
  const jobRegistry = registry ?? getSharedJobRegistry();
  /** @type {Map<string, object>} settled-but-not-yet-injected work */
  const pending = new Map();
  /** @type {Map<string, {project: string, ticket: string, startedAt: number}>} background runs we are still waiting on */
  const trackedRuns = new Map();
  /** @type {Map<string, number>} failed injection attempts per jobId */
  const attempts = new Map();
  /**
   * Tombstones for work that has already been delivered: jobId → { status,
   * expiresAt }.
   *
   * This exists because the HOST cannot tell a background run from a foreground
   * one. Its rule is simply "a run with a conversationId settled → push it in",
   * so a run the turn already JOINED with `attach_run` is pushed anyway, AFTER
   * the tool call returned. Without a tombstone that late push would become a
   * fresh wake and the model would be handed the same yield twice.
   *
   * Bounded two ways so it can never grow into a leak: a TTL (checked lazily on
   * read — a dedicated sweep timer would be one more thing pinning the event
   * loop) and a hard cap. A status change re-opens the gate: the tombstone is
   * about "this exact outcome was delivered", not about muting the id forever.
   * (In practice a continued run gets a FRESH jobId — ADR 0038 D1 — so this is
   * belt and braces.)
   *
   * @type {Map<string, { status: string, expiresAt: number }>}
   */
  const collected = new Map();
  /**
   * Turns BLOCKED on one specific job (`awaitSettle`) — jobId → the waiters
   * registered for it. A Set because two `attach_run` calls on the same runId
   * can legitimately run in parallel (attach_run is read-only, so the scheduler
   * does not serialize it) and both must be answered.
   *
   * @type {Map<string, Set<{ settle: (item: object | null) => void }>>}
   */
  const waiters = new Map();

  let inject = typeof injectTurn === "function" ? injectTurn : null;
  let unsubscribe = null;
  let timer = null;
  let injecting = false;
  let started = false;

  function report(err, context) {
    if (typeof onError !== "function") return;
    try { onError(err, context); } catch { /* an error reporter must never throw */ }
  }

  function memoCollected(jobId, status = "") {
    // Every path that delivers background work to the model funnels through
    // here (claim + collect), which makes it the one honest place to close a
    // job's "uncollected" window for the concurrency measurement.
    metrics?.collected?.(jobId);
    collected.set(jobId, { status: str(status), expiresAt: now() + collectedTtlMs });
    if (collected.size > COLLECTED_MEMO_CAP) {
      // Oldest-first eviction (insertion-ordered Map); the memo only guards a
      // late duplicate, so a bounded window is enough.
      const oldest = collected.keys().next().value;
      collected.delete(oldest);
    }
  }

  /**
   * Is this settle a duplicate of something already delivered? Expired
   * tombstones are dropped here (lazy sweep), and a settle whose status differs
   * from the collected one is let through — it is new information.
   */
  function isTombstoned(jobId, status = "") {
    const memo = collected.get(jobId);
    if (!memo) return false;
    if (memo.expiresAt <= now()) {
      collected.delete(jobId);
      return false;
    }
    const incoming = str(status);
    if (memo.status && incoming && memo.status !== incoming) return false;
    return true;
  }

  /** `isTurnRunning` is host-supplied; a throw from it must not stall wakes. */
  function turnIsRunning() {
    try { return isTurnRunning() === true; } catch { return false; }
  }

  function clearTimer() {
    if (timer == null) return;
    try { clearTimeoutImpl(timer); } catch { /* best-effort */ }
    timer = null;
  }

  function schedule() {
    if (pending.size === 0 || injecting) return;
    if (turnIsRunning()) return;
    clearTimer();
    timer = setTimeoutImpl(() => {
      timer = null;
      void fire();
    }, debounceMs);
    // A pending wake must never be the reason `procway-code -p` or a child
    // process stays alive (same discipline as the registry's evict timer).
    timer?.unref?.();
  }

  async function fire() {
    if (injecting || pending.size === 0) return;
    if (turnIsRunning()) return;
    if (typeof inject !== "function") {
      // No surface wired yet (the injector is set by the host). Hold the work —
      // `setInjector` re-schedules once a surface appears.
      return;
    }
    const batch = [...pending.values()];
    pending.clear();
    clearTimer();
    injecting = true;
    const text = buildWakePrompt(batch, { maxChars: maxWakeTextChars });
    try {
      await inject(text);
      // kind/status ride along so the paused-run wake latency can be split out
      // (ADR 0029 E7-P3): a run waiting for an answer is a user-visible delay.
      metrics?.wakeInjected?.(batch.map((item) => ({ jobId: item.jobId, kind: item.kind, status: item.status })));
      for (const item of batch) {
        attempts.delete(item.jobId);
        trackedRuns.delete(item.jobId);
        // Delivered — same tombstone as an explicit collect(), so a host push
        // that races the wake cannot report it a second time.
        memoCollected(item.jobId, item.status);
      }
    } catch (err) {
      metrics?.wakeInjectFailed?.();
      // Never lose the work: put the batch back so the next opportunity (a turn
      // ending, another settle) retries it — bounded, so a permanently broken
      // injector cannot spin forever.
      for (const item of batch) {
        if (isTombstoned(item.jobId, item.status)) continue;
        const tries = (attempts.get(item.jobId) ?? 0) + 1;
        if (tries >= maxInjectAttempts) {
          attempts.delete(item.jobId);
          trackedRuns.delete(item.jobId);
          report(err, { phase: "inject", jobId: item.jobId, attempts: tries, gaveUp: true });
          continue;
        }
        attempts.set(item.jobId, tries);
        if (!pending.has(item.jobId)) pending.set(item.jobId, item);
      }
      report(err, { phase: "inject", jobIds: batch.map((i) => i.jobId), gaveUp: false });
    } finally {
      injecting = false;
    }
    if (pending.size > 0) schedule();
  }

  /**
   * Book-keeping shared by "a waiter took this settle" and "a wake delivered
   * it": either way the model has seen it, so it stops being outstanding and is
   * tombstoned against the host's unconditional re-push.
   */
  function claim(item) {
    pending.delete(item.jobId);
    trackedRuns.delete(item.jobId);
    attempts.delete(item.jobId);
    memoCollected(item.jobId, item.status);
    if (pending.size === 0) clearTimer();
  }

  /**
   * Hand a settle to the turn that is BLOCKED on it, if any. Returns false when
   * nobody is waiting, so `enqueue` falls back to queueing a wake.
   */
  function deliverToWaiters(item) {
    const set = waiters.get(item.jobId);
    if (!set || set.size === 0) return false;
    const targets = [...set];
    waiters.delete(item.jobId);
    claim(item);
    for (const waiter of targets) waiter.settle(item);
    return true;
  }

  /** @returns {boolean} whether the item was queued (false = dropped duplicate) */
  function enqueue(item) {
    if (!item?.jobId) return false;
    if (isTombstoned(item.jobId, item.status)) return false;
    // A JOIN is blocking on this exact job: give it the settle instead of
    // waking the session about it later (that would deliver it twice).
    if (deliverToWaiters(item)) return true;
    metrics?.wakeQueued?.(item.jobId);
    pending.set(item.jobId, item);
    trackedRuns.delete(item.jobId);
    schedule();
    return true;
  }

  function onSettled(payload) {
    const meta = payload?.meta;
    if (!ownerId || meta?.sessionId !== ownerId) return;
    // Recorded BEFORE the wake filter: the same-cwd hazard is about a child
    // that is still WRITING, which foreground and background children both are.
    // (A foreground child's own settle is also reported by the tool, but this
    // is idempotent — the second release finds nothing live.)
    if (payload?.kind === "agent") metrics?.childSettled?.(payload.jobId);
    // Only work that was explicitly detached is wakeable. A foreground
    // spawn_agent awaits its own yield inside the turn — waking for it would
    // deliver the same result twice.
    if (meta?.wake !== true) return;
    enqueue(normalizeAgentSettle(payload));
  }

  function runningWakeJobs() {
    if (typeof jobRegistry?.listJobs !== "function") return 0;
    let count = 0;
    for (const job of jobRegistry.listJobs()) {
      if (job?.status !== "running") continue;
      if (job?.meta?.sessionId !== ownerId || job?.meta?.wake !== true) continue;
      count += 1;
    }
    return count;
  }

  const supervisor = {
    /** Subscribe to the registry's settles. Idempotent. */
    start() {
      if (started) return supervisor;
      started = true;
      if (typeof jobRegistry?.subscribeSettled === "function") {
        unsubscribe = jobRegistry.subscribeSettled(onSettled);
      }
      return supervisor;
    },

    /** Unsubscribe and cancel any pending wake. Idempotent. */
    stop() {
      started = false;
      clearTimer();
      if (typeof unsubscribe === "function") {
        try { unsubscribe(); } catch { /* best-effort */ }
      }
      unsubscribe = null;
      // Nothing will ever be delivered again, so release every blocked JOIN
      // with `null` rather than leaving it hanging until its own timeout.
      const blocked = [...waiters.values()];
      waiters.clear();
      for (const set of blocked) {
        for (const waiter of set) waiter.settle(null);
      }
      return supervisor;
    },

    /**
     * Phase 2 (issue #143) — BLOCK until this job settles. The replacement for
     * run-control's 2s poll loop: the host already pushes every settle of an
     * accompanied run (`pushExternal`), and in-process jobs settle through the
     * registry, so a JOIN just waits on that one stream.
     *
     * Resolves with the normalized wake item, or `null` when the wait ended
     * without one (timeout, `signal` abort, `stop()`, or the settle was already
     * DELIVERED — a wake beat this call to it). `null` never means "still
     * running": the caller decides what to do, and run-control answers it with
     * a single confirming `get_run_status` read (NOT a new poll loop).
     *
     * A settle that is already queued when this is called resolves it
     * immediately — the POST → await gap is a real race (a run can reach a
     * terminal status within a second of being started).
     *
     * `onHeartbeat` is called every `heartbeatMs` while blocked. This is not a
     * nicety: the caller's turn-idle watchdog aborts a turn after 180s of event
     * silence, and this heartbeat is what a minutes-long JOIN emits instead of
     * the poll's per-request progress.
     *
     * @param {string} jobId
     * @param {{ timeoutMs?: number, signal?: AbortSignal | null,
     *           onHeartbeat?: ((info: { jobId: string, waitedMs: number }) => void) | null,
     *           heartbeatMs?: number }} [opts]
     * @returns {Promise<object | null>}
     */
    awaitSettle(jobId, {
      timeoutMs = DEFAULT_AWAIT_TIMEOUT_MS,
      signal = null,
      onHeartbeat = null,
      heartbeatMs = DEFAULT_AWAIT_HEARTBEAT_MS
    } = {}) {
      const id = str(jobId);
      if (!id) return Promise.resolve(null);
      // Settled between the POST and this await — the common fast run.
      const queued = pending.get(id);
      if (queued) {
        claim(queued);
        return Promise.resolve(queued);
      }
      // Already delivered (a wake, or an earlier collect): nothing will arrive
      // for this id again, so return NOW instead of burning the whole timeout.
      if (isTombstoned(id)) return Promise.resolve(null);
      // Not subscribed (never started, or stopped): no settle can reach us, so
      // blocking would only hang the turn until its timeout.
      if (!started) return Promise.resolve(null);
      if (signal?.aborted) return Promise.resolve(null);

      return new Promise((resolve) => {
        const startedAt = now();
        let done = false;
        let timeoutTimer = null;
        let beatTimer = null;
        const onAbort = () => finish(null);

        function clearOne(token) {
          if (token == null) return;
          try { clearTimeoutImpl(token); } catch { /* best-effort */ }
        }

        function finish(item) {
          if (done) return;
          done = true;
          clearOne(timeoutTimer);
          clearOne(beatTimer);
          timeoutTimer = null;
          beatTimer = null;
          const set = waiters.get(id);
          if (set) {
            set.delete(waiter);
            if (set.size === 0) waiters.delete(id);
          }
          try { signal?.removeEventListener?.("abort", onAbort); } catch { /* best-effort */ }
          resolve(item ?? null);
        }

        const waiter = { settle: finish };
        const set = waiters.get(id) ?? new Set();
        set.add(waiter);
        waiters.set(id, set);

        if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
          timeoutTimer = setTimeoutImpl(() => finish(null), timeoutMs);
          // Never let a blocked JOIN be the reason the process stays alive.
          timeoutTimer?.unref?.();
        }
        if (typeof onHeartbeat === "function" && Number.isFinite(heartbeatMs) && heartbeatMs > 0) {
          const beat = () => {
            if (done) return;
            try { onHeartbeat({ jobId: id, waitedMs: now() - startedAt }); } catch { /* a heartbeat must never break the wait */ }
            if (done) return;
            beatTimer = setTimeoutImpl(beat, heartbeatMs);
            beatTimer?.unref?.();
          };
          beatTimer = setTimeoutImpl(beat, heartbeatMs);
          beatTimer?.unref?.();
        }
        try { signal?.addEventListener?.("abort", onAbort, { once: true }); } catch { /* best-effort */ }
      });
    },

    /**
     * Remember a run started with `start_run(runInBackground:true)`. The run
     * itself lives on the dashboard, so nothing here will ever see it settle —
     * the host pushes that in with `pushExternal`. This only records that the
     * session is waiting on something (`hasOutstanding`).
     */
    trackRun({ jobId, project, ticket } = {}) {
      const id = str(jobId);
      if (!id) return null;
      // Re-tracking an id means it is NEW work, so lift any tombstone on it.
      collected.delete(id);
      const entry = { project: str(project), ticket: str(ticket), startedAt: now() };
      trackedRuns.set(id, entry);
      return entry;
    },

    /**
     * Feed in a settle the HOST observed (a run-loop job finishing on the
     * dashboard). Item shape = the `attach_run` normalized yield; `kind`
     * defaults to "run".
     *
     * @returns {object | null} the normalized item, or null when nothing was
     *   queued — no jobId, or a duplicate the tombstones dropped. The serve
     *   bridge reports that null as `deduped` on the `wake` ack, so the host
     *   can see its unconditional push was already delivered.
     */
    pushExternal(item) {
      if (!item) return null;
      const kind = str(item.kind) === "agent" ? "agent" : "run";
      const normalized = kind === "agent"
        ? normalizeAgentSettle({ ...item, meta: { ...(item.meta ?? {}), task: item.task } })
        : normalizeRunSettle(item);
      if (!normalized.jobId) return null;
      return enqueue(normalized) ? normalized : null;
    },

    /**
     * The turn collected this work itself — drop it. Accepts a jobId, or
     * `{ jobId, project, ticket }`: `resume_run` / `reply_run` mint a FRESH
     * jobId for the continued run, so the id the supervisor tracked can never
     * match and the ticket is the only stable identity.
     *
     * Collecting also TOMBSTONES the id (see `collected`): the host pushes a
     * run's settle in unconditionally, so the duplicate typically arrives after
     * the tool call that already delivered it. Pass `status` when you have it —
     * a later settle with a DIFFERENT status is still let through.
     *
     * @param {string | { jobId?: string, project?: string, ticket?: string, status?: string }} target
     * @returns {boolean} whether anything was dropped
     */
    collect(target) {
      const id = typeof target === "string" ? str(target) : str(target?.jobId);
      const project = typeof target === "string" ? "" : str(target?.project);
      const ticket = typeof target === "string" ? "" : str(target?.ticket);
      const status = typeof target === "string" ? "" : str(target?.status);
      let dropped = false;
      if (id) {
        dropped = pending.delete(id) || dropped;
        dropped = trackedRuns.delete(id) || dropped;
        attempts.delete(id);
        memoCollected(id, status);
      }
      if (project && ticket) {
        for (const [runId, entry] of [...trackedRuns.entries()]) {
          if (entry.project !== project || entry.ticket !== ticket) continue;
          trackedRuns.delete(runId);
          pending.delete(runId);
          attempts.delete(runId);
          // Blanket tombstone (no status): these are the PREVIOUS jobIds of the
          // same ticket, and `status` describes the continuation, not them.
          memoCollected(runId, "");
          dropped = true;
        }
      }
      return dropped;
    },

    /**
     * Is there background work this session has neither collected nor woken
     * for? Covers all three states: still running in the registry, tracked but
     * not yet reported by the host, and settled but not yet injected.
     */
    hasOutstanding() {
      return pending.size > 0 || trackedRuns.size > 0 || runningWakeJobs() > 0;
    },

    /** A turn ended — re-evaluate whatever was held while it ran. */
    notifyTurnSettled() {
      if (pending.size > 0) schedule();
    },

    /** Replace the injection path (a surface that queues turns of its own). */
    setInjector(fn) {
      inject = typeof fn === "function" ? fn : null;
      if (inject && pending.size > 0) schedule();
      return supervisor;
    },

    /** Test seam: inject the pending batch now, skipping the debounce. */
    flushNow() {
      clearTimer();
      return fire();
    },

    /** Test seam: what is queued right now. */
    __inspect() {
      return {
        started,
        injecting,
        pending: [...pending.values()],
        trackedRuns: [...trackedRuns.keys()],
        waiters: [...waiters.keys()],
        attempts: Object.fromEntries(attempts),
        collected: [...collected.entries()].map(([jobId, memo]) => ({ jobId, ...memo }))
      };
    }
  };

  return supervisor;
}
