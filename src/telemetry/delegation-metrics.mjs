import path from "node:path";
import { isTelemetryEnabled } from "./otel.mjs";

/**
 * ADR 0029 追補 A1 / E7 Phase 3 — the MEASUREMENT behind "should background
 * become the default?".
 *
 * Phase 1 and 2 of event-wake are done, and the default is deliberately still
 * opt-in. Two objections survive event-wake and neither can be settled from the
 * armchair (see the ADR's E7):
 *
 *   ① concurrent-write hazard — a child agent is a full write subject, so two
 *      children in ONE workspace may or may not be safe. Is that a real
 *      occurrence or a hypothetical?
 *   ② single-case cost — one child / one run is the common case, and making it
 *      background turns it into two round trips (spawn + wake) with the whole
 *      context re-sent. If concurrency is effectively always 1, flipping the
 *      default is pure overhead.
 *
 * This module counts exactly what those two questions need, and nothing else:
 *
 *   1. usage split      — spawn_agent / start_run, foreground vs background
 *   2. concurrency      — peak + distribution of SIMULTANEOUSLY UNCOLLECTED
 *                         background jobs. Flat at 1 ⇒ backgrounding buys
 *                         nothing.
 *   3. foreground JOIN  — wall clock a turn actually sat blocked. The ceiling
 *                         of what backgrounding could win back.
 *   4. wake cost        — wake turns injected, items coalesced per turn, and
 *                         settle→inject latency. A coalesce ratio pinned at
 *                         1.0 means the "we batch them" premise is false.
 *   5. same-cwd hazard  — how often two or more children ran AT THE SAME TIME
 *                         in the SAME working directory (①, measured).
 *
 * Design constraints, all of them load-bearing:
 *
 *   - **Opt-in, same switch as the rest of telemetry.** Off unless
 *     `PROCWAY_TELEMETRY` is on (`isTelemetryEnabled`, shared with otel.mjs).
 *     procway-code ships standalone on npm; it must not gather anything about
 *     someone's work without them turning it on. When off, `createDelegation-
 *     Metrics` hands back a frozen no-op and every call site optional-chains
 *     into nothing.
 *   - **No paths, no prompts, no task text, ever.** ① needs "were these two
 *     children in the same directory?", which is a comparison, not a path. So
 *     directories are used as Map KEYS inside this process and only counts
 *     leave it. Nothing is hashed, because nothing is emitted — a hash would
 *     need a salt policy for no gain.
 *   - **No network.** The snapshot goes out as ONE structured NDJSON line on
 *     stderr behind the `__procway_metrics__` marker, exactly the discipline
 *     `crash-reporter.mjs` uses for fatal errors: the process states a fact,
 *     the host (which owns the trust boundary) decides where it goes.
 *   - **Cumulative and idempotent.** Every line is the whole session so far, so
 *     the LAST line is the answer and a killed process still leaves the truth
 *     up to its last turn. `flush()` writes only when something changed, so a
 *     session that delegates nothing prints nothing at all.
 *   - **Never changes behaviour.** Pure accumulation (Maps and integers), no
 *     timers, no subscriptions, no async. Every public method swallows its own
 *     errors: a metric must not be able to fail a turn.
 */

/** Marker the host greps for, mirroring crash-reporter's `__procway_crash__`. */
const METRICS_MARKER = "__procway_metrics__";

/** Buckets above this are folded into a single ">N" key so the histogram is bounded. */
const HISTOGRAM_CAP = 10;

/** Hard cap on the per-directory table (a pathological session can't grow it forever). */
const CWD_TABLE_CAP = 200;

/**
 * The join surfaces we time. Split on the question the ADR asks: only the
 * FOREGROUND ones are wall clock that flipping the default could win back —
 * `attach_run` / `agent_job wait` are explicit joins of work that is ALREADY
 * background, so their time is not evidence for a flip.
 */
const RECOVERABLE_JOIN_SURFACES = Object.freeze(["spawn_agent_foreground", "start_run_foreground"]);
const JOIN_SURFACES = Object.freeze([...RECOVERABLE_JOIN_SURFACES, "attach_run", "agent_job_wait"]);

/** Delegation surfaces whose foreground/background split is counted. */
const DELEGATION_SURFACES = Object.freeze(["spawn_agent", "start_run"]);

const NOOP_METRICS = Object.freeze({
  enabled: false,
  delegationStarted() {},
  joinBlocked() {},
  childSettled() {},
  collected() {},
  wakeQueued() {},
  wakeInjected() {},
  wakeInjectFailed() {},
  snapshot() { return null; },
  flush() { return false; }
});

function emptyDuration() {
  return { count: 0, totalMs: 0, maxMs: 0 };
}

function bucket(n) {
  return n > HISTOGRAM_CAP ? `>${HISTOGRAM_CAP}` : String(n);
}

function bump(table, key) {
  table[key] = (table[key] ?? 0) + 1;
}

/** Default sink — one NDJSON line on stderr. Never throws (see crash-reporter). */
function writeToStderr(line) {
  try {
    process.stderr.write(line);
  } catch {
    /* stderr unavailable — a metric is never worth an exception */
  }
}

/**
 * Create the per-session delegation metrics collector.
 *
 * Shaped after `usage-tracker.mjs` (in-memory accumulator + `snapshot()`), but
 * deliberately WITHOUT its event-bus subscription: this one is fed by explicit
 * calls from the two places that know the facts (the tool dispatcher and the
 * wake supervisor), so it owns no listener that could outlive a session.
 *
 * @param {object} [opts]
 * @param {string} [opts.sessionId]      tags the emitted line (opaque id, no PII)
 * @param {NodeJS.ProcessEnv} [opts.env] switch source (default `process.env`)
 * @param {() => number} [opts.now]      injectable clock (tests)
 * @param {(line: string) => void} [opts.write]  injectable sink (tests)
 * @returns {object} the collector, or a frozen no-op when telemetry is off
 */
export function createDelegationMetrics({
  sessionId = null,
  env = process.env,
  now = () => Date.now(),
  write = writeToStderr
} = {}) {
  if (!isTelemetryEnabled(env)) return NOOP_METRICS;

  const startedAt = now();

  // 1. usage split
  const usage = {};
  for (const surface of DELEGATION_SURFACES) usage[surface] = { foreground: 0, background: 0 };

  // 2. concurrency of UNCOLLECTED background work
  /** @type {Set<string>} background jobIds started and not yet delivered to the model */
  const outstanding = new Set();
  const concurrency = { peak: 0, histogram: {}, peakBySurface: { spawn_agent: 0, start_run: 0 } };
  /** @type {Map<string, string>} jobId → surface, so a release knows what it released */
  const outstandingSurface = new Map();
  const outstandingBySurface = { spawn_agent: 0, start_run: 0 };

  // 3. join wall clock
  const join = {};
  for (const surface of JOIN_SURFACES) join[surface] = emptyDuration();

  // 4. wake cost
  const wake = {
    turns: 0,
    items: 0,
    batchHistogram: {},
    latency: emptyDuration(),
    // Split out because the `start_run` half of the decision turns on it: a run
    // that settled PAUSED for an answer is a hearing waiting to be relayed, and
    // that delay lands on the user. Kept separate from the overall latency so
    // one slow finished child cannot hide it.
    awaitingRunLatency: emptyDuration(),
    injectFailures: 0
  };
  /** @type {Map<string, number>} jobId → when its settle was queued (for latency) */
  const queuedAt = new Map();

  // 5. same-cwd hazard. `cwdKey` never leaves this process — only counts do.
  /** @type {Map<string, { total: number, background: number }>} live children per directory */
  const liveByCwd = new Map();
  /** @type {Map<string, { cwdKey: string, background: boolean }>} live child jobId → its directory */
  const liveChildren = new Map();
  const hazard = {
    sameCwdPeak: 0,
    sameCwdOverlaps: 0,
    sameCwdBackgroundOverlaps: 0,
    distinctCwds: 0,
    cwdTableTruncated: false
  };
  const seenCwds = new Set();

  let dirty = false;
  let lastLine = null;

  /** Every public method funnels through this: a metric may never break a turn. */
  function guard(fn) {
    return (...args) => {
      try { return fn(...args); } catch { return undefined; }
    };
  }

  function releaseChild(jobId) {
    const live = liveChildren.get(jobId);
    if (!live) return;
    liveChildren.delete(jobId);
    const entry = liveByCwd.get(live.cwdKey);
    if (!entry) return;
    entry.total -= 1;
    if (live.background) entry.background -= 1;
    if (entry.total <= 0) liveByCwd.delete(live.cwdKey);
  }

  function releaseOutstanding(jobId) {
    if (!outstanding.delete(jobId)) return;
    const surface = outstandingSurface.get(jobId);
    outstandingSurface.delete(jobId);
    if (surface && outstandingBySurface[surface] > 0) outstandingBySurface[surface] -= 1;
  }

  const metrics = {
    enabled: true,

    /**
     * A delegation call was dispatched.
     *
     * @param {object} info
     * @param {"spawn_agent"|"start_run"} info.surface
     * @param {boolean} info.background  true when it returned an id instead of awaiting
     * @param {string} [info.jobId]      required for background work (concurrency tracking)
     * @param {string} [info.cwd]        the CHILD's working directory — used as a Map key
     *                                   only, never emitted (see the header)
     * @param {string} [info.baseCwd]    the session cwd `info.cwd` is relative to
     */
    delegationStarted: guard(({ surface, background = false, jobId = null, cwd = null, baseCwd = null } = {}) => {
      if (!usage[surface]) return;
      usage[surface][background ? "background" : "foreground"] += 1;
      dirty = true;

      if (background && typeof jobId === "string" && jobId.length > 0 && !outstanding.has(jobId)) {
        outstanding.add(jobId);
        outstandingSurface.set(jobId, surface);
        outstandingBySurface[surface] = (outstandingBySurface[surface] ?? 0) + 1;
        const level = outstanding.size;
        if (level > concurrency.peak) concurrency.peak = level;
        if (outstandingBySurface[surface] > (concurrency.peakBySurface[surface] ?? 0)) {
          concurrency.peakBySurface[surface] = outstandingBySurface[surface];
        }
        // Sampled at every increment, so the distribution answers "how many
        // were in flight together?" — the question that decides the flip.
        bump(concurrency.histogram, bucket(level));
      }

      // Hazard tracking is about CHILDREN: they write this workspace. A run
      // executes on the dashboard, in its own worker session, so it is not part
      // of this measurement.
      if (surface !== "spawn_agent") return;
      if (typeof jobId !== "string" || jobId.length === 0) return;
      const cwdKey = resolveCwdKey(cwd, baseCwd);
      if (!cwdKey) return;
      if (!liveByCwd.has(cwdKey) && liveByCwd.size >= CWD_TABLE_CAP) {
        // Bounded: a pathological session must not grow this table forever.
        hazard.cwdTableTruncated = true;
        return;
      }
      if (!seenCwds.has(cwdKey)) {
        if (seenCwds.size >= CWD_TABLE_CAP) hazard.cwdTableTruncated = true;
        else {
          seenCwds.add(cwdKey);
          hazard.distinctCwds = seenCwds.size;
        }
      }
      const entry = liveByCwd.get(cwdKey) ?? { total: 0, background: 0 };
      entry.total += 1;
      if (background) entry.background += 1;
      liveByCwd.set(cwdKey, entry);
      liveChildren.set(jobId, { cwdKey, background: background === true });
      if (entry.total > hazard.sameCwdPeak) hazard.sameCwdPeak = entry.total;
      // "Two children were writing the same directory at the same moment."
      if (entry.total >= 2) hazard.sameCwdOverlaps += 1;
      // ADR E7 ① as literally asked: ≥2 BACKGROUND children in one directory.
      if (entry.background >= 2) hazard.sameCwdBackgroundOverlaps += 1;
    }),

    /**
     * A turn sat blocked inside a JOIN for `ms`.
     *
     * @param {{ surface: string, ms: number }} info
     */
    joinBlocked: guard(({ surface, ms } = {}) => {
      const entry = join[surface];
      if (!entry || !Number.isFinite(ms) || ms < 0) return;
      entry.count += 1;
      entry.totalMs += Math.round(ms);
      if (ms > entry.maxMs) entry.maxMs = Math.round(ms);
      dirty = true;
    }),

    /** A child agent job left `running` — it is no longer writing the workspace. */
    childSettled: guard((jobId) => {
      if (typeof jobId !== "string" || jobId.length === 0) return;
      releaseChild(jobId);
    }),

    /** Background work reached the model (a wake delivered it, or a JOIN collected it). */
    collected: guard((jobId) => {
      if (typeof jobId !== "string" || jobId.length === 0) return;
      releaseOutstanding(jobId);
      queuedAt.delete(jobId);
    }),

    /** A settle was queued for a wake — the clock for settle→inject latency. */
    wakeQueued: guard((jobId) => {
      if (typeof jobId !== "string" || jobId.length === 0) return;
      if (!queuedAt.has(jobId)) queuedAt.set(jobId, now());
    }),

    /**
     * A wake turn was injected carrying these items. One call per wake TURN —
     * the batch size is the coalescing evidence.
     *
     * @param {Array<string | { jobId: string, kind?: string, status?: string }>} items
     *        bare ids are accepted; `{ kind, status }` additionally splits out
     *        the paused-run latency (see `awaitingRunLatency`).
     */
    wakeInjected: guard((items = []) => {
      const list = (Array.isArray(items) ? items : [])
        .map((item) => (typeof item === "string" ? { jobId: item } : item))
        .filter((item) => typeof item?.jobId === "string" && item.jobId.length > 0);
      if (list.length === 0) return;
      wake.turns += 1;
      wake.items += list.length;
      bump(wake.batchHistogram, bucket(list.length));
      const at = now();
      for (const item of list) {
        const queued = queuedAt.get(item.jobId);
        queuedAt.delete(item.jobId);
        if (!Number.isFinite(queued)) continue;
        const latency = Math.max(0, at - queued);
        wake.latency.count += 1;
        wake.latency.totalMs += latency;
        if (latency > wake.latency.maxMs) wake.latency.maxMs = latency;
        if (item.kind !== "run" || !String(item.status ?? "").startsWith("awaiting")) continue;
        wake.awaitingRunLatency.count += 1;
        wake.awaitingRunLatency.totalMs += latency;
        if (latency > wake.awaitingRunLatency.maxMs) wake.awaitingRunLatency.maxMs = latency;
      }
      dirty = true;
    }),

    /** An injection attempt threw (the supervisor retries; this counts the attempts). */
    wakeInjectFailed: guard(() => {
      wake.injectFailures += 1;
      dirty = true;
    }),

    /**
     * The cumulative snapshot, as it is emitted. Plain JSON, snake_case (the
     * `__procway_crash__` line's convention), counts and milliseconds only.
     */
    snapshot: guard(() => ({
      [METRICS_MARKER]: true,
      app: "ai-agent",
      metric: "delegation",
      session_id: sessionId ?? null,
      ts: new Date(now()).toISOString(),
      uptime_ms: Math.max(0, now() - startedAt),
      usage: {
        spawn_agent: { ...usage.spawn_agent },
        start_run: { ...usage.start_run }
      },
      concurrency: {
        // Simultaneously UNCOLLECTED background jobs.
        peak: concurrency.peak,
        peak_by_surface: { ...concurrency.peakBySurface },
        histogram: { ...concurrency.histogram },
        outstanding_now: outstanding.size
      },
      join_blocked_ms: Object.fromEntries(JOIN_SURFACES.map((surface) => [
        surface,
        { count: join[surface].count, total_ms: join[surface].totalMs, max_ms: join[surface].maxMs }
      ])),
      // The subset a default flip could actually win back (see the ADR).
      recoverable_join_ms: RECOVERABLE_JOIN_SURFACES.reduce((sum, surface) => sum + join[surface].totalMs, 0),
      wake: {
        turns: wake.turns,
        items: wake.items,
        // 1.0 ⇒ nothing ever coalesced.
        coalesce_ratio: wake.turns > 0 ? Number((wake.items / wake.turns).toFixed(2)) : 0,
        batch_histogram: { ...wake.batchHistogram },
        latency_ms: { count: wake.latency.count, total_ms: wake.latency.totalMs, max_ms: wake.latency.maxMs },
        // Runs that settled PAUSED for an answer — the delay a user feels.
        awaiting_run_latency_ms: {
          count: wake.awaitingRunLatency.count,
          total_ms: wake.awaitingRunLatency.totalMs,
          max_ms: wake.awaitingRunLatency.maxMs
        },
        inject_failures: wake.injectFailures
      },
      hazard: {
        // Children only, and counts only — no directory ever leaves the process.
        same_cwd_peak: hazard.sameCwdPeak,
        same_cwd_overlaps: hazard.sameCwdOverlaps,
        same_cwd_background_overlaps: hazard.sameCwdBackgroundOverlaps,
        distinct_cwds: hazard.distinctCwds,
        ...(hazard.cwdTableTruncated ? { truncated: true } : {})
      }
    })),

    /**
     * Emit the snapshot — but only when something changed since the last one, so
     * a session that never delegates prints nothing at all and a quiet session
     * does not repeat itself once per turn.
     *
     * @returns {boolean} whether a line was written
     */
    flush: guard(() => {
      if (!dirty) return false;
      const line = `${JSON.stringify(metrics.snapshot())}\n`;
      dirty = false;
      lastLine = line;
      write(line);
      return true;
    }),

    /** @internal test seam — the last line written, or null. */
    __lastLine() {
      return lastLine;
    }
  };

  return metrics;
}

/**
 * The directory two children would collide in, as an absolute path. Used ONLY
 * as a Map key inside this process — see the header: comparing directories is
 * the measurement, revealing them is not.
 */
function resolveCwdKey(cwd, baseCwd) {
  const child = typeof cwd === "string" && cwd.trim() ? cwd.trim() : ".";
  const base = typeof baseCwd === "string" && baseCwd.trim() ? baseCwd.trim() : null;
  try {
    return base ? path.resolve(base, child) : path.resolve(child);
  } catch {
    return null;
  }
}

export { METRICS_MARKER };
