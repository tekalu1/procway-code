/**
 * The single node → string renderer for the terminal.
 *
 * Before Phase 1 there were four independent node-to-string implementations
 * and three tool-display implementations, and which one you got depended on
 * how you reached the transcript (`procway-code resume` vs `/resume` vs
 * `/history` vs `/checkout`). The `/resume` path in particular passed no
 * `markdown` flag and no `maxChars`, so resuming a tool-heavy session dumped
 * tens of kilobytes of raw tool JSON into the terminal.
 *
 *   core/projections/transcriptFromMessages   (the single projection)
 *          │
 *          ├─ live:   events → timeline/streaming renderers
 *          └─ replay: messages → renderTranscriptNode()  ← this file
 *
 * Everything that turns a `TranscriptNode` into ANSI text goes through
 * `renderTranscriptNode`. There is no `markdown: boolean` any more: the only
 * knob is `colorize`, and every call site derives it from
 * `ansi.mjs#supportsColor(stream)` so `NO_COLOR` / `FORCE_COLOR` / a piped
 * stdout behave identically on all routes.
 */

import { transcriptFromMessages } from "../../core/projections/transcript.mjs";
import { renderMarkdown, trimTrailingNewlines } from "./markdown-render.mjs";
import { renderToolCall } from "./tool-render.mjs";
import { style, terminalWidth } from "./ansi.mjs";
import { sanitizeInline, sanitizeTerminalText } from "./sanitize.mjs";
import { WAKE_NOTICE_LINE } from "./turn-executor.mjs";

/**
 * Messages kept when replaying a session in the terminal. This is the core
 * projection's own default, restated here so that all four TUI routes share
 * one explicit value instead of three of them inheriting it by accident and a
 * fourth overriding it. 100 messages ≈ 30-50 turns; combined with the
 * header-only tool lines (a tool node is `✓ name(args)`, no result body) the
 * worst-case recap stays inside a few screens instead of the 53 KB JSON wall
 * it used to be.
 * (`adapters/serve/` keeps `Infinity`: a web client can virtualise.)
 */
export const RECAP_MAX_MESSAGES = 100;

const EMPTY_MAP = new Map();
const EMPTY_SET = new Set();

export const NO_HISTORY = "(no prior conversation)\n";

/**
 * Render one transcript node.
 *
 * @param {object} node  a `TranscriptNode` from core/projections/transcript.mjs
 * @param {object} [options]
 * @param {number}  [options.width]        terminal width for Markdown wrapping
 * @param {boolean} [options.colorize]     emit ANSI (callers pass supportsColor(stream))
 * @param {number}  [options.maxChars]     cap for user/assistant/system text
 *        (tool nodes are header-only — `✓ name(args)` — so there is no body to
 *        clip; this makes a replayed session look identical to the live feed)
 * @param {boolean} [options.hyperlinks]   emit OSC 8 links (callers pass
 *        `resolveHyperlinks(...)`; must match what the live renderer got)
 * @param {Map<string, {name: string, args: object}>} [options.toolCalls]
 *        toolCallId → the call that produced this result (P1-2 pairing)
 * @param {Set<string>} [options.resolvedToolCallIds]
 *        toolCallIds that already have a `tool` node in this transcript; their
 *        headers are rendered by that node, so the `assistant-tool-calls` node
 *        only prints the calls still awaiting a result.
 * @returns {string} a block WITHOUT a trailing newline ("" = render nothing)
 */
export function renderTranscriptNode(node, {
  width = 80,
  colorize = false,
  maxChars,
  hyperlinks = false,
  toolCalls = EMPTY_MAP,
  resolvedToolCallIds = EMPTY_SET
} = {}) {
  if (!node || typeof node !== "object") return "";
  const kind = node.kind ?? "system";

  if (kind === "user") {
    const label = colorize ? style(["accentStrong", "bold"], "You") : "You";
    const body = truncateText(node.text ?? "", maxChars);
    const attachments = renderAttachments(node.attachments, colorize);
    const text = `${label}: ${body}`;
    return attachments ? `${text}\n${attachments}` : text;
  }

  if (kind === "assistant") {
    const body = truncateText(node.text ?? "", maxChars);
    if (!body) return "";
    // No role label — the live streaming renderer prints the assistant's prose
    // bare (renderAssistantContent), so a replayed message must be
    // byte-identical to what streamed (P3c parity: replay === live output).
    return trimTrailingNewlines(renderMarkdown(body, { width, color: colorize, hyperlinks }));
  }

  if (kind === "assistant-tool-calls") {
    // Calls whose result is present in this transcript are rendered by the
    // paired `tool` node (one line per call, with the result). Only the
    // still-pending ones — an interrupted turn, or a call whose result fell
    // outside the maxMessages window — get a header of their own.
    const pending = (node.toolCalls ?? []).filter((call) => !(call?.toolCallId && resolvedToolCallIds.has(call.toolCallId)));
    if (pending.length === 0) return "";
    return pending
      .map((call) => trimTrailingNewlines(renderToolCall({
        name: call?.name,
        args: call?.args ?? {},
        status: "start",
        colorize
      })))
      .join("\n");
  }

  if (kind === "tool") {
    const call = node.toolCallId ? toolCalls.get(node.toolCallId) : null;
    const { result, ok } = toolResultFromNode(node);
    // Header only (`✓ name(args)`), exactly like the live feed's completed
    // tool row — no clipped result body. Keeps a heavy tool session's recap
    // one line per call and makes replay byte-identical to what was on screen.
    const block = trimTrailingNewlines(renderToolCall({
      name: call?.name ?? result?.kind ?? "tool",
      args: call?.args ?? {},
      status: ok ? "ok" : "error",
      colorize
    }));
    const attachments = renderAttachments(node.attachments, colorize);
    return attachments ? `${block}\n${attachments}` : block;
  }

  if (kind === "wake") {
    // event-wake (issue #143): replay the SAME muted one-liner the REPL printed
    // live. The node's `text` is the raw <system-reminder> body — dumping it
    // here would replace a one-line marker with a screenful of machine prompt,
    // and it never appeared on screen in the first place.
    return colorize ? style("muted", WAKE_NOTICE_LINE) : WAKE_NOTICE_LINE;
  }

  if (kind === "compact-summary") {
    const strategy = node.strategy ? ` (${sanitizeInline(node.strategy)})` : "";
    const header = `— compacted${strategy} —`;
    const body = truncateText(node.text ?? "", maxChars);
    const text = body ? `${header}\n${body}` : header;
    return colorize ? style("muted", text) : text;
  }

  const body = truncateText(node.text ?? "", maxChars);
  if (!body) return "";
  return colorize ? style("muted", body) : body;
}

/** Render a whole projected transcript. Blocks are separated by a blank line. */
export function renderTranscriptNodes(nodes = [], options = {}) {
  if (!Array.isArray(nodes) || nodes.length === 0) return "";
  const resolvedToolCallIds = options.resolvedToolCallIds ?? new Set(
    nodes.filter((node) => node?.kind === "tool" && node.toolCallId).map((node) => node.toolCallId)
  );
  const blocks = nodes
    .map((node) => renderTranscriptNode(node, { ...options, resolvedToolCallIds }))
    .filter((block) => typeof block === "string" && block.length > 0);
  if (blocks.length === 0) return "";
  return `${blocks.join("\n\n")}\n`;
}

/**
 * Project a raw message array and render it. This is what all four replay
 * routes go through (via session-recap.mjs).
 */
export function renderTranscript(messages = [], {
  maxMessages = RECAP_MAX_MESSAGES,
  ...options
} = {}) {
  const nodes = transcriptFromMessages(messages, { maxMessages });
  if (nodes.length === 0) return NO_HISTORY;
  const rendered = renderTranscriptNodes(nodes, {
    ...options,
    toolCalls: options.toolCalls ?? collectToolCalls(messages)
  });
  return rendered.length > 0 ? rendered : NO_HISTORY;
}

export function printTranscript({ messages, output = process.stdout, width, ...options }) {
  output.write(renderTranscript(messages, {
    ...options,
    width: width ?? terminalWidth(output)
  }));
}

/**
 * P1-2 pairing: map `toolCallId` → `{ name, args }` from the assistant
 * messages so a `tool` node can be rendered as
 * `✓ run_shell(command="pnpm test")` instead of a bare JSON blob.
 *
 * This reads the raw messages rather than the projection because the
 * projection only surfaces `toolCalls` when the assistant message has NO
 * text — a message that mixes prose and tool calls projects to a plain
 * `assistant` node and loses the arguments.
 */
export function collectToolCalls(messages = []) {
  const map = new Map();
  if (!Array.isArray(messages)) return map;
  for (const message of messages) {
    if (!message || message.role !== "assistant") continue;
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.kind !== "tool_use" || !block.toolCallId) continue;
        map.set(block.toolCallId, { name: block.name, args: block.args ?? {} });
      }
      continue;
    }
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const id = call?.id;
        if (!id) continue;
        map.set(id, {
          name: call.function?.name ?? call.name,
          args: parseMaybeJson(call.function?.arguments ?? call.args) ?? {}
        });
      }
    }
  }
  return map;
}

/**
 * Render an assistant message's content blocks the same way the streaming
 * renderer does (Markdown, no role label). Used by the REPL's
 * `assistant.message.completed` fallback so a non-streaming provider looks
 * identical to a streaming one.
 */
export function renderAssistantContent(content, { width = 80, colorize = false, hyperlinks = false } = {}) {
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter((block) => block?.kind === "text" && typeof block.text === "string").map((block) => block.text).join("")
      : "";
  if (!text) return "";
  // Byte-identical to what the streaming renderer emits for the same message
  // (block body, then one blank line before the next prompt). Two things used
  // to diverge here: `colorize:false` skipped Markdown entirely — so a piped
  // run showed raw `##` markers live and rendered ones on replay — and the
  // trailing blank line was missing.
  const body = trimTrailingNewlines(renderMarkdown(text, { width, color: colorize, hyperlinks }));
  return body.length > 0 ? `${body}\n\n` : "";
}

/**
 * The projection stores a tool node's payload as JSON text (and, for a failed
 * call, as `{"error": …}`). Recover the structured result so the tool
 * renderer can use its kind-aware formatters.
 */
function toolResultFromNode(node) {
  const text = node?.text ?? "";
  const payload = parseMaybeJson(text);
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    if (typeof payload.kind === "string") return { result: payload, ok: true };
    if ("error" in payload) {
      const error = payload.error;
      return {
        result: { summary: typeof error === "string" ? error : JSON.stringify(error) },
        ok: false
      };
    }
  }
  return { result: { summary: typeof text === "string" ? text : String(text) }, ok: true };
}

function parseMaybeJson(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function renderAttachments(attachments, colorize) {
  if (!Array.isArray(attachments) || attachments.length === 0) return "";
  const text = attachments
    .map((attachment) => `  📎 ${sanitizeInline(attachment?.name ?? attachment?.id) || "attachment"}`)
    .join("\n");
  return colorize ? style("muted", text) : text;
}

/**
 * Every text body a node carries funnels through here, so this is the P3e-5
 * sanitisation point for the replay routes.
 *
 * The `user` and `system` node bodies are the ones that need it most: they are
 * printed RAW (no Markdown pass), and "the user's own text" is not the same as
 * "text this user typed" — `procway-code -p "$(cat prompt.txt)"`, an `@file`
 * expansion, a resumed session from a shared `.procway/` directory and a
 * branch checkout all put foreign bytes in a `user` node. The assistant body
 * is sanitised again by `renderMarkdown`; doing it here too is free
 * (sanitising is idempotent) and keeps `maxChars` measured on what is shown.
 */
function truncateText(value, maxChars) {
  if (typeof value !== "string") return "";
  const text = sanitizeTerminalText(value);
  if (maxChars == null || !Number.isFinite(maxChars) || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[truncated]`;
}
