import { ulid } from "./ulid.mjs";

/**
 * @typedef {(
 *   | "session.created"
 *   | "session.resumed"
 *   | "user.prompt.submitted"
 *   | "assistant.message.started"
 *   | "assistant.message.delta"
 *   | "assistant.reasoning.delta"
 *   | "assistant.message.completed"
 *   | "tool.call.scheduled"
 *   | "tool.call.started"
 *   | "tool.call.completed"
 *   | "approval.requested"
 *   | "approval.resolved"
 *   | "interaction.requested"
 *   | "interaction.resolved"
 *   | "activity.started"
 *   | "activity.tick"
 *   | "activity.stopped"
 *   | "compact.applied"
 *   | "usage.recorded"
 *   | "attachment.produced"
 *   | "turn.completed"
 *   | "turn.failed"
 * )} AgentEventType
 */

/**
 * @typedef {{ eventId: string, sessionId?: string, time: string }} EventEnvelope
 *
 * @typedef {EventEnvelope & (
 *   | { type: "session.created", cwd: string, provider: string, model: string, compatibilityMode?: string }
 *   | { type: "session.resumed", from: { eventCount: number, snapshotId?: string } }
 *   | { type: "user.prompt.submitted", messageId: string, content: import("../types/message.mjs").ContentBlock[] }
 *   | { type: "assistant.message.started",   messageId: string, round: number }
 *   | { type: "assistant.message.delta",     messageId: string, deltaText: string }
 *   | { type: "assistant.reasoning.delta",   messageId: string, deltaText: string }
 *   | { type: "assistant.message.completed", messageId: string, content: import("../types/message.mjs").ContentBlock[], toolCalls?: Array<{ toolCallId: string, name: string, args: object }>, reasoningContent?: string }
 *   | { type: "tool.call.scheduled", toolCallId: string, name: string, args: object, mutation: boolean }
 *   | { type: "tool.call.started",   toolCallId: string, name: string }
 *   | { type: "tool.call.completed", toolCallId: string, ok: boolean, result: import("../types/tool-result.mjs").ToolResult }
 *   | { type: "approval.requested", requestId: string, kind: string, summary: string, payload?: object }
 *   | { type: "approval.resolved",  requestId: string, decision: "allow" | "deny" | "always-allow" }
 *       // UIR (User Interaction Request): worker asks the user for structured
 *       // input (a form/choice/confirm) and — when blocking — waits for the
 *       // response. NOT an approval gate. `spec` is the kind-specific UI
 *       // descriptor; `response` is arbitrary JSON the surface collects.
 *   | { type: "interaction.requested", requestId: string, kind: string, summary: string, spec?: object }
 *   | { type: "interaction.resolved",  requestId: string, response?: object }
 *       // Run-loop flow/task progress (#120). Emitted by packages/core run-loop
 *       // as each task is picked up / finishes and as the flow advances, so the
 *       // dashboard's persistent ChatFlowProgress header can move event-driven
 *       // (the 5s loop-proposal poll stays as the fallback). These are forwarded
 *       // UP from the loop — never produced inside a worker session.
 *   | { type: "task.started",   runId?: string, taskId: string, taskName?: string, flowType?: string, stepIndex?: number, stepTotal?: number }
 *   | { type: "task.completed", runId?: string, taskId: string, taskName?: string, flowType?: string, stepIndex?: number, stepTotal?: number, taskStatus?: string }
 *   | { type: "flow.advanced",  runId?: string, taskId?: string, flowType?: string, stepIndex?: number, stepTotal?: number, status?: string }
 *   | { type: "activity.started", activityId: string, label: string, detail?: string }
 *   | { type: "activity.tick",    activityId: string, elapsedMs: number, detail?: string }
 *       // Long-running tool progress (foreground run_shell streaming tails,
 *       // shell_job wait heartbeats). Any event feeds the turn-idle watchdog,
 *       // so these keep a healthy multi-minute tool from aborting the turn.
 *   | { type: "activity.stopped", activityId: string, outcome: string }
 *   | { type: "compact.applied", strategy: string, removedMessageIds: string[], snapshotId?: string, summaryMessageId?: string }
 *   | { type: "usage.recorded",  round: number, inputTokens: number, outputTokens: number, costUsd?: number }
 *   | { type: "attachment.produced", id: string, mime?: string, name?: string, bytes?: number, direction: "outbound", toolCallId?: string }
 *       // The session attached a workspace file to the conversation via
 *       // attach_file. Surfaces deliver it: the dashboard renders a
 *       // thumbnail/download, a bound Slack thread re-uploads it (Phase 3).
 *   | { type: "turn.completed",  round: number, exitCode: number, messageId?: string }
 *   | { type: "turn.failed",     round: number, error: { message: string, code?: string }, messageId?: string }
 *   | { type: "todos.updated",   todos: Array<{ id: string, content: string, status: "pending"|"in_progress"|"completed", activeForm: string }> }
 *   | { type: "memory.loaded",   count: number, types: { user: number, feedback: number, project: number, reference: number } }
 *   | { type: "memory.written",  name: string, type: string, action: "create" | "update" }
 *   | { type: "plan.queued",     entryId: string, kind: string, summary: string, payload?: object }
 *   | { type: "plan.applied",    entryIds: string[] }
 *   | { type: "plan.discarded",  reason: string }
 *   | { type: "session.branched",fromSessionId: string, fromMessageId: string, toSessionId: string }
 *   | { type: "hook.executed",   phase: "preToolUse"|"postToolUse"|"userPromptSubmit", matcher?: string, command: string, exitCode: number, stdout: string, stderr: string, durationMs: number }
 * )} AgentEvent
 */

export const EVENT_TYPES = Object.freeze([
  "session.created",
  "session.resumed",
  "user.prompt.submitted",
  "assistant.message.started",
  "assistant.message.delta",
  "assistant.reasoning.delta",
  "assistant.message.completed",
  "tool.call.scheduled",
  "tool.call.started",
  "tool.call.completed",
  "approval.requested",
  "approval.resolved",
  "interaction.requested",
  "interaction.resolved",
  "task.started",
  "task.completed",
  "flow.advanced",
  "activity.started",
  "activity.tick",
  "activity.stopped",
  "compact.applied",
  "usage.recorded",
  "attachment.produced",
  "turn.completed",
  "turn.failed",
  "todos.updated",
  "memory.loaded",
  "memory.written",
  "plan.queued",
  "plan.applied",
  "plan.discarded",
  "session.branched",
  "hook.executed"
]);

const EVENT_TYPE_SET = new Set(EVENT_TYPES);

export function isKnownEventType(type) {
  return typeof type === "string" && EVENT_TYPE_SET.has(type);
}

/**
 * Build an AgentEvent envelope, auto-filling `eventId` and `time` when absent.
 * Phase 8: switched from `crypto.randomUUID()` to ULID so multiple WebSocket
 * clients can sort and de-duplicate the event stream lexicographically.
 *
 * @param {AgentEventType} type
 * @param {Record<string, unknown>} [payload]
 * @returns {AgentEvent}
 */
export function createEvent(type, payload = {}) {
  if (!isKnownEventType(type)) {
    throw new Error(`createEvent: unknown event type "${String(type)}"`);
  }
  const envelope = {
    eventId: typeof payload.eventId === "string" ? payload.eventId : ulid(),
    time: typeof payload.time === "string" ? payload.time : new Date().toISOString()
  };
  return { ...payload, ...envelope, type };
}

/**
 * Shallow validator: confirms `value` looks like an AgentEvent envelope with
 * a known `type`. Does not enforce per-type payload shape.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isAgentEvent(value) {
  if (!value || typeof value !== "object") return false;
  const candidate = /** @type {{ type?: unknown }} */ (value);
  return isKnownEventType(candidate.type);
}
