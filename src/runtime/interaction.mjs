import { randomUUID } from "node:crypto";
import { createEvent } from "../core/events/types.mjs";

/**
 * Coordinator for User Interaction Requests (UIR). Unlike ApprovalCoordinator
 * this is NOT an approval gate — it carries a generic, blocking round-trip:
 * the worker asks the user for structured input (a form/choice/confirm) by
 * calling the `request_user_action` tool, the coordinator emits
 * `interaction.requested` on the EventBus, and a surface (chat / Slack) calls
 * `resolveInteraction(requestId, response)` to hand back arbitrary JSON.
 *
 * No permissions / alwaysAllow: a UIR is information/input, not a guard, so it
 * never consults approvalMode or permission rules.
 *
 * Idle-watchdog interaction (decision: pause-while-pending + fallback timeout):
 * a blocking request emits one event then goes silent until the human responds,
 * which the turn idle watchdog would otherwise treat as a stall. The watchdog
 * is paused while `hasPending()` is true (see conversation.mjs), and a long
 * fallback timeout resolves the promise with `{ timedOut: true }` so the turn
 * stays retryable instead of hanging forever.
 */
export class InteractionCoordinator {
  constructor({ events, timeoutMs } = {}) {
    if (!events || typeof events.emit !== "function") {
      throw new TypeError("InteractionCoordinator: events bus is required");
    }
    this.events = events;
    /** @type {Map<string, { resolve: (response: object) => void, timer: NodeJS.Timeout | null }>} */
    this.pending = new Map();
    const raw = timeoutMs ?? Number(process.env.PROCWAY_UIR_TIMEOUT_MS);
    // Default 15 min: long enough for a human to fill a form, short enough to
    // not pin a turn forever if the surface vanishes. 0 disables the fallback.
    this.timeoutMs = Number.isFinite(raw) && raw >= 0 ? raw : 900_000;
  }

  /**
   * Request a structured action from the user.
   * - blocking (default): resolves to the user's `response` (arbitrary JSON),
   *   or `{ timedOut: true }` if the fallback timeout fires first.
   * - non-blocking: emits the request and resolves immediately to
   *   `{ requestId, blocking: false }` (fire-and-forget nudge).
   *
   * @param {{ kind: string, summary?: string, spec?: object, blocking?: boolean, sessionId?: string }} args
   * @returns {Promise<object>}
   */
  async request({ kind, summary = "", spec, blocking = true, sessionId } = {}) {
    const requestId = randomUUID();
    if (!blocking) {
      this.events.emit(createEvent("interaction.requested", { sessionId, requestId, kind, summary, spec }));
      return { requestId, blocking: false };
    }
    return new Promise((resolve) => {
      let timer = null;
      if (this.timeoutMs > 0) {
        timer = setTimeout(() => {
          // Fallback: surface never answered. Resolve so the turn continues.
          if (this.pending.delete(requestId)) {
            this.events.emit(createEvent("interaction.resolved", { sessionId, requestId, response: { timedOut: true } }));
            resolve({ timedOut: true });
          }
        }, this.timeoutMs);
        if (typeof timer.unref === "function") timer.unref();
      }
      this.pending.set(requestId, { resolve, timer });
      this.events.emit(createEvent("interaction.requested", { sessionId, requestId, kind, summary, spec }));
    });
  }

  /**
   * Resolve a pending interaction with the user's response (arbitrary JSON).
   * Surfaces call this in response to `interaction.requested`. Re-emits
   * `interaction.resolved` and clears the pending entry. Returns false for an
   * unknown / already-resolved requestId.
   *
   * @param {string} requestId
   * @param {object} response
   * @param {{ sessionId?: string }} [meta]
   */
  resolveInteraction(requestId, response, { sessionId } = {}) {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    if (entry.timer) clearTimeout(entry.timer);
    this.events.emit(createEvent("interaction.resolved", { sessionId, requestId, response }));
    entry.resolve(response);
    return true;
  }

  /** Returns true if a request with the given id is awaiting resolution. */
  has(requestId) {
    return this.pending.has(requestId);
  }

  /** Returns true if ANY request is awaiting a human response (watchdog pause). */
  hasPending() {
    return this.pending.size > 0;
  }
}
