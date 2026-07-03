import { randomUUID } from "node:crypto";
import { createEvent } from "../core/events/types.mjs";
import { evaluatePermissions } from "./permissions.mjs";

/**
 * Approval modes:
 * - auto-readonly: read-only tools run automatically; mutation/dangerous tools ask.
 * - always-ask:   every tool call asks (permissions allow rules are ignored).
 * - full-auto:    every tool call runs without asking.
 */

/**
 * Coordinator for approval requests. core/ never reads stdin — when a rule
 * doesn't auto-decide, the coordinator emits `approval.requested` on the
 * supplied EventBus and waits for `resolve(requestId, decision)` from an
 * adapter (TUI / Web / Headless caller).
 *
 * Phase 4 (§2.3): replaces the readline-based prompt with an event roundtrip.
 */
export class ApprovalCoordinator {
  constructor({ events, settings, defaultMode = "auto-readonly", alwaysAllow = [] } = {}) {
    if (!events || typeof events.emit !== "function") {
      throw new TypeError("ApprovalCoordinator: events bus is required");
    }
    this.events = events;
    this.settings = settings ?? {};
    this.defaultMode = defaultMode;
    /** @type {Map<string, { resolve: (decision: "allow" | "deny" | "always-allow") => void, kind: string }>} */
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
  async request({ kind, summary = "", payload, mutation = false, approvalMode, sessionId } = {}) {
    const mode = approvalMode ?? this.settings?.approvalMode ?? this.defaultMode;
    if (mode === "full-auto") return "allow";
    if (this.alwaysAllow.has(kind)) return "allow";

    if (mode !== "always-ask") {
      const decision = evaluatePermissions({
        rules: this.settings?.permissions,
        kind,
        summary,
        mutation
      });
      if (decision === "allow") return "allow";
      if (decision === "deny") return "deny";
    }

    const requestId = randomUUID();
    return new Promise((resolve) => {
      this.pending.set(requestId, { resolve, kind });
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
   * Returns true if ANY approval is awaiting a human decision. The turn idle
   * watchdog pauses while this is true so a slow human reviewer doesn't trip
   * the stall abort (mirrors InteractionCoordinator.hasPending).
   */
  hasPending() {
    return this.pending.size > 0;
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
