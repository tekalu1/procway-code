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
 *   driver.start(spec, { onEvent, onYield, jobId }) => handle
 *     - the driver runs the job DETACHED and calls:
 *         onEvent(e)               for progress / liveness heartbeats
 *         onYield({ status, result?, error?, awaiting?, ttlMs? })
 *                                  when it completes / fails / pauses
 *           ttlMs (optional)       per-settle eviction window override; lets a
 *                                  driver keep a resumable terminal (e.g. the
 *                                  run loop's awaiting-user-input) live longer.
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
    const entry = { state, emitter: new EventEmitter(), handle: null, evictTimer: undefined };
    // Many subscribers (e.g. SSE-like fan-out) may attach; don't warn.
    entry.emitter.setMaxListeners(0);
    this.jobs.set(id, entry);

    const onEvent = (e) => this._pushEvent(entry, e);
    const onYield = (y) => this._settle(entry, y);

    try {
      const handle = driver.start(spec, { onEvent, onYield, jobId: id });
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

  /** Test-only: clear the registry and cancel pending eviction timers. */
  __resetForTest() {
    for (const entry of this.jobs.values()) {
      if (entry.evictTimer) this.clearTimeoutImpl(entry.evictTimer);
    }
    this.jobs.clear();
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
    this._scheduleEvict(entry);
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
  SHARED_REGISTRY = new DelegatedJobRegistry();
  return SHARED_REGISTRY;
}
