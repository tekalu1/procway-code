/**
 * llm-fetch — a `fetch` for long-lived LLM streaming requests, tuned to avoid
 * the recurring ~300s "model waiting" stalls (image-unrelated; seen across
 * many sessions, see scan in TK notes).
 *
 * Mechanism the tuning targets (leading hypothesis, to be confirmed by the
 * retry diagnostics in the provider):
 *   - An SSE response sends its HTTP 200 headers within ~1s, then streams
 *     events. The stalls show NO output and NO reasoning for ~300s, then a
 *     sudden success — i.e. the first attempt produced no headers at all (the
 *     request never reached the model). That is the signature of a hung /
 *     server-half-closed pooled keep-alive socket being reused, or upstream
 *     queueing. undici's DEFAULT `headersTimeout`/`bodyTimeout` of 300_000ms
 *     then aborts it and our retry re-issues — hence the ~300s (≈300×N) stalls.
 *
 * So this is NOT "disable the timeout" (that would make a hung connection wait
 * forever). Instead:
 *   - keepAliveTimeout low + pipelining off  → don't reuse a possibly-stale
 *     socket on the next turn (the likely root cause).
 *   - headersTimeout finite but well above a healthy SSE's <1s header latency
 *     → a hung connection is detected and retried in seconds, not 5 minutes.
 *   - bodyTimeout finite but GENEROUS (2 min, tunable). undici resets it on
 *     every body chunk, and live streams emit reasoning tokens / SSE keep-alive
 *     comments continuously, so a legitimately-working model never trips it —
 *     only a stream that goes TRULY silent does. (It was previously 0/disabled,
 *     which waited on a stalled upstream forever → the chat hung at "model
 *     waiting" with no recovery. Finite turns that into a retryable
 *     UND_ERR_BODY_TIMEOUT the turn loop surfaces as turn.failed.)
 *
 * No fallback by design: if the `undici` package can't be resolved this module
 * throws at import time. We fail loudly (undici must be an installed
 * dependency; rebuild the runtime image) rather than silently revert to the
 * 300s-default global fetch.
 */
import { Agent, fetch as undiciFetch } from "undici";

/** Header wait cap. Healthy SSE headers arrive in ~1s; this only trips on a
 * hung/unresponsive connection, which then retries. Tunable via env. */
const HEADERS_TIMEOUT_MS = toPositiveInt(process.env.PROCWAY_LLM_HEADERS_TIMEOUT_MS, 60_000);

/** Inter-chunk idle cap for the streaming response body. undici RESETS this on
 * every body chunk — including SSE keep-alive comments (OpenRouter emits
 * ": OPENROUTER PROCESSING" while an upstream is busy) — so a model that is
 * genuinely working never trips it; only a stream that goes TRULY silent does.
 * The old value 0 (disabled) waited on a stalled upstream FOREVER, surfacing as
 * the chat hanging at "model waiting" with no recovery. A finite cap turns that
 * into UND_ERR_BODY_TIMEOUT, which fetchStreamingWithRetry retries and the turn
 * loop ultimately surfaces as turn.failed (retryable) instead of an infinite
 * hang. Generous (2 min of TOTAL silence) so a slow-but-alive stream is never
 * killed. Tunable via PROCWAY_LLM_BODY_TIMEOUT_MS. */
const BODY_TIMEOUT_MS = toPositiveInt(process.env.PROCWAY_LLM_BODY_TIMEOUT_MS, 120_000);

let dispatcher = null;

function getDispatcher() {
  if (!dispatcher) {
    dispatcher = new Agent({
      headersTimeout: HEADERS_TIMEOUT_MS,
      bodyTimeout: BODY_TIMEOUT_MS,
      // Close idle pooled sockets fast so the next turn dials a fresh
      // connection instead of risking a server-half-closed one.
      keepAliveTimeout: 1_000,
      pipelining: 0
    });
  }
  return dispatcher;
}

function toPositiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Drop-in `fetch` for provider HTTP calls. Identical signature to global
 * fetch; injects the tuned dispatcher.
 *
 * @type {typeof globalThis.fetch}
 */
export function llmFetch(url, options = {}) {
  return undiciFetch(url, { ...options, dispatcher: getDispatcher() });
}
