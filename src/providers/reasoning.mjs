/**
 * Provider-agnostic reasoning-effort configuration.
 *
 * Every provider config may carry a single `reasoningEffort` knob
 * (`"minimal" | "low" | "medium" | "high"`). Each provider maps it to the
 * shape its upstream API expects:
 *   - openai-codex      → `reasoning: { effort }`            (Responses API)
 *   - openai-compatible → `reasoning_effort: <effort>`       (Chat Completions)
 *   - anthropic         → `thinking: { budget_tokens }`      (no effort levels;
 *                          mapped to an extended-thinking token budget)
 *
 * Keeping the user-facing knob uniform means the dashboard can offer one
 * dropdown regardless of which provider is active, while the per-provider
 * translation stays here.
 */

export const REASONING_EFFORTS = Object.freeze(["minimal", "low", "medium", "high"]);

/**
 * Validate and normalize a configured effort value. Returns the lowercased
 * effort string when valid, or `null` when unset/invalid (callers then omit
 * the parameter entirely, preserving each upstream's own default).
 *
 * @param {unknown} value
 * @returns {"minimal"|"low"|"medium"|"high"|null}
 */
export function normalizeReasoningEffort(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return REASONING_EFFORTS.includes(v) ? /** @type {any} */ (v) : null;
}

// Anthropic exposes extended thinking as a token budget rather than discrete
// effort levels. Map our common knob onto sensible budgets. Numbers chosen to
// stay well under typical max_tokens while scaling with effort.
const ANTHROPIC_BUDGET_BY_EFFORT = Object.freeze({
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384
});

/**
 * Map a reasoning effort to an Anthropic extended-thinking `budget_tokens`.
 * Returns `null` when effort is unset/invalid so the caller leaves thinking
 * disabled.
 *
 * @param {unknown} effort
 * @returns {number|null}
 */
export function reasoningEffortToAnthropicBudget(effort) {
  const normalized = normalizeReasoningEffort(effort);
  return normalized ? ANTHROPIC_BUDGET_BY_EFFORT[normalized] : null;
}
