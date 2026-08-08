import { randomUUID } from "node:crypto";
import { createEvent } from "../core/events/types.mjs";

/**
 * Coordinator for User Interaction Requests (UIR). Unlike ApprovalCoordinator
 * this is NOT an approval gate — it carries a generic round-trip: the worker
 * asks the user for structured input (a form/choice/confirm) by calling the
 * `request_user_action` tool and the coordinator emits `interaction.requested`
 * on the EventBus for the surfaces (chat / Slack / Discord) to render.
 *
 * ADR 0037 D1 (waits are data): a UIR is a TERMINAL turn action, never an
 * in-process wait. There is no pending Promise map and no fallback timeout —
 * the request is recorded durably by the host (pending_interactions row via
 * the dashboard's event taps), the turn winds down (see conversation.mjs
 * `requestUserInteraction` → `pausedForInput`), and the user's answer arrives
 * later as a resume: a NEW turn carrying the answer (chat/Slack/Discord) or
 * `run loop resume` (run-loop workers). Because nothing waits in memory,
 * a Pod restart / deploy between the ask and the answer loses nothing.
 *
 * `resolveInteraction` is therefore a pure broadcast: it re-emits
 * `interaction.resolved` so every attached surface (other browser tabs, the
 * dashboard's DB tap, Slack mirrors) can clear its widget/row — it does not
 * (and cannot) wake a waiting turn.
 *
 * No permissions / alwaysAllow: a UIR is information/input, not a guard, so it
 * never consults approvalMode or permission rules.
 */
export class InteractionCoordinator {
  constructor({ events } = {}) {
    if (!events || typeof events.emit !== "function") {
      throw new TypeError("InteractionCoordinator: events bus is required");
    }
    this.events = events;
  }

  /**
   * Record a structured-action request and return immediately (terminal
   * semantics — ADR 0037 D1). Resolves to `{ requestId, blocking: false }`;
   * the caller (session requester) decides whether the turn winds down
   * (deferred hand-off) or continues (fire-and-forget nudge).
   *
   * @param {{ kind: string, summary?: string, spec?: object, blocking?: boolean, sessionId?: string }} args
   * @returns {Promise<{ requestId: string, blocking: false }>}
   */
  async request({ kind, summary = "", spec, blocking, sessionId } = {}) {
    void blocking; // terminal model: nothing ever blocks in-process
    const requestId = randomUUID();
    this.events.emit(createEvent("interaction.requested", {
      sessionId,
      requestId,
      kind,
      summary,
      spec,
      blocking: false
    }));
    return { requestId, blocking: false };
  }

  /**
   * Broadcast a resolution for a previously requested interaction. Surfaces /
   * the host call this so every attached listener (other tabs, DB taps,
   * mirrors) observes `interaction.resolved` and clears its pending widget or
   * row. Always returns true — there is no in-memory pending entry to miss
   * (the durable row's own CAS is the authoritative double-resolve guard).
   *
   * @param {string} requestId
   * @param {object} response
   * @param {{ sessionId?: string }} [meta]
   */
  resolveInteraction(requestId, response, { sessionId } = {}) {
    if (typeof requestId !== "string" || requestId.length === 0) return false;
    this.events.emit(createEvent("interaction.resolved", { sessionId, requestId, response }));
    return true;
  }
}
