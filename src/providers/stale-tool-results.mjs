/**
 * Stale tool-result condensation — token reduction (2026-06-07 audit ②Step2).
 *
 * Without this, every tool result (a read_file can be 64KB, shell output
 * ~400KB) is re-serialized IN FULL into every subsequent provider request for
 * the life of the session (format/openai.mjs / format/anthropic.mjs both
 * JSON.stringify the whole `result`), and autoCompact is off by default — so
 * one big read early in a task is re-billed on every later round.
 *
 * This module condenses OLD tool results at EGRESS time only:
 *   - the last `keepRecent` tool messages are always passed through intact
 *     (the model's working set for the current round is never touched);
 *   - older results whose serialized `data` exceeds `maxChars` are replaced
 *     by a head+tail window plus an explicit re-derivation note.
 *
 * Invariants:
 *   - PURE / egress-only: returns shallow copies; `session.messages`, the
 *     snapshot, events.jsonl and transcript.md keep the full payload.
 *   - Deterministic: a given message condenses to the same bytes every time,
 *     and once a message is older than the keepRecent boundary it stays
 *     condensed — so the long history prefix remains byte-stable across
 *     rounds (provider prompt caches keep hitting it).
 *   - Errors are never condensed (`ok: false` results stay intact): failure
 *     details are exactly what the model may need much later.
 */

const DEFAULTS = Object.freeze({
  enabled: true,
  // Tool messages (not rounds): parallel tool calls produce one tool message
  // each, so 10 covers roughly the last 2-4 rounds of activity.
  keepRecent: 10,
  // Serialized-data threshold; results at or below pass through untouched.
  maxChars: 6000,
  headChars: 2000,
  tailChars: 500
});

export function resolveStaleToolResultSettings(settings) {
  const raw = settings?.tools?.staleToolResults;
  if (raw === false) return { ...DEFAULTS, enabled: false };
  return { ...DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
}

/**
 * @param {Array<object>} messages session history (provider-agnostic shape)
 * @returns {Array<object>} same array when nothing changes, otherwise a new
 *   array with condensed shallow copies (originals untouched)
 */
export function condenseStaleToolResults(messages, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  if (!opts.enabled || !Array.isArray(messages) || messages.length === 0) return messages ?? [];

  const toolIndices = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]?.role === "tool") toolIndices.push(i);
  }
  const staleCount = toolIndices.length - opts.keepRecent;
  if (staleCount <= 0) return messages;

  let result = messages;
  for (let n = 0; n < staleCount; n += 1) {
    const index = toolIndices[n];
    const condensed = condenseToolMessage(messages[index], opts);
    if (condensed === messages[index]) continue;
    if (result === messages) result = messages.slice();
    result[index] = condensed;
  }
  return result;
}

function condenseToolMessage(message, opts) {
  if (!Array.isArray(message?.content)) return message;
  let changed = false;
  const content = message.content.map((block) => {
    if (block?.kind !== "tool_result" || block.ok === false) return block;
    const condensedResult = condenseToolResult(block.result, opts);
    if (condensedResult === block.result) return block;
    changed = true;
    return { ...block, result: condensedResult };
  });
  return changed ? { ...message, content } : message;
}

function condenseToolResult(result, opts) {
  if (!result || typeof result !== "object") return result;
  if (result.data?.condensed === true) return result;
  let serialized;
  try {
    serialized = JSON.stringify(result.data ?? null);
  } catch {
    return result;
  }
  if (typeof serialized !== "string" || serialized.length <= opts.maxChars) return result;
  return {
    ...result,
    data: {
      condensed: true,
      originalChars: serialized.length,
      note: "Stale tool result condensed to save context. Head/tail of the serialized payload preserved below; re-run the tool (e.g. read_file with offset, or the same shell command) if you need the full content again.",
      head: serialized.slice(0, opts.headChars),
      tail: serialized.slice(-opts.tailChars)
    }
  };
}
