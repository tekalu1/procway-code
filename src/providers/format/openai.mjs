/**
 * OpenAI / OpenAI-compatible message format adapters.
 *
 * Internal canonical form: `Message[]` from `core/types/message.mjs` with
 * `content: ContentBlock[]`. The OpenAI Chat Completions API expects flat
 * `{ role, content, tool_calls?, tool_call_id? }` shapes — this module
 * isolates the conversion so `core/` stays provider-agnostic.
 *
 * For backward compatibility (existing callers, persisted state.json from
 * Phase 1) the converter also accepts the legacy raw shape where
 * `content` is a string. Phase 4 will tighten this once persistence is
 * fully migrated.
 */
import { isInlineImageBlock, imageBlockToDataUrl } from "../image-hydration.mjs";
import { parseToolArgs, stripInvalidToolArgs } from "./tool-args.mjs";

/**
 * Convert internal Message[] (or legacy raw messages) into the OpenAI
 * Chat Completions request shape.
 *
 * `opts.echoReasoning` controls whether the previous assistant turn's
 * `reasoning_content` is echoed back on subsequent requests. DeepSeek
 * thinking-mode requires this (SiliconFlow error 20015 otherwise), but
 * Cerebras and most other OpenAI-compatible providers reject it as an
 * unsupported request property. Defaults to false; opt in per-provider.
 *
 * @param {Array<import("../../core/types/message.mjs").Message | object>} messages
 * @param {{ echoReasoning?: boolean }} [opts]
 * @returns {Array<object>}
 */
/**
 * An INTERNAL assistant message that carries NOTHING the wire API accepts — no
 * tool_use blocks, no visible text, and no reasoning to preserve. Serialized,
 * it becomes { role: 'assistant', content: null }, which DeepSeek-direct
 * rejects with 400 "Invalid assistant message: content or tool_calls must be
 * set". This happens when a model returns an empty round (e.g. a weak model on
 * a read-only turn with no write tools left to call). It carries zero info, so
 * dropping it from the request is safe — it never holds tool_use, so it cannot
 * break tool-call pairing, and the full payload still lives in session.messages
 * / events.jsonl untouched. Reasoning-only turns (meta.reasoningContent set)
 * are KEPT: they must round-trip for the DeepSeek thinking-mode contract.
 */
function isEmptyAssistantNoise(message) {
  if (!message || message.role !== "assistant") return false;
  if (typeof message.meta?.reasoningContent === "string" && message.meta.reasoningContent.length > 0) return false;
  const content = message.content;
  if (typeof content === "string") return content.trim().length === 0;
  if (Array.isArray(content)) {
    return !content.some((block) =>
      block?.kind === "tool_use"
      || (block?.kind === "text" && typeof block.text === "string" && block.text.trim().length > 0)
      // any non-text/non-tool block (images etc.) is also meaningful
      || (block?.kind && block.kind !== "text" && block.kind !== "tool_use"));
  }
  return content == null; // no content at all
}

export function toOpenAiMessages(messages = [], opts = {}) {
  const out = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    // Drop degenerate empty assistant turns so they can't trip a provider's
    // "content or tool_calls must be set" 400 (see helper). Done at the
    // internal level so reasoning-only turns (meta.reasoningContent) survive.
    if (isEmptyAssistantNoise(message)) continue;
    const converted = toOpenAiMessage(message, opts);
    // A single internal message may expand into multiple wire messages (a
    // tool result that carries images becomes the tool message plus a
    // follow-up user message holding the image_url parts).
    if (Array.isArray(converted)) out.push(...converted);
    else out.push(converted);
  }
  return repairToolMessagePairs(out);
}

/**
 * Reconcile assistant `tool_calls` / `role:"tool"` reply pairs so the request
 * satisfies the Chat Completions contract. Mirrors the codex Responses-API
 * repair (openai-codex.mjs repairOrphanFunctionCalls); the API rejects two
 * kinds of orphan:
 *
 *   1. An assistant `tool_calls` entry with no `role:"tool"` reply
 *      → 400 "An assistant message with 'tool_calls' must be followed by tool
 *      messages responding to each 'tool_call_id'". Filled with a synthesized
 *      error reply. This is the mid-tool crash failure mode: the session
 *      process died between `assistant.message.completed` (tool_use durably
 *      event-logged before tools run) and `tool.call.completed`, so resume
 *      rebuilds the history with the call permanently unanswered and every
 *      subsequent turn 400s.
 *
 *   2. A `role:"tool"` message whose `tool_call_id` has no matching assistant
 *      `tool_calls` entry → 400 "messages with role 'tool' must be a response
 *      to a preceding message with 'tool_calls'". Dropped. This salvages
 *      sessions where compaction split a tool_use/tool_result pair before
 *      compactor.resolveTailStart was in place.
 */
function repairToolMessagePairs(messages) {
  // Position-aware first pass: a reply only counts when its call has already
  // been seen. A reply that surfaces BEFORE its call (event-log append used
  // to be unserialized, so near-simultaneous events could land on disk out of
  // order and resume projects file order) is rejected by the API just like a
  // true orphan — treat it as one and let the placeholder fill the call in.
  const seenCalls = new Set();
  const answeredIds = new Set();
  const droppedIndices = new Set();
  messages.forEach((message, index) => {
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        if (typeof toolCall?.id === "string") seenCalls.add(toolCall.id);
      }
    } else if (message.role === "tool") {
      if (typeof message.tool_call_id === "string" && seenCalls.has(message.tool_call_id)) {
        answeredIds.add(message.tool_call_id);
      } else {
        droppedIndices.add(index);
      }
    }
  });

  const out = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    // Orphan reply (no originating tool_calls entry, or one that only
    // appears later in the stream): drop.
    if (droppedIndices.has(index)) continue;
    out.push(message);
    // Unanswered call: synthesize a placeholder reply directly after the
    // assistant message. Real replies (if any survived) follow right behind,
    // so all tool messages stay contiguous after their tool_calls message.
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        const id = toolCall?.id;
        if (typeof id !== "string" || answeredIds.has(id)) continue;
        out.push({
          role: "tool",
          tool_call_id: id,
          content: JSON.stringify({
            error: "tool result missing (worker reaped or interrupted before completion)",
            tool: toolCall.function?.name ?? null,
            synthesized: true
          })
        });
        // Mark as covered so a duplicate tool_calls id later in the stream
        // doesn't double-fill.
        answeredIds.add(id);
      }
    }
  }
  return out;
}

function toOpenAiMessage(message, opts = {}) {
  const role = message.role;
  if (role === "tool") {
    const toolMessage = {
      role: "tool",
      tool_call_id: message.tool_call_id ?? message.toolCallId ?? extractToolCallId(message),
      content: extractToolMessageContentString(message)
    };
    // Chat Completions tool messages are text-only; surface any tool images
    // as a follow-up user message (image_url parts) right after the output.
    const images = collectInlineImages(message);
    if (images.length === 0) return toolMessage;
    return [toolMessage, {
      role: "user",
      content: [
        { type: "text", text: "[view_image] image(s) from the preceding tool result:" },
        ...images.map(toOpenAiImagePart)
      ]
    }];
  }
  if (role === "assistant") {
    // DeepSeek thinking-mode contract (SiliconFlow error 20015): the
    // reasoning_content from the previous assistant turn must be echoed back
    // on subsequent requests, otherwise the upstream rejects with HTTP 400.
    // Persisted on Message.meta.reasoningContent by turn-orchestrator.
    // Opt-in via provider.echoReasoning because Cerebras and most others
    // reject reasoning_content on the request side.
    const reasoning = opts.echoReasoning === true && typeof message.meta?.reasoningContent === "string"
      ? message.meta.reasoningContent
      : null;
    const toolCalls = extractAssistantToolCalls(message);
    if (toolCalls.length > 0) {
      const text = extractAssistantText(message);
      return {
        role: "assistant",
        content: text || null,
        tool_calls: toolCalls.map((toolUse) => ({
          id: toolUse.id ?? toolUse.toolCallId,
          type: "function",
          function: {
            name: toolUse.name,
            // Never re-send the invalid-args marker (e.g. from parseToolArgs on
            // broken legacy `arguments`, or a pre-fix persisted session) — record
            // it as an empty object so the model sees `{}` + the ok:false result.
            arguments: typeof toolUse.arguments === "string"
              ? toolUse.arguments
              : JSON.stringify(stripInvalidToolArgs(toolUse.args ?? toolUse.arguments ?? {}))
          }
        })),
        ...(reasoning ? { reasoning_content: reasoning } : {})
      };
    }
    return {
      role: "assistant",
      // `|| null` mirrors the tool-call branch above: a reasoning-only assistant
      // turn (deepseek-v4-pro and similar can emit reasoning with empty visible
      // text) must serialize as content:null, not "". Some OpenAI-compatible
      // upstreams (OpenRouter routings) reject or mishandle an empty-string
      // assistant content in the next turn's history, which can stall the
      // follow-up request.
      content: extractTextOrLegacy(message) || null,
      ...(reasoning ? { reasoning_content: reasoning } : {})
    };
  }
  // system / user / fallback. A user turn may carry attached images
  // (hydrated to inline `image` blocks upstream) — emit the multimodal
  // content-part array in that case, else keep the plain string.
  const images = collectInlineImages(message);
  if (images.length > 0) {
    const text = extractTextOrLegacy(message);
    return {
      role,
      content: [
        ...(text ? [{ type: "text", text }] : []),
        ...images.map(toOpenAiImagePart)
      ]
    };
  }
  return { role, content: extractTextOrLegacy(message) };
}

function collectInlineImages(message) {
  if (!Array.isArray(message?.content)) return [];
  return message.content.filter(isInlineImageBlock);
}

function toOpenAiImagePart(block) {
  return { type: "image_url", image_url: { url: imageBlockToDataUrl(block) } };
}

/**
 * Normalize a tool call returned by an OpenAI-style response into the
 * canonical `{ id, name, args }` shape used internally.
 *
 * @param {object} toolCall
 * @param {{ truncated?: boolean }} [opts] `truncated` when the response
 *   finished on `length` (max output tokens), so unparseable args are the
 *   likely victim of a cut-off.
 * @returns {{ id: string, name: string, args: object } | null}
 */
export function fromOpenAiToolCall(toolCall, { truncated = false } = {}) {
  if (!toolCall || typeof toolCall !== "object") return null;
  const id = toolCall.id;
  const name = toolCall.function?.name;
  if (!id || !name) return null;
  // parseToolArgs handles all cases: "" / undefined → {} (a no-arg call),
  // valid JSON → object, unparseable → invalid-args marker. An empty-string
  // arguments (how the streaming aggregator initializes a no-arg call) must NOT
  // be flagged invalid — only genuinely malformed/truncated JSON is.
  return { id, name, args: parseToolArgs(toolCall.function?.arguments, { truncated }) };
}

/**
 * Normalize a list of OpenAI tool calls.
 *
 * @param {Array<object> | null | undefined} toolCalls
 * @param {{ truncated?: boolean }} [opts]
 * @returns {Array<{ id: string, name: string, args: object }>}
 */
export function normalizeOpenAiToolCalls(toolCalls, { truncated = false } = {}) {
  if (!Array.isArray(toolCalls)) return [];
  const out = [];
  for (const toolCall of toolCalls) {
    const normalized = fromOpenAiToolCall(toolCall, { truncated });
    if (normalized) out.push(normalized);
  }
  return out;
}

/**
 * Coerce assorted OpenAI `message.content` shapes (string, array of parts,
 * reasoning/refusal fallbacks) into a plain text string.
 *
 * @param {unknown} content
 * @param {object} [message]
 * @returns {string}
 */
export function normalizeOpenAiContent(content, message = {}) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (typeof part?.text === "string") return part.text;
      if (typeof part?.content === "string") return part.content;
      return "";
    }).join("");
  }
  if (typeof message.reasoning === "string") return message.reasoning;
  if (typeof message.refusal === "string") return message.refusal;
  return "";
}

function extractTextOrLegacy(message) {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  const parts = [];
  for (const block of message.content) {
    if (block?.kind === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("");
}

function extractAssistantText(message) {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  const parts = [];
  for (const block of message.content) {
    if (block?.kind === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("");
}

function extractAssistantToolCalls(message) {
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return message.tool_calls.map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.function?.name ?? toolCall.name,
      arguments: toolCall.function?.arguments,
      args: undefined
    }));
  }
  if (Array.isArray(message.content)) {
    return message.content
      .filter((block) => block?.kind === "tool_use")
      .map((block) => ({
        id: block.toolCallId,
        name: block.name,
        args: block.args
      }));
  }
  return [];
}

function extractToolMessageContentString(message) {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  for (const block of message.content) {
    if (block?.kind === "tool_result") {
      const payload = block.ok === false
        ? { error: block.result?.error ?? block.result }
        : block.result;
      return JSON.stringify(payload ?? null);
    }
    if (block?.kind === "text" && typeof block.text === "string") return block.text;
  }
  return "";
}

function extractToolCallId(message) {
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block?.kind === "tool_result" && typeof block.toolCallId === "string") {
        return block.toolCallId;
      }
    }
  }
  return undefined;
}
