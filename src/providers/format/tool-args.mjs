// A tool call whose argument JSON could not be parsed — malformed, or (the
// common case) truncated mid-stream when the model hit max_tokens before
// closing the JSON. Providers used to swallow the parse error and dispatch
// with `{}`, which crashed schema-required tools deep in their handlers
// (write_file → path.isAbsolute(undefined)) and gave the model no way to tell
// what went wrong. Instead they now stamp the args with this marker; the tool
// execution layer (registry.executeToolCall) detects it and returns a clear
// ok:false result telling the model to retry with complete arguments.
const INVALID_TOOL_ARGS_KEY = "__procwayInvalidToolArgs";

/**
 * Build an args object marking that the model's tool-call arguments could not
 * be parsed. `truncated` is set when the surrounding stop/finish reason says
 * the response was cut off (max_tokens / length), so the retry message can name
 * the likely cause.
 *
 * @param {{ reason?: string, truncated?: boolean }} [opts]
 * @returns {{ [INVALID_TOOL_ARGS_KEY]: { reason: string, truncated: boolean } }}
 */
export function makeInvalidToolArgs({ reason = "parse_error", truncated = false } = {}) {
  return { [INVALID_TOOL_ARGS_KEY]: { reason, truncated: truncated === true } };
}

/**
 * Return the invalid-args marker payload if `args` carries one, else null.
 *
 * @param {unknown} args
 * @returns {{ reason: string, truncated: boolean } | null}
 */
export function getInvalidToolArgs(args) {
  if (!args || typeof args !== "object") return null;
  const marker = args[INVALID_TOOL_ARGS_KEY];
  if (!marker || typeof marker !== "object") return null;
  return { reason: typeof marker.reason === "string" ? marker.reason : "parse_error", truncated: marker.truncated === true };
}

/**
 * Drop the invalid-args marker for record/egress copies. The marker is an
 * execution-layer signal ONLY — it must never reach persisted history, the
 * provider re-send (tool_use.input / tool_calls.arguments), or UI events. A
 * marked call is recorded as `{}` (an empty, API-valid object) alongside its
 * paired ok:false tool_result, which is what the model sees on the next round.
 * Non-marked args pass through unchanged (same reference).
 *
 * @param {unknown} args
 */
export function stripInvalidToolArgs(args) {
  return getInvalidToolArgs(args) ? {} : args;
}

/**
 * Parse a tool-call argument JSON string, returning the parsed object on
 * success or an invalid-args marker on failure. An empty string is treated as
 * "no arguments" (`{}`), matching a tool called with no inputs.
 *
 * @param {unknown} raw
 * @param {{ truncated?: boolean }} [opts]
 */
export function parseToolArgs(raw, { truncated = false } = {}) {
  if (typeof raw !== "string") return raw ?? {};
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return makeInvalidToolArgs({ reason: "parse_error", truncated });
  }
}
