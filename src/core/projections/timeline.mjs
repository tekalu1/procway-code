/**
 * @typedef {{
 *   activityId: string,
 *   label: string,
 *   detail?: string,
 *   startedAt: string,
 *   stoppedAt?: string,
 *   outcome?: string
 * }} TimelineEntry
 */

/**
 * Project an event stream into timeline entries by pairing
 * `activity.started` and `activity.stopped` on `activityId`.
 *
 * Entries appear in the order their `activity.started` events were emitted.
 * Unmatched starts are kept open (no `stoppedAt`); orphan stops are ignored.
 *
 * @param {Iterable<import("../events/types.mjs").AgentEvent>} events
 * @returns {TimelineEntry[]}
 */
export function timelineFromEvents(events) {
  if (!events) return [];
  const order = [];
  const byId = new Map();
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    if (event.type === "activity.started") {
      const entry = {
        activityId: event.activityId,
        label: event.label,
        startedAt: event.time
      };
      if (event.detail) entry.detail = event.detail;
      byId.set(event.activityId, entry);
      order.push(event.activityId);
    } else if (event.type === "activity.stopped") {
      const entry = byId.get(event.activityId);
      if (entry) {
        entry.stoppedAt = event.time;
        if (event.outcome != null) entry.outcome = event.outcome;
      }
    }
  }
  return order.map((id) => byId.get(id)).filter(Boolean);
}
