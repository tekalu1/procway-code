/**
 * @typedef {{ inputTokens: number, outputTokens: number, costUsd: number }} UsageSummary
 */

/**
 * Sum `usage.recorded` events into a single rolling totals object.
 * Returns all-zero totals when no events are supplied.
 *
 * @param {Iterable<import("../events/types.mjs").AgentEvent>} events
 * @returns {UsageSummary}
 */
export function usageFromEvents(events) {
  const summary = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  if (!events) return summary;
  for (const event of events) {
    if (!event || event.type !== "usage.recorded") continue;
    summary.inputTokens += toFiniteNumber(event.inputTokens);
    summary.outputTokens += toFiniteNumber(event.outputTokens);
    summary.costUsd += toFiniteNumber(event.costUsd);
  }
  return summary;
}

function toFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
