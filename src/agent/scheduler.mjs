// Per-tool wall-clock ceiling. A single hung tool used to block the entire
// turn because Promise.all() in runLimited never resolved — that's how the
// TK-15 hang lost all three tool outputs of the round even though two of
// them had completed. With a per-call timeout the slow tool fails fast and
// the fast tools still get their results recorded.
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

export async function runToolCalls(toolCalls, { maxParallel = 8, timeoutMs = DEFAULT_TOOL_TIMEOUT_MS } = {}) {
  const readOnly = toolCalls.filter((call) => call.mutation !== true);
  const mutations = toolCalls.filter((call) => call.mutation === true);
  const readOnlyResults = await runLimited(readOnly, maxParallel, timeoutMs);
  const mutationResults = [];
  for (const call of mutations) {
    mutationResults.push(await runOne(call, timeoutMs));
  }
  return [...readOnlyResults, ...mutationResults].sort((a, b) => a.index - b.index);
}

async function runLimited(calls, maxParallel, timeoutMs) {
  const results = [];
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(maxParallel, calls.length) }, async () => {
    while (nextIndex < calls.length) {
      const current = calls[nextIndex];
      nextIndex += 1;
      results.push(await runOne(current, timeoutMs));
    }
  });
  await Promise.all(workers);
  return results;
}

async function runOne(call, timeoutMs) {
  // Per-call budget override: long-running tools (foreground run_shell,
  // shell_job wait) declare their own timeout via call.timeoutMs — the
  // shared default (60s) would otherwise kill them mid-flight even though
  // the tool itself was given a longer deadline by the model.
  if (Number.isFinite(call.timeoutMs) && call.timeoutMs > 0) {
    timeoutMs = call.timeoutMs;
  }
  let timer;
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
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
