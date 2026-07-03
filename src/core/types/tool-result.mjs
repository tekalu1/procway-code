/**
 * @typedef {(
 *   | "list_files"
 *   | "read_file"
 *   | "search_files"
 *   | "write_file"
 *   | "apply_patch"
 *   | "edit"
 *   | "run_shell"
 *   | "spawn_agent"
 *   | "web_search"
 *   | "web_fetch"
 *   | "browser_action"
 *   | "desktop_action"
 *   | "view_image"
 *   | "ask_image"
 *   | "save_attachment"
 *   | "attach_file"
 *   | "start_run"
 *   | "get_run_status"
 *   | "resume_run"
 *   | "reply_run"
 *   | "interaction"
 *   | "mcp"
 * )} ToolKind
 *
 * Note: "browser_action" is the shared browser-result category, now emitted by
 * the `web_browser` tool (agent-browser backend, ADR 0007). The legacy
 * Playwright `browser_action` tool was removed in ADR 0007 Phase 3; the kind
 * string is kept so dashboard result rendering stays stable.
 */

/**
 * @typedef {{
 *   kind: ToolKind,
 *   summary: string,
 *   data: object,
 *   diagnostics?: { warnings?: string[] }
 * }} ToolResult
 */

export const KNOWN_TOOL_KINDS = Object.freeze([
  "list_files",
  "read_file",
  "search_files",
  "write_file",
  "apply_patch",
  "edit",
  "run_shell",
  "spawn_agent",
  "web_search",
  "web_fetch",
  "browser_action",
  "desktop_action",
  "view_image",
  "ask_image",
  "save_attachment",
  "attach_file",
  "start_run",
  "get_run_status",
  "resume_run",
  "reply_run",
  "load_tools",
  "interaction",
  "mcp"
]);

const KNOWN_KIND_SET = new Set(KNOWN_TOOL_KINDS);

export function isKnownToolKind(kind) {
  return typeof kind === "string" && KNOWN_KIND_SET.has(kind);
}

/**
 * Shallow validator for ToolResult. Confirms the required fields are present
 * and `kind` is one of the recognized tool kinds.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isToolResult(value) {
  if (!value || typeof value !== "object") return false;
  const candidate = /** @type {{ kind?: unknown, summary?: unknown, data?: unknown }} */ (value);
  if (!isKnownToolKind(candidate.kind)) return false;
  if (typeof candidate.summary !== "string") return false;
  if (!candidate.data || typeof candidate.data !== "object") return false;
  return true;
}
