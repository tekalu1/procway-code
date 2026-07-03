import { randomUUID } from "node:crypto";
import { createEvent } from "../core/events/types.mjs";

const DEFERRABLE_TOOL_NAMES = new Set([
  "write_file",
  "apply_patch",
  "Edit",
  "edit",
  "run_shell",
  "spawn_agent"
]);

export class PlanMode {
  constructor({ session, active = false } = {}) {
    this.session = session;
    this.active = !!active;
    /** @type {Array<{ entryId: string, name: string, args: object, summary: string, payload?: object }>} */
    this.queue = [];
  }

  isActive() { return this.active; }
  hasPending() { return this.queue.length > 0; }
  pending() { return this.queue.slice(); }

  setActive(active) {
    this.active = !!active;
    if (!this.active) this.queue = [];
    return this.active;
  }

  toggle() {
    return this.setActive(!this.active);
  }

  shouldDefer(toolName, args = null) {
    if (!this.active) return false;
    // shell_job is a mixed-action tool: only the kill action mutates; the
    // status/logs/wait reads must run live so the model can plan against
    // real job state.
    if (toolName === "shell_job") return args?.action === "kill";
    return DEFERRABLE_TOOL_NAMES.has(toolName) || (typeof toolName === "string" && toolName.startsWith("mcp__"));
  }

  enqueue({ name, args, summary, payload }) {
    const entryId = randomUUID();
    const entry = { entryId, name, args: args ?? {}, summary: summary ?? "", payload };
    this.queue.push(entry);
    this.session.events.emit(createEvent("plan.queued", {
      sessionId: this.session.sessionId,
      entryId,
      kind: name,
      summary: entry.summary,
      ...(payload ? { payload } : {})
    }));
    return entry;
  }

  discard(reason = "discarded") {
    if (this.queue.length === 0) return;
    this.queue = [];
    this.session.events.emit(createEvent("plan.discarded", {
      sessionId: this.session.sessionId,
      reason
    }));
  }

  async apply({ executeImpl } = {}) {
    if (this.queue.length === 0) return [];
    const entries = this.queue.slice();
    this.queue = [];
    this.session.events.emit(createEvent("plan.applied", {
      sessionId: this.session.sessionId,
      entryIds: entries.map((entry) => entry.entryId)
    }));
    if (typeof executeImpl !== "function") return entries;
    const results = [];
    const wasActive = this.active;
    this.active = false;
    try {
      for (const entry of entries) {
        const result = await executeImpl(entry);
        results.push(result);
      }
    } finally {
      this.active = wasActive;
    }
    return results;
  }

  async promptApply({ approvalRequester, executeImpl } = {}) {
    if (!this.active || this.queue.length === 0) return { decision: "noop", applied: 0 };
    const summaryText = this.queue.map((entry) => `${entry.name}: ${entry.summary}`).join("; ");
    const allowed = approvalRequester
      ? await approvalRequester({
          kind: "plan_apply",
          summary: `${this.queue.length} queued operations: ${summaryText}`.slice(0, 400),
          mutation: true,
          payload: { entries: this.queue.map((entry) => ({
            entryId: entry.entryId,
            name: entry.name,
            summary: entry.summary,
            args: entry.args
          })) }
        })
      : false;
    if (!allowed) {
      this.discard("user-rejected");
      return { decision: "deny", applied: 0 };
    }
    const results = await this.apply({ executeImpl });
    return { decision: "allow", applied: results.length };
  }
}

/**
 * Build a synthetic ToolResult representing a deferred tool call. The kind is
 * mapped onto the matching ToolResult kind so projections / tool-render keep
 * working without special-casing.
 */
export function buildDeferredToolResult({ name, args, summary }) {
  const kind = mapNameToKind(name);
  return {
    kind,
    summary: `[Plan mode] queued ${name}: ${summary}`.slice(0, 200),
    data: {
      planQueued: true,
      tool: name,
      args: args ?? {},
      message: "Tool call queued under plan mode; will run after user approves the plan."
    }
  };
}

function mapNameToKind(name) {
  if (typeof name === "string" && name.startsWith("mcp__")) return "mcp";
  if (name === "write_file") return "write_file";
  if (name === "apply_patch") return "apply_patch";
  if (name === "Edit" || name === "edit") return "edit";
  if (name === "run_shell" || name === "shell_job") return "run_shell";
  if (name === "spawn_agent") return "spawn_agent";
  return "run_shell";
}
