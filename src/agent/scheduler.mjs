import { USER_INTERRUPT_MESSAGE } from "./abort.mjs";

// Per-tool wall-clock ceiling. A single hung tool used to block the entire
// turn because Promise.all() in runLimited never resolved — that's how the
// TK-15 hang lost all three tool outputs of the round even though two of
// them had completed. With a per-call timeout the slow tool fails fast and
// the fast tools still get their results recorded.
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

/**
 * `signal` (optional) is the turn's AbortSignal. On abort:
 *   - calls that have NOT started are never started (settled as interrupted);
 *   - calls already in flight settle as interrupted immediately — the tool
 *     itself received the same signal and winds its own work down (run_shell
 *     kills its process group), so we don't wait for it here.
 * Every call still yields a result, which keeps the tool_use/tool_result
 * pairing in session.messages valid for the next provider request.
 */
export async function runToolCalls(toolCalls, { maxParallel = 8, timeoutMs = DEFAULT_TOOL_TIMEOUT_MS, signal = null } = {}) {
  const readOnly = toolCalls.filter((call) => call.mutation !== true);
  const mutations = toolCalls.filter((call) => call.mutation === true);
  const readOnlyResults = await runLimited(readOnly, maxParallel, timeoutMs, signal);
  const mutationResults = [];
  for (const call of mutations) {
    mutationResults.push(await runOne(call, timeoutMs, signal));
  }
  return [...readOnlyResults, ...mutationResults].sort((a, b) => a.index - b.index);
}

async function runLimited(calls, maxParallel, timeoutMs, signal) {
  const results = [];
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(maxParallel, calls.length) }, async () => {
    while (nextIndex < calls.length) {
      const current = calls[nextIndex];
      nextIndex += 1;
      results.push(await runOne(current, timeoutMs, signal));
    }
  });
  await Promise.all(workers);
  return results;
}

function interruptedResult(call) {
  return { ...call, ok: false, error: USER_INTERRUPT_MESSAGE, interrupted: true };
}

async function runOne(call, timeoutMs, signal = null) {
  // Per-call budget override: long-running tools (foreground run_shell,
  // shell_job wait) declare their own timeout via call.timeoutMs — the
  // shared default (60s) would otherwise kill them mid-flight even though
  // the tool itself was given a longer deadline.
  if (Number.isFinite(call.timeoutMs) && call.timeoutMs > 0) {
    timeoutMs = call.timeoutMs;
  }
  // Already aborted → never start this tool at all.
  if (signal?.aborted) return interruptedResult(call);
  let timer;
  let onAbort = null;
  const work = (async () => {
    try {
      return { ...call, ok: true, result: await call.run() };
    } catch (error) {
      return { ...call, ok: false, error: error.message };
    }
  })();
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      resolve({
        ...call,
        ok: false,
        error: `Tool timed out after ${timeoutMs}ms`,
        timedOut: true
      });
    }, timeoutMs);
  });
  const races = [work, timeout];
  if (signal) {
    races.push(new Promise((resolve) => {
      onAbort = () => resolve(interruptedResult(call));
      signal.addEventListener?.("abort", onAbort, { once: true });
    }));
  }
  try {
    return await Promise.race(races);
  } finally {
    clearTimeout(timer);
    if (onAbort) {
      try { signal.removeEventListener?.("abort", onAbort); } catch { /* ignore */ }
    }
  }
}
