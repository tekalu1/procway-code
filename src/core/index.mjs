/**
 * Headless API for procway-code (Phase 4).
 *
 * `core/index.mjs` is a pure barrel: it performs no I/O of its own and only
 * re-exports values from internal modules. Adapters (TUI / Web / WebSocket)
 * compose `createAgentSession` with their own event subscribers to provide
 * UI on top of the same headless core.
 *
 * Phase 1 carry-over (phase1_B-1): `isKnownEventType` is intentionally NOT
 * re-exported. It is an internal helper used by `createEvent` / `isAgentEvent`
 * inside `core/events/types.mjs`; external callers compose with `EVENT_TYPES`
 * directly if they need to validate. See report.md for the rationale.
 */
import { AgentSession } from "../agent/conversation.mjs";
import { EventBus } from "./events/bus.mjs";

export { AgentSession, EventBus };

export {
  createEvent,
  isAgentEvent,
  EVENT_TYPES
} from "./events/types.mjs";

export {
  createMessage,
  messageContentToText,
  CONTENT_KINDS,
  MESSAGE_ROLES
} from "./types/message.mjs";

export {
  isToolResult,
  isKnownToolKind,
  KNOWN_TOOL_KINDS
} from "./types/tool-result.mjs";

export { messagesFromEvents } from "./projections/messages.mjs";
export { timelineFromEvents } from "./projections/timeline.mjs";
export { usageFromEvents } from "./projections/usage.mjs";
export { transcriptFromMessages } from "./projections/transcript.mjs";

export { evaluatePermissions } from "../safety/permissions.mjs";
export { ApprovalCoordinator, requestApproval } from "../safety/approval.mjs";

// ADR 0030 D5: hosts that change the environment after startup (install the
// display-tool binaries, set DISPLAY/AGENT_BROWSER_EXECUTABLE_PATH in
// process.env, edit settings.tools.browser) call this to drop the cached
// desktop/browser availability so the next session re-probes.
export { invalidateDisplayToolAvailability } from "../tools/registry.mjs";

export { compactCommand } from "./commands/compact.mjs";
export { configCommand } from "./commands/config.mjs";
export { contextCommand } from "./commands/context.mjs";
export { historyCommand } from "./commands/history.mjs";
export { modelCommand } from "./commands/model.mjs";
export { resumeCommand } from "./commands/resume.mjs";
export { exitCommand } from "./commands/exit.mjs";
export { usageCommand } from "./commands/usage.mjs";
export { planCommand } from "./commands/plan.mjs";
export { todosCommand } from "./commands/todos.mjs";
export { memoryCommand } from "./commands/memory.mjs";
export { branchCommand } from "./commands/branch.mjs";
export {
  mcpListCommand,
  addMcpServer,
  removeMcpServer,
  parseMcpAddArgs,
  validateMcpServerConfig,
  MCP_TRANSPORTS
} from "./commands/mcp.mjs";

export { listSessions } from "../session/store.mjs";

export { summarizeUsage, createUsageTracker } from "../usage-tracker.mjs";

/**
 * Build and initialize an `AgentSession` with a default `EventBus` if none
 * was provided. Adapters subscribe to events on the returned session before
 * calling `runTurn` to receive streaming deltas, approval requests, etc.
 *
 * Headless usage:
 * ```js
 * import { createAgentSession } from "procway-code";
 * const session = await createAgentSession({ settings, cwd, sessionId });
 * await session.runTurn("hello");
 * ```
 *
 * @param {{
 *   settings: object,
 *   cwd?: string,
 *   sessionId?: string,
 *   messages?: Array<unknown>,
 *   title?: string,
 *   depth?: number,
 *   events?: EventBus,
 *   approvalCoordinator?: import("../safety/approval.mjs").ApprovalCoordinator,
 *   approvalRequester?: Function,
 *   mcpRegistry?: object,
 *   origin?: string | null
 * }} input
 */
export async function createAgentSession(input = {}) {
  const events = input.events ?? new EventBus();
  const session = new AgentSession({ ...input, events });
  await session.initialize();
  return session;
}
