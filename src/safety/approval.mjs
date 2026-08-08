import { randomUUID } from "node:crypto";
import { createEvent } from "../core/events/types.mjs";
import { evaluatePermissions } from "./permissions.mjs";

/**
 * Approval modes:
 * - auto-readonly: read-only tools run automatically; mutation/dangerous tools ask.
 * - always-ask:   every tool call asks (permissions allow rules are ignored).
 * - full-auto:    every tool call runs without asking.
 *
 * deny rules always win, regardless of mode: a `permissions.deny` match is
 * evaluated FIRST and returns "deny" even under full-auto / always-ask. This
 * mirrors permissions.mjs ("A deny match always wins") so a full-auto worker
 * still can't run e.g. `run_shell:rm -rf *` if a deny rule forbids it.
 */

/**
 * ADR 0037 D1 — the park signal a mid-turn "ask" verdict raises instead of
 * blocking. The session's parking approval requester registers a parked entry
 * (persisted in the session snapshot) and throws this; executeSingleToolCall
 * catches it and returns a placeholder ToolResult, runTurn winds the turn
 * down, and `resolveParkedApproval` later re-drives the tool + the remaining
 * rounds from the checkpoint. Deliberately an Error subclass so an unexpected
 * escape still fails loudly with the requestId in the message.
 */
export class ApprovalParkSignal extends Error {
  constructor(requestId, { kind, summary } = {}) {
    super(`approval parked (requestId=${requestId}${kind ? `, kind=${kind}` : ""}${summary ? `, ${summary}` : ""})`);
    this.name = "ApprovalParkSignal";
    this.requestId = requestId;
    this.kind = kind;
  }
}

/**
 * Coordinator for approval requests. core/ never reads stdin — when a rule
 * doesn't auto-decide, the coordinator emits `approval.requested` on the
 * supplied EventBus and waits for `resolve(requestId, decision)` from an
 * adapter (TUI / Web / Headless caller).
 *
 * Phase 4 (§2.3): replaces the readline-based prompt with an event roundtrip.
 *
 * ADR 0037 (Phase 2): DURING A TURN the session no longer blocks here — the
 * parking requester consults `evaluate()` (the pure rule verdict) and parks
 * the tool call on "ask" (see conversation.mjs). The blocking `request()`
 * round-trip remains for NON-turn contexts (TUI shell pre-gates, ad-hoc
 * callers), where the asking process IS the surface that answers.
 */
export class ApprovalCoordinator {
  constructor({ events, settings, defaultMode = "auto-readonly", alwaysAllow = [] } = {}) {
    if (!events || typeof events.emit !== "function") {
      throw new TypeError("ApprovalCoordinator: events bus is required");
    }
    this.events = events;
    this.settings = settings ?? {};
    this.defaultMode = defaultMode;
    /** ADR 0037 D5: the pending entry retains the full requested-event payload
     *  (summary / payload / sessionId), not just `kind`, so the serve bridge can
     *  REPLAY `approval.requested` verbatim on re-attach — a browser reconnect
     *  wipes its approval cards and would otherwise never see them again while
     *  the worker is still blocked here.
     *  @type {Map<string, { resolve: (decision: "allow" | "deny" | "always-allow") => void, kind: string, summary: string, payload: object | undefined, sessionId: string | undefined }>} */
    this.pending = new Map();
    /** @type {Set<string>} — kinds always-allowed for the rest of this session */
    this.alwaysAllow = new Set(Array.isArray(alwaysAllow) ? alwaysAllow.filter((k) => typeof k === "string") : []);
  }

  /**
   * Request approval for a tool call. Resolves to one of "allow" | "deny" | "always-allow".
   * `always-allow` behaves as "allow" for the current call and is also recorded
   * so future calls of the same kind auto-approve.
   *
   * @param {{
   *   kind: string,
   *   summary?: string,
   *   payload?: object,
   *   mutation?: boolean,
   *   approvalMode?: "always-ask" | "auto-readonly" | "full-auto",
   *   sessionId?: string
   * }} args
   * @returns {Promise<"allow" | "deny" | "always-allow">}
   */
  /**
   * Pure rule verdict for a tool call: "deny" | "allow" | "ask" — the shared
   * decision core `request()` blocks on and the ADR 0037 parking requester
   * parks on. A deny rule always wins (evaluated BEFORE the mode shortcuts so
   * full-auto / always-ask can't bypass it, matching permissions.mjs);
   * full-auto and session alwaysAllow short-circuit to allow; always-ask
   * ignores allow rules (every call still asks).
   */
  evaluate({ kind, summary = "", mutation = false, approvalMode } = {}) {
    const mode = approvalMode ?? this.settings?.approvalMode ?? this.defaultMode;
    const decision = evaluatePermissions({
      rules: this.settings?.permissions,
      kind,
      summary,
      mutation
    });
    if (decision === "deny") return "deny";
    if (mode === "full-auto") return "allow";
    if (this.alwaysAllow.has(kind)) return "allow";
    if (mode !== "always-ask" && decision === "allow") return "allow";
    return "ask";
  }

  async request({ kind, summary = "", payload, mutation = false, approvalMode, sessionId } = {}) {
    const verdict = this.evaluate({ kind, summary, mutation, approvalMode });
    if (verdict === "deny") return "deny";
    if (verdict === "allow") return "allow";

    const requestId = randomUUID();
    return new Promise((resolve) => {
      this.pending.set(requestId, { resolve, kind, summary, payload: payload ?? undefined, sessionId });
      this.events.emit(createEvent("approval.requested", {
        sessionId,
        requestId,
        kind,
        summary,
        payload: payload ?? undefined
      }));
    });
  }

  /**
   * Resolve a pending approval request. Adapters call this in response to
   * `approval.requested`. Re-emits `approval.resolved` on the bus and clears
   * the pending entry. `always-allow` records the kind so future calls of
   * the same kind auto-approve.
   *
   * @param {string} requestId
   * @param {"allow" | "deny" | "always-allow"} decision
   * @param {{ sessionId?: string }} [meta]
   */
  resolve(requestId, decision, { sessionId } = {}) {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    if (decision === "always-allow") this.alwaysAllow.add(entry.kind);
    this.events.emit(createEvent("approval.resolved", {
      sessionId,
      requestId,
      decision
    }));
    entry.resolve(decision);
    return true;
  }

  /**
   * Returns true if a request with the given id is awaiting resolution.
   * Useful for tests + sanity checks.
   */
  has(requestId) {
    return this.pending.has(requestId);
  }

  /**
   * ADR 0037 D5: snapshot every awaiting approval as a replay descriptor. The
   * serve bridge re-emits `approval.requested` from these on re-attach so a
   * reconnected client rebuilds its approval cards from the live coordinator
   * (the worker is still blocked here — the entry lives until resolve()).
   * @returns {Array<{ requestId: string, kind: string, summary: string, payload: object | undefined, sessionId: string | undefined }>}
   */
  listPending() {
    return [...this.pending.entries()].map(([requestId, e]) => ({
      requestId,
      kind: e.kind,
      summary: e.summary ?? "",
      payload: e.payload,
      sessionId: e.sessionId
    }));
  }
}

/**
 * Default in-process approval requester used when the session has no
 * coordinator wired. Headless callers without an EventBus fall through to
 * "auto-readonly" semantics: read-only tools auto-allow, anything that needs
 * a human is denied (the call site receives a skipped ToolResult).
 *
 * Phase 4 (§2.3): no readline / no stdin — `requestApproval` is now a pure
 * permissions evaluator. To get interactive prompts wire `ApprovalCoordinator`
 * via `AgentSession({ events, ... })` and an adapter that reads stdin.
 *
 * @param {{
 *   kind: string,
 *   summary?: string,
 *   mutation?: boolean,
 *   approvalMode?: "always-ask" | "auto-readonly" | "full-auto",
 *   permissions?: import("./permissions.mjs").PermissionRules,
 *   coordinator?: ApprovalCoordinator,
 *   sessionId?: string,
 *   payload?: object
 * }} args
 * @returns {Promise<boolean>}
 */
export async function requestApproval({
  kind,
  summary = "",
  mutation = false,
  approvalMode = "auto-readonly",
  permissions,
  coordinator,
  sessionId,
  payload
} = {}) {
  if (coordinator) {
    const decision = await coordinator.request({
      kind,
      summary,
      mutation,
      approvalMode,
      sessionId,
      payload
    });
    return decision === "allow" || decision === "always-allow";
  }
  if (approvalMode === "full-auto") return true;
  if (approvalMode === "always-ask") return false;
  const result = evaluatePermissions({ rules: permissions, kind, summary, mutation });
  return result === "allow";
}
