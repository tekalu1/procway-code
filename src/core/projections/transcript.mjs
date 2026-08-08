/**
 * Pure transcript projection. Phase 4 lift: was previously in `src/tui/`,
 * but it has zero I/O so it belongs alongside the other projections under
 * `core/projections/`. (The `src/tui/transcript.mjs` shim that used to
 * re-export this module was deleted in Phase 1; this is the only definition.)
 *
 * @typedef {(
 *   | { kind: "user",                 role: "user",      text: string, attachments?: Array<{ id: string, mime?: string, name?: string }> }
 *   | { kind: "assistant",            role: "assistant", text: string }
 *   | { kind: "assistant-tool-calls", role: "assistant", text: string, toolCalls: Array<{ toolCallId?: string, name: string, args: object }> }
 *   | { kind: "tool",                 role: "tool",      text: string, toolCallId?: string, attachments?: Array<{ id: string, mime?: string, name?: string }> }
 *   | { kind: "compact-summary",      role: "system",    text: string, strategy: string|null, llmFallback?: true, fallbackStrategy?: string, fallbackReason?: string }
 *   | { kind: "system",               role: string,      text: string }
 * )} TranscriptNode
 */

const DEFAULT_MAX_MESSAGES = 100;

export function transcriptFromMessages(messages = [], { maxMessages = DEFAULT_MAX_MESSAGES } = {}) {
  if (!Array.isArray(messages)) return [];
  const visible = messages
    // Hide the instruction/system prompt, but keep compaction summaries: they
    // are stored as compacted system messages and must survive into the
    // resumed transcript so the UI can show what was condensed.
    .filter((message) => message && typeof message === "object" && (message.role !== "system" || message.compacted === true))
    .slice(-maxMessages);
  return visible.map(projectMessage);
}

function projectMessage(message) {
  const role = message.role;
  if (role === "user") {
    const attachments = extractInboundAttachments(message);
    return {
      kind: "user",
      role: "user",
      text: extractUserVisibleText(message),
      ...(attachments.length > 0 ? { attachments } : {})
    };
  }
  if (role === "assistant") {
    const toolUses = extractToolUses(message);
    if (toolUses.length > 0 && !hasMeaningfulText(message)) {
      return {
        kind: "assistant-tool-calls",
        role: "assistant",
        text: `[tool calls: ${toolUses.map((toolCall) => toolCall.name).join(", ")}]`,
        toolCalls: toolUses
      };
    }
    return { kind: "assistant", role: "assistant", text: extractText(message) };
  }
  if (role === "tool") {
    const attachments = extractOutboundAttachments(message);
    return {
      kind: "tool",
      role: "tool",
      text: extractToolText(message),
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
      ...(attachments.length > 0 ? { attachments } : {})
    };
  }
  if (role === "system" && message.compacted === true) {
    const node = {
      kind: "compact-summary",
      role: "system",
      text: extractText(message),
      strategy: typeof message.compactStrategy === "string" ? message.compactStrategy : null
    };
    if (message.llmFallback === true) {
      node.llmFallback = true;
      if (typeof message.fallbackStrategy === "string") node.fallbackStrategy = message.fallbackStrategy;
      if (typeof message.fallbackReason === "string") node.fallbackReason = message.fallbackReason;
    }
    return node;
  }
  return { kind: "system", role, text: extractText(message) };
}

function extractText(message) {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    const text = message.content
      .filter((block) => block?.kind === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");
    if (text) return text;
    return JSON.stringify(message.content);
  }
  if (message.content == null && Array.isArray(message.tool_calls)) {
    return `[tool calls: ${message.tool_calls.map((toolCall) => toolCall.function?.name ?? toolCall.name).join(", ")}]`;
  }
  return JSON.stringify(message.content ?? "");
}

// Leading `<system-reminder>…</system-reminder>` blocks are runtime-only
// preambles prepended to the user prompt (the task-completion retry reminder,
// and the Phase-2 AI-sidepanel hidden ticket/project context). The model must
// see them but they must NEVER render as a visible user bubble or become the
// session title. Strip any run of leading reminder blocks (each followed by its
// trailing blank line) so DISPLAY shows only what the user actually typed. Used
// by both the transcript projection and the session title derivation so live,
// replayed, and titled renderings agree. Exported for reuse by the dashboard
// client's optimistic-echo path (mirrored in useProcwayCodeSession).
export function stripSystemReminders(text) {
  if (typeof text !== "string" || !text) return text ?? "";
  // Non-greedy match of one leading reminder block plus the blank line(s) that
  // separate it from the real prompt; repeat to peel stacked reminders.
  let out = text;
  const re = /^<system-reminder>[\s\S]*?<\/system-reminder>\s*/;
  while (re.test(out)) out = out.replace(re, "");
  return out;
}

// User messages carry the typed prompt as the FIRST text block, followed by
// attachment_ref blocks and then an auto-generated attachment NOTE text block
// (buildAttachmentNote) meant only for the model. For DISPLAY we want just the
// user's text, so take the text blocks BEFORE the first attachment_ref — this
// drops the trailing note without depending on its (localized) wording, and
// works for already-persisted messages too. We also strip any leading
// <system-reminder> preamble (task-completion retry / sidepanel hidden context)
// so it never surfaces as a visible bubble.
function extractUserVisibleText(message) {
  if (!Array.isArray(message.content)) return stripSystemReminders(extractText(message));
  const firstRefIdx = message.content.findIndex((block) => block?.kind === "attachment_ref");
  const text = (firstRefIdx === -1 ? message.content : message.content.slice(0, firstRefIdx))
    .filter((block) => block?.kind === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
  return stripSystemReminders(text);
}

// Inbound attachments the USER sent ride as attachment_ref blocks (no outbound
// direction) on the user message. Surface them so a resume/reload re-renders
// the thumbnail / file chip under the user turn — the mirror of
// extractOutboundAttachments for attach_file outputs.
function extractInboundAttachments(message) {
  if (!Array.isArray(message.content)) return [];
  return message.content
    .filter((block) => block?.kind === "attachment_ref"
      && block.direction !== "outbound"
      && typeof block.id === "string"
      && block.id.length > 0)
    .map((block) => ({
      id: block.id,
      ...(block.mime ? { mime: block.mime } : {}),
      ...(typeof block.name === "string" && block.name ? { name: block.name } : {})
    }));
}

function extractToolUses(message) {
  if (Array.isArray(message.content)) {
    return message.content
      .filter((block) => block?.kind === "tool_use")
      .map((block) => ({
        toolCallId: block.toolCallId,
        name: block.name,
        args: block.args ?? {}
      }));
  }
  if (message.content == null && Array.isArray(message.tool_calls)) {
    return message.tool_calls.map((toolCall) => ({
      toolCallId: toolCall.id,
      name: toolCall.function?.name ?? toolCall.name,
      args: toolCall.function?.arguments ?? toolCall.args ?? {}
    }));
  }
  return [];
}

// Outbound attachments the session produced via attach_file ride as
// `attachment_ref(direction:"outbound")` blocks on the tool message. Surface
// them so a resume/reload re-renders the attachment under its assistant turn
// (the dashboard hangs these off the assistant message that owns the call).
function extractOutboundAttachments(message) {
  if (!Array.isArray(message.content)) return [];
  return message.content
    .filter((block) => block?.kind === "attachment_ref"
      && block.direction === "outbound"
      && typeof block.id === "string"
      && block.id.length > 0)
    .map((block) => ({
      id: block.id,
      ...(block.mime ? { mime: block.mime } : {}),
      ...(typeof block.name === "string" && block.name ? { name: block.name } : {})
    }));
}

function hasMeaningfulText(message) {
  if (typeof message.content === "string") return message.content.length > 0;
  if (Array.isArray(message.content)) {
    return message.content.some((block) => block?.kind === "text" && typeof block.text === "string" && block.text.length > 0);
  }
  return false;
}

function extractToolText(message) {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    const toolResult = message.content.find((block) => block?.kind === "tool_result");
    if (toolResult) {
      const payload = toolResult.ok === false
        ? { error: toolResult.result?.error ?? toolResult.result }
        : toolResult.result;
      return JSON.stringify(payload ?? null);
    }
    const text = message.content
      .filter((block) => block?.kind === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");
    if (text) return text;
    return JSON.stringify(message.content);
  }
  return JSON.stringify(message.content ?? "");
}
