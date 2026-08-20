/**
 * event-wake (issue #143) — the `-p` (one-shot) surface's wake path.
 *
 * The REPL and a serve-hosted session are long-lived: a wake turn injected a
 * minute after the user's turn ended still has somewhere to land. `-p` has not:
 * `runAgent` runs ONE turn and returns, the caller reaps the background shells,
 * and the process exits as soon as the event loop empties. Anything started
 * with `spawn_agent(runInBackground:true)` — or a run started in the background
 * — is therefore killed mid-flight, and its result is delivered to nobody.
 *
 * So `-p` gets a different terminating condition: instead of "the first turn
 * returned", it is **"the session has no uncollected background work left"**,
 * i.e. `supervisor.hasOutstanding() === false`. While work is outstanding this
 * function simply waits; the supervisor does the rest (it injects a wake turn
 * as each batch settles, through the injector installed here).
 *
 * Two bounds keep that from becoming a hang:
 *   - `maxTurns`  — how many wake turns one invocation may run (a model that
 *     re-spawns work every wake would otherwise never finish);
 *   - `timeoutMs` — a wall-clock deadline. Needed because some outstanding work
 *     can NEVER settle here: a background `start_run` lives in the host's
 *     registry and its settle arrives over the serve bridge's `wake` command,
 *     which a `-p` process does not have.
 *
 * Hitting either bound is not a failure: we say so on stderr and leave the exit
 * code alone. The work is still collectable from a later session (`agent_job`
 * action:"status" / `attach_run`).
 */

/** Wake turns one `-p` invocation may run before giving up. */
export const DEFAULT_WAKE_DRAIN_MAX_TURNS = 20;
/** Wall-clock budget for the whole drain. */
export const DEFAULT_WAKE_DRAIN_TIMEOUT_MS = 300_000;
/** How often `hasOutstanding()` is re-checked while waiting. */
export const DEFAULT_WAKE_DRAIN_POLL_MS = 100;

function readInt(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

/**
 * Read the drain's bounds from the environment. Naming follows the existing
 * `PROCWAY_*_MS` timeouts (see docs/host-contract.md §1 "Timeouts").
 *
 * - `PROCWAY_WAKE_DRAIN_TIMEOUT_MS` (default 300000) — `0` disables the drain
 *   entirely, restoring the pre-#143 "exit the moment the turn returns".
 * - `PROCWAY_WAKE_DRAIN_MAX_TURNS` (default 20) — `0` also disables it.
 */
export function resolveWakeDrainLimits(env = process.env) {
  return {
    maxTurns: readInt(env?.PROCWAY_WAKE_DRAIN_MAX_TURNS, DEFAULT_WAKE_DRAIN_MAX_TURNS),
    timeoutMs: readInt(env?.PROCWAY_WAKE_DRAIN_TIMEOUT_MS, DEFAULT_WAKE_DRAIN_TIMEOUT_MS)
  };
}

/**
 * The default wait between polls. `unref()`d on purpose: the drain must never
 * be the last thing holding the process open. When real background work is in
 * flight (a child agent process, an HTTP turn) that work already pins the loop
 * and the timer fires normally; when NOTHING is left pinning it, there is also
 * nothing left that could ever settle in this process, so exiting right then is
 * the correct outcome rather than a lost deadline.
 */
function defaultSleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer?.unref?.();
  });
}

/**
 * Wait until the session's background work is collected, injecting wake turns
 * through `injectTurn` as the supervisor produces them.
 *
 * @param {object} input
 * @param {object|null} input.supervisor        the session's wake supervisor
 * @param {(text: string) => Promise<unknown>} input.injectTurn  how a wake turn runs
 * @param {number} [input.maxTurns]
 * @param {number} [input.timeoutMs]
 * @param {number} [input.pollMs]
 * @param {() => number} [input.now]
 * @param {(ms: number) => Promise<void>} [input.sleep]
 * @param {(info: {reason: string, turns: number}) => void} [input.onAbandon]
 * @returns {Promise<{ turns: number, reason: "settled"|"turn-limit"|"deadline"|"disabled"|"no-supervisor" }>}
 */
export async function drainWakeWork({
  supervisor,
  injectTurn,
  maxTurns = DEFAULT_WAKE_DRAIN_MAX_TURNS,
  timeoutMs = DEFAULT_WAKE_DRAIN_TIMEOUT_MS,
  pollMs = DEFAULT_WAKE_DRAIN_POLL_MS,
  now = () => Date.now(),
  sleep = defaultSleep,
  onAbandon = null
} = {}) {
  if (!supervisor || typeof supervisor.hasOutstanding !== "function") {
    return { turns: 0, reason: "no-supervisor" };
  }
  if (!(timeoutMs > 0) || !(maxTurns > 0)) return { turns: 0, reason: "disabled" };

  let turns = 0;
  // Injections in flight. `hasOutstanding()` goes false the moment the batch
  // leaves the queue — i.e. WHILE its wake turn is still running — so polling
  // that alone would return early and let the caller reap the shells out from
  // under a live turn.
  let inFlight = 0;
  if (typeof injectTurn === "function" && typeof supervisor.setInjector === "function") {
    supervisor.setInjector(async (text) => {
      turns += 1;
      inFlight += 1;
      try {
        await injectTurn(text);
      } finally {
        inFlight -= 1;
      }
    });
  }

  const deadline = now() + timeoutMs;
  let reason = "settled";
  for (;;) {
    if (inFlight === 0 && !supervisor.hasOutstanding()) break;
    if (inFlight === 0 && turns >= maxTurns) { reason = "turn-limit"; break; }
    const remaining = deadline - now();
    if (remaining <= 0) { reason = "deadline"; break; }
    await sleep(Math.max(1, Math.min(pollMs, remaining)));
  }

  if (reason !== "settled" && typeof onAbandon === "function") {
    try { onAbandon({ reason, turns }); } catch { /* reporting must not throw */ }
  }
  return { turns, reason };
}

/** The stderr line printed when the drain gives up with work still out. */
export function formatWakeDrainAbandonNotice({ reason, turns }) {
  const why = reason === "deadline"
    ? "the drain deadline elapsed (PROCWAY_WAKE_DRAIN_TIMEOUT_MS)"
    : "the wake-turn limit was reached (PROCWAY_WAKE_DRAIN_MAX_TURNS)";
  return `[wake] exiting with background work still outstanding — ${why} after ${turns} wake turn(s). `
    + "Collect it from a later session with `agent_job` action:\"status\" or `attach_run`.\n";
}
