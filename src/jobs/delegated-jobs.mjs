import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

/**
 * ADR 0029 Phase 4 / ADR 0030 D2 — the ONE shared generic delegated-job
 * registry, owned by procway-code.
 *
 * This is the single source of truth for the "spawn → run detached → stream
 * progress → yield on completed/failed/awaiting-input → resume → kill/evict"
 * lifecycle. It used to be reimplemented twice (an earlier ai-agent registry
 * and the dashboard's `run-loop-jobs.service.ts`); ADR 0029 P4 collapsed the
 * duplicated plumbing into one pure-node module (then in `packages/core`), and
 * ADR 0030 D2 moved its ownership HERE so procway-code never imports from the
 * monorepo (dependency rule: procway → procway-code, one-way). The registry is
 * deliberately NEUTRAL — `node:crypto` + `node:events` only, no knowledge of
 * any driver — so BOTH consumers build on it:
 *   - the ai-agent imports it directly (process / agent kinds; the shared
 *     singleton below is the front door for the shell_job / spawn_agent tools).
 *   - the dashboard imports it via the same dynamic-import-by-URL pattern it
 *     uses for run-loop.mjs / run-task.mjs, and expresses the run loop as a
 *     driver (run-loop / resume / conversational-resume kinds).
 *
 * It is an in-process `Map<jobId, { state, emitter, handle }>` with a per-job
 * ring buffer + injectable TTL eviction. The RUNNER is pluggable — a **driver**
 * — so the same contract can carry the background shell, sub-agents, the run
 * loop and anything else later, instead of being hard-wired to one handler.
 *
 * Driver contract:
 *   driver.start(spec, { onEvent, onYield, jobId, signal }) => handle
 *     - the driver runs the job DETACHED and calls:
 *         onEvent(e)               for progress / liveness heartbeats
 *         onYield({ status, result?, error?, awaiting?, ttlMs? })
 *                                  when it completes / fails / pauses
 *           ttlMs (optional)       per-settle eviction window override; lets a
 *                                  driver keep a resumable terminal (e.g. the
 *                                  run loop's awaiting-user-input) live longer.
 *         signal                   the job's per-job AbortSignal — a driver that
 *                                  threads it into its work (the run loop →
 *                                  runTask → serve-client) can fold an in-flight
 *                                  turn when `abortJob(jobId)` fires it. Drivers
 *                                  that don't observe it are unaffected.
 *     - handle = { kill(), resume?(input), ...kind-specific extensions }
 *       (the process driver also hangs status()/logs() off the handle so the
 *        shell_job tool can read live output without the registry knowing about
 *        process specifics.)
 *
 * Status model (the GENERIC core):
 *   running        — work in flight
 *   completed      — terminal success (result)
 *   failed         — terminal failure (error)
 *   awaiting-input — paused, resumable via resumeJob (NOT terminal, not evicted)
 * Consumers may settle with kind-specific statuses too (the run loop yields its
 * own RunLoopOutput statuses verbatim); the registry stores whatever status it
 * is given and only special-cases eviction/resume via the configurable sets
 * below.
 *
 * Everything that calls into user/driver code is wrapped so a throw can never
 * crash the host process or break the registry.
 */

const EVENTS_CAP = 500;
const DEFAULT_TTL_MS = 30 * 60_000;

export class DelegatedJobRegistry {
  /**
   * @param {object} [opts]
   * @param {() => number} [opts.now]            injectable clock (tests)
   * @param {() => string} [opts.idFactory]      injectable id minter (tests)
   * @param {number} [opts.ttlMs]                terminal-job eviction TTL
   * @param {typeof setTimeout} [opts.setTimeoutImpl]   injectable (tests)
   * @param {typeof clearTimeout} [opts.clearTimeoutImpl]
   * @param {Iterable<string>} [opts.resumableStatuses]  statuses for which
   *        resumeJob is allowed (default: just 'awaiting-input'). The dashboard
   *        run loop adds its own resumable pause status ('awaiting-user-input').
   * @param {Iterable<string>} [opts.noEvictStatuses]  statuses that are NEVER
   *        scheduled for eviction on settle (default: just 'awaiting-input', a
   *        pause that waits indefinitely for resume). DISTINCT from resumable:
   *        the run loop's awaiting-user-input is resumable but still evicted on
   *        a long failsafe TTL, so it sets this to empty.
   */
  constructor({
    now = () => Date.now(),
    idFactory = randomUUID,
    ttlMs = DEFAULT_TTL_MS,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    resumableStatuses = ["awaiting-input"],
    noEvictStatuses = ["awaiting-input"],
  } = {}) {
    this.now = now;
    this.idFactory = idFactory;
    this.ttlMs = ttlMs;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.resumableStatuses = new Set(resumableStatuses);
    this.noEvictStatuses = new Set(noEvictStatuses);
    /** @type {Map<string, JobEntry>} */
    this.jobs = new Map();
    /**
     * Registry-level fan-out for settles (see subscribeSettled). Separate from
     * the per-job emitters because a consumer that wants "did anything of mine
     * finish?" cannot subscribe per job: the job it cares about may not exist
     * yet when it subscribes, and holding a subscription per job would leak.
     */
    this.settledEmitter = new EventEmitter();
    this.settledEmitter.setMaxListeners(0);
  }

  /**
   * Mint a jobId, register the state, and start the driver DETACHED. Returns
   * synchronously with `{ jobId, status: 'running' }` BEFORE the driver has done
   * any work. A synchronous throw from driver.start (or a rejected promise it
   * returns) settles the job as `failed` instead of crashing the process.
   *
   * @param {object} args
   * @param {string} args.kind
   * @param {unknown} args.spec
   * @param {{ start: Function }} args.driver
   * @param {string} [args.jobId]   pre-minted id (the run loop mints a run id
   *        out-of-band); defaults to idFactory().
   * @param {Record<string, unknown>} [args.meta]   consumer metadata copied
   *        onto the job state (e.g. project/ticket) — opaque to the registry.
   */
  spawnJob({ kind, spec, driver, jobId, meta }) {
    const id = jobId ?? this.idFactory();
    const now = this.now();
    /** @type {JobState} */
    const state = {
      jobId: id,
      kind,
      status: "running",
      result: undefined,
      error: undefined,
      awaiting: undefined,
      events: [],
      startedAt: now,
      updatedAt: now,
      ...(meta ? { meta } : {}),
    };
    // Per-job abort handle: fired by abortJob(jobId) and handed to the driver
    // so a signal-aware driver can fold an in-flight turn. Created eagerly (an
    // unfired controller is inert) so abortJob never has to special-case a
    // job that hasn't wired one.
    const abortController = new AbortController();
    // `spec` is retained on the entry (NOT the public state) so dehydrateJobs
    // (ADR 0037 D4) can persist enough to describe/resume the job after a
    // process restart. Kept off state to preserve the public shape.
    const entry = { state, emitter: new EventEmitter(), handle: null, evictTimer: undefined, abortController, spec };
    // Many subscribers (e.g. SSE-like fan-out) may attach; don't warn.
    entry.emitter.setMaxListeners(0);
    this.jobs.set(id, entry);

    const onEvent = (e) => this._pushEvent(entry, e);
    const onYield = (y) => this._settle(entry, y);

    try {
      const handle = driver.start(spec, { onEvent, onYield, jobId: id, signal: abortController.signal });
      // Allow a driver to return a thenable that resolves to the real handle;
      // a rejection settles the job as failed.
      if (handle && typeof handle.then === "function") {
        Promise.resolve(handle)
          .then((h) => { entry.handle = h ?? null; })
          .catch((err) => this._fail(entry, err));
      } else {
        entry.handle = handle ?? null;
      }
    } catch (err) {
      this._fail(entry, err);
    }

    return { jobId: id, status: "running" };
  }

  /** Live job state (or null). Mirrors the reference registry — returns the live
   *  object, not a copy. */
  getJob(jobId) {
    return this.jobs.get(jobId)?.state ?? null;
  }

  /** The driver handle for a job (or null). Used by kind-specific tools (e.g.
   *  shell_job) to reach driver extensions like status()/logs(). */
  getJobHandle(jobId) {
    return this.jobs.get(jobId)?.handle ?? null;
  }

  /**
   * Replay the ring buffer to `handler`, then forward live 'event'/'yield'
   * envelopes. If the job has already left 'running', the current yield is
   * replayed too (so a late subscriber still sees the settle). Every callback is
   * wrapped — a throwing subscriber can't break the registry. Returns an
   * unsubscribe function.
   */
  subscribeJob(jobId, handler) {
    const entry = this.jobs.get(jobId);
    if (!entry) return () => {};

    for (const e of entry.state.events) {
      try { handler({ type: "event", data: e }); } catch { /* best-effort subscriber */ }
    }
    if (entry.state.status !== "running") {
      try {
        handler({ type: "yield", data: this._yieldPayload(entry.state) });
      } catch { /* best-effort */ }
    }

    const onEvent = (e) => { try { handler({ type: "event", data: e }); } catch { /* best-effort */ } };
    const onYield = (y) => { try { handler({ type: "yield", data: y }); } catch { /* best-effort */ } };
    entry.emitter.on("event", onEvent);
    entry.emitter.on("yield", onYield);
    return () => {
      entry.emitter.off("event", onEvent);
      entry.emitter.off("yield", onYield);
    };
  }

  /**
   * Subscribe to EVERY settle in this registry — the registry-level counterpart
   * of subscribeJob (issue #143, event-wake). One listener sees every job that
   * leaves 'running', including jobs spawned after the subscription, which is
   * what a session-level supervisor needs: it must react to "something of mine
   * finished" without holding a subscription per job.
   *
   * Deliberately does NOT replay. subscribeJob replays the ring buffer and the
   * current yield so a late per-job subscriber still sees the settle; doing the
   * same here would hand a fresh subscriber the entire settle history of the
   * process, and a wake supervisor would fire for work that was collected long
   * ago.
   *
   * The payload is a SNAPSHOT taken at settle time, not a live reference:
   * terminal jobs are evicted after the TTL, so `getJob(jobId)` may already
   * return null by the time a subscriber acts on it.
   *
   *   handler({ jobId, kind, status, result, error, awaiting, meta, restored })
   *     jobId    the settled job
   *     kind     its kind ('agent' | 'process' | consumer-specific)
   *     status   the terminal / paused status it settled with
   *     meta     a shallow copy of the spawn-time metadata (undefined if none)
   *     restored true when the job came back from a snapshot (rehydrateJobs)
   *              and settled afterwards — a consumer may want to treat that
   *              differently from work this process actually ran.
   *
   * Note that rehydrateJobs' own "running → failed (lost to a restart)"
   * conversion does NOT emit: it is a bookkeeping repair, not a settle, and
   * emitting would fire a burst of wakes the instant a session resumes.
   *
   * A throwing handler can never break the registry (same discipline as
   * subscribeJob). Returns an unsubscribe function.
   *
   * @param {(payload: object) => void} handler
   * @returns {() => void}
   */
  subscribeSettled(handler) {
    if (typeof handler !== "function") return () => {};
    const onSettled = (payload) => {
      try { handler(payload); } catch { /* best-effort subscriber */ }
    };
    this.settledEmitter.on("settled", onSettled);
    return () => { this.settledEmitter.off("settled", onSettled); };
  }

  /**
   * Resolve at the next NON-running yield (completed / failed / awaiting-input).
   * If the job is already settled, resolves immediately. Unknown job → null.
   * This is the await-yield primitive (ADR 0029) — a tool can fire a job and
   * await its first yield.
   */
  awaitJobYield(jobId) {
    const entry = this.jobs.get(jobId);
    if (!entry) return Promise.resolve(null);
    if (entry.state.status !== "running") {
      return Promise.resolve(this._yieldPayload(entry.state));
    }
    return new Promise((resolve) => {
      const onYield = (y) => {
        entry.emitter.off("yield", onYield);
        resolve(y);
      };
      entry.emitter.on("yield", onYield);
    });
  }

  /**
   * Resume a paused (resumable) job: flip it back to running, cancel any pending
   * eviction, and call the driver's resume(input). Drivers without a resume are
   * a no-op flip (the registry stays consistent). Unknown job → null.
   */
  resumeJob(jobId, input) {
    const entry = this.jobs.get(jobId);
    if (!entry) return null;
    // Only a resumable pause is resumable. Flipping a terminal
    // (completed/failed) — or already-running — job back to 'running' would
    // strand it as a non-yielding, non-evictable zombie. (P3 keystone: the
    // agent driver resumes via this path, and the run loop's /answer resumes
    // its awaiting-user-input pause, so the guard matters.)
    if (!this.resumableStatuses.has(entry.state.status)) {
      return { jobId, status: entry.state.status };
    }
    if (entry.evictTimer) {
      this.clearTimeoutImpl(entry.evictTimer);
      entry.evictTimer = undefined;
    }
    entry.state.status = "running";
    entry.state.awaiting = undefined;
    entry.state.error = undefined;
    entry.state.updatedAt = this.now();
    const handle = entry.handle;
    if (handle && typeof handle.resume === "function") {
      try { handle.resume(input); } catch (err) { this._fail(entry, err); }
    }
    return { jobId, status: "running" };
  }

  /** Kill a job via its driver handle. Returns whatever the driver's kill
   *  returns (may be a promise). Unknown job / no kill → null. */
  killJob(jobId) {
    const entry = this.jobs.get(jobId);
    if (!entry) return null;
    const handle = entry.handle;
    if (handle && typeof handle.kill === "function") {
      try { return handle.kill(); } catch (err) {
        entry.state.error = err instanceof Error ? err.message : String(err);
        return null;
      }
    }
    return null;
  }

  /**
   * Stop a running job. Fires the job's AbortSignal so a signal-aware driver
   * (the run loop → runTask → serve-client) folds its in-flight turn and
   * settles through its OWN onYield — abortJob deliberately does NOT force a
   * terminal state, so the driver's real terminal (result + housekeeping) is
   * preserved. Also calls the handle's kill() when present, covering drivers
   * that don't observe the signal (e.g. a detached child process). Idempotent;
   * unknown job → null.
   */
  abortJob(jobId) {
    const entry = this.jobs.get(jobId);
    if (!entry) return null;
    try { entry.abortController?.abort(); } catch { /* best-effort: abort must never throw */ }
    const handle = entry.handle;
    if (handle && typeof handle.kill === "function") {
      try { handle.kill(); } catch (err) {
        entry.state.error = err instanceof Error ? err.message : String(err);
      }
    }
    return { jobId, status: entry.state.status };
  }

  /** Snapshot of all live job states (the live objects, not copies — mirrors
   *  getJob). Lets a consumer find a job by its opaque `meta` when it holds no
   *  jobId (e.g. the dashboard aborting a ticket's run-loop job by
   *  project/ticket). */
  listJobs() {
    return Array.from(this.jobs.values(), (e) => e.state);
  }

  /**
   * ADR 0037 D4 — serialize the registry's job state for a session snapshot.
   * Returns plain-JSON descriptors for every job whose `meta.sessionId`
   * matches (or every job when no filter is given). The events ring buffer is
   * NOT serialized (bounded live-streaming state); `spec` and `meta` ride
   * along so a rehydrated job can still be described — and, for kinds that
   * support it later, cold-resumed.
   *
   * @param {{ sessionId?: string }} [filter]
   * @returns {Array<object>}
   */
  dehydrateJobs({ sessionId } = {}) {
    const out = [];
    for (const entry of this.jobs.values()) {
      const s = entry.state;
      if (sessionId && s.meta?.sessionId !== sessionId) continue;
      out.push({
        jobId: s.jobId,
        kind: s.kind,
        status: s.status,
        ...(s.result !== undefined ? { result: s.result } : {}),
        ...(s.error !== undefined ? { error: s.error } : {}),
        ...(s.awaiting !== undefined ? { awaiting: s.awaiting } : {}),
        ...(s.meta ? { meta: s.meta } : {}),
        ...(entry.spec !== undefined ? { spec: entry.spec } : {}),
        startedAt: s.startedAt,
        updatedAt: s.updatedAt
      });
    }
    return out;
  }

  /**
   * ADR 0037 D4 — restore dehydrated jobs after a process restart so status /
   * logs / resume queries answer truthfully instead of "unknown job".
   *
   *   - A job that was `running` did NOT survive (its child process / inline
   *     child died with the old process) → restored as `failed` with an
   *     explicit lost-to-restart error.
   *   - Terminal and awaiting-input jobs are restored verbatim. A restored
   *     awaiting-input job has no live driver handle; resuming it settles it
   *     as `failed` with a clear reason unless a kind-specific `coldResume`
   *     is supplied (`coldResumes[kind] = (dehydrated, input, {onEvent,
   *     onYield}) => handle` — the seam a future interactive agent kind uses).
   *
   * Jobs already present in the registry (id collision) are left untouched —
   * the live entry is always fresher than the snapshot. Returns the number of
   * jobs restored.
   *
   * @param {Array<object>} entries
   * @param {{ coldResumes?: Record<string, Function> }} [opts]
   */
  rehydrateJobs(entries, { coldResumes = {} } = {}) {
    if (!Array.isArray(entries)) return 0;
    let restored = 0;
    for (const d of entries) {
      if (!d || typeof d.jobId !== "string" || d.jobId.length === 0) continue;
      if (this.jobs.has(d.jobId)) continue;
      const lost = d.status === "running";
      const now = this.now();
      /** @type {JobState} */
      const state = {
        jobId: d.jobId,
        kind: typeof d.kind === "string" ? d.kind : "unknown",
        status: lost ? "failed" : d.status,
        result: lost ? undefined : d.result,
        error: lost
          ? "job lost to an agent restart (its process did not survive; start it again if still needed)"
          : d.error,
        awaiting: lost ? undefined : d.awaiting,
        events: [],
        startedAt: Number.isFinite(d.startedAt) ? d.startedAt : now,
        updatedAt: now,
        ...(d.meta ? { meta: d.meta } : {}),
        restored: true
      };
      const entry = {
        state,
        emitter: new EventEmitter(),
        handle: null,
        evictTimer: undefined,
        abortController: new AbortController(),
        spec: d.spec
      };
      entry.emitter.setMaxListeners(0);
      // Restored handle: kill is a no-op (nothing lives); resume delegates to a
      // kind-specific cold-resume when provided, else settles failed loudly so
      // a caller is never left with a silently-flipped 'running' zombie.
      const coldResume = typeof coldResumes[state.kind] === "function" ? coldResumes[state.kind] : null;
      entry.handle = {
        kill: () => null,
        resume: (input) => {
          if (coldResume) {
            const onEvent = (e) => this._pushEvent(entry, e);
            const onYield = (y) => this._settle(entry, y);
            try {
              entry.handle = coldResume(d, input, { onEvent, onYield, jobId: state.jobId, signal: entry.abortController.signal }) ?? entry.handle;
            } catch (err) {
              this._fail(entry, err);
            }
            return;
          }
          this._settle(entry, {
            status: "failed",
            error: `job ${state.jobId} was restored from a snapshot after a restart and its kind ("${state.kind}") cannot be cold-resumed`
          });
        }
      };
      this.jobs.set(d.jobId, entry);
      // Same eviction discipline as a live settle: no-evict pauses stay put,
      // terminals age out so restored history doesn't pin memory forever.
      if (!this.noEvictStatuses.has(state.status)) this._scheduleEvict(entry);
      restored += 1;
    }
    return restored;
  }

  /** Test-only: clear the registry and cancel pending eviction timers. */
  __resetForTest() {
    for (const entry of this.jobs.values()) {
      if (entry.evictTimer) this.clearTimeoutImpl(entry.evictTimer);
    }
    this.jobs.clear();
    this.settledEmitter.removeAllListeners();
  }

  // --- internals ---

  _yieldPayload(state) {
    return { status: state.status, result: state.result, error: state.error, awaiting: state.awaiting };
  }

  _pushEvent(entry, e) {
    try {
      entry.state.events.push(e);
      if (entry.state.events.length > EVENTS_CAP) {
        entry.state.events.splice(0, entry.state.events.length - EVENTS_CAP);
      }
      entry.state.updatedAt = this.now();
      entry.emitter.emit("event", e);
    } catch { /* best-effort: event sink must never break the driver */ }
  }

  _settle(entry, y) {
    const status = y?.status ?? "completed";
    entry.state.status = status;
    if (y && "result" in y) entry.state.result = y.result;
    if (y && y.error !== undefined) {
      entry.state.error = y.error instanceof Error ? y.error.message : String(y.error);
    }
    entry.state.awaiting = y?.awaiting;
    entry.state.updatedAt = this.now();
    try {
      entry.emitter.emit("yield", this._yieldPayload(entry.state));
    } catch { /* best-effort */ }
    this._emitSettled(entry);
    // A no-evict pause keeps the job live indefinitely so resumeJob/awaitJob‐
    // Yield can rendezvous; everything else is evicted after the TTL (a driver
    // may hand a per-settle ttlMs to widen the window for a resumable terminal,
    // e.g. the run loop's awaiting-user-input failsafe).
    if (!this.noEvictStatuses.has(status)) this._scheduleEvict(entry, y?.ttlMs);
  }

  _fail(entry, err) {
    const message = err instanceof Error ? err.message : String(err);
    entry.state.status = "failed";
    entry.state.error = message;
    entry.state.result = undefined;
    entry.state.awaiting = undefined;
    entry.state.updatedAt = this.now();
    try {
      entry.emitter.emit("yield", this._yieldPayload(entry.state));
    } catch { /* best-effort */ }
    this._emitSettled(entry);
    this._scheduleEvict(entry);
  }

  /**
   * Registry-level settle fan-out (subscribeSettled). Called from BOTH settle
   * paths — _settle (a driver's onYield) and _fail (a synchronous throw or a
   * rejected promise from driver.start) — because a consumer that only heard
   * about the first would silently never be woken for a job that died at spawn.
   */
  _emitSettled(entry) {
    const s = entry.state;
    const payload = {
      jobId: s.jobId,
      kind: s.kind,
      status: s.status,
      result: s.result,
      error: s.error,
      awaiting: s.awaiting,
      // Shallow copy: the payload must stay valid after the job is evicted.
      meta: s.meta ? { ...s.meta } : undefined,
      restored: s.restored === true
    };
    try {
      this.settledEmitter.emit("settled", payload);
    } catch { /* best-effort: a settle sink must never break the driver */ }
  }

  _scheduleEvict(entry, ttlMs) {
    if (entry.evictTimer) this.clearTimeoutImpl(entry.evictTimer);
    const ttl = ttlMs ?? this.ttlMs;
    const timer = this.setTimeoutImpl(() => {
      this.jobs.delete(entry.state.jobId);
    }, ttl);
    // Don't pin the event loop just to evict a finished job.
    timer?.unref?.();
    entry.evictTimer = timer;
  }
}

/**
 * @typedef {object} JobState
 * @property {string} jobId
 * @property {string} kind
 * @property {string} status  'running'|'completed'|'failed'|'awaiting-input'|consumer-specific
 * @property {unknown} [result]
 * @property {string} [error]
 * @property {{ inputKind: string, payload?: unknown }} [awaiting]
 * @property {Array<Record<string, unknown>>} events  ring buffer (cap 500)
 * @property {number} startedAt
 * @property {number} updatedAt
 * @property {Record<string, unknown>} [meta]  opaque consumer metadata
 *
 * @typedef {object} JobEntry
 * @property {JobState} state
 * @property {import('node:events').EventEmitter} emitter
 * @property {any} handle
 * @property {ReturnType<typeof setTimeout>} [evictTimer]
 * @property {AbortController} abortController  per-job abort handle (abortJob)
 */

// --- ai-agent-scoped process-wide singleton (the front door for the
//     shell_job / spawn_agent tools) ---

let SHARED_REGISTRY = null;

/** Process-wide shared registry — the front door for delegated jobs. */
export function getSharedJobRegistry() {
  if (!SHARED_REGISTRY) SHARED_REGISTRY = new DelegatedJobRegistry();
  return SHARED_REGISTRY;
}

/** Test-only: swap in a fresh shared registry. */
export function resetSharedJobRegistryForTests() {
  // Tear the outgoing registry down first: its jobs would keep evict timers,
  // and its subscribeSettled listeners would keep the previous test's
  // supervisors reachable from a registry nobody can reach any more.
  try { SHARED_REGISTRY?.__resetForTest(); } catch { /* best-effort */ }
  SHARED_REGISTRY = new DelegatedJobRegistry();
  return SHARED_REGISTRY;
}
