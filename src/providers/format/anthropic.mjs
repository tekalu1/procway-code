/**
 * Anthropic Messages API format adapters.
 *
 * Internal canonical form: `Message[]` from `core/types/message.mjs`.
 * Anthropic's Messages API splits the system prompt out of the messages
 * array and represents tool use / tool results as content blocks. This
 * module isolates the conversion so `core/` stays provider-agnostic.
 */
import { isInlineImageBlock } from "../image-hydration.mjs";

/**
 * Convert internal Message[] (or legacy raw messages) into the shape the
 * Anthropic Messages API expects.
 *
 * @param {Array<import("../../core/types/message.mjs").Message | object>} messages
 * @returns {{ system: string, anthropicMessages: Array<object> }}
 */
export function toAnthropicMessages(messages = []) {
  const systemParts = [];
  const anthropicMessages = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "system") {
      const text = extractText(message);
      if (text) systemParts.push(text);
      continue;
    }
    if (message.role === "tool") {
      // Anthropic accepts a string OR an array of blocks as tool_result
      // content. When the tool surfaced images (e.g. view_image), inline them
      // alongside the text payload so the model actually sees them — Anthropic
      // supports image blocks inside tool_result.
      const images = collectInlineImages(message);
      const resultText = extractToolResultText(message);
      anthropicMessages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: message.tool_call_id ?? message.toolCallId ?? extractToolCallId(message),
          content: images.length > 0
            ? [{ type: "text", text: resultText }, ...images.map(toAnthropicImageBlock)]
            : resultText
        }]
      });
      continue;
    }
    if (message.role === "assistant") {
      const toolUses = extractAssistantToolUses(message);
      if (toolUses.length > 0) {
        // Extended thinking: when a tool-use turn was produced with thinking
        // enabled, Anthropic requires the original thinking block (verbatim,
        // with its signature) to lead the assistant content on the follow-up
        // request. We persisted it on meta in the turn orchestrator.
        const thinkingBlock = extractThinkingBlock(message);
        anthropicMessages.push({
          role: "assistant",
          content: [
            ...(thinkingBlock ? [thinkingBlock] : []),
            ...toolUses.map((toolUse) => ({
              type: "tool_use",
              id: toolUse.id,
              name: toolUse.name,
              input: toolUse.args ?? {}
            }))
          ]
        });
        continue;
      }
      anthropicMessages.push({
        role: "assistant",
        content: extractText(message)
      });
      continue;
    }
    if (message.role === "user") {
      // A user turn may carry attached images (hydrated to inline `image`
      // blocks upstream). With images, emit a content-block array; otherwise
      // keep the plain string for back-compat with existing snapshots/tests.
      const images = collectInlineImages(message);
      if (images.length > 0) {
        const text = textBlocksOnly(message);
        anthropicMessages.push({
          role: "user",
          content: [
            ...(text ? [{ type: "text", text }] : []),
            ...images.map(toAnthropicImageBlock)
          ]
        });
      } else {
        anthropicMessages.push({
          role: "user",
          content: extractText(message)
        });
      }
    }
  }
  return {
    system: systemParts.filter(Boolean).join("\n\n"),
    anthropicMessages: repairToolResultPairs(anthropicMessages)
  };
}

/**
 * Reconcile `tool_use` / `tool_result` pairs so the request satisfies the
 * Messages API contract. Same repair as the OpenAI-side
 * repairToolMessagePairs (format/openai.mjs) and the codex
 * repairOrphanFunctionCalls; the API rejects two kinds of orphan:
 *
 *   1. An assistant `tool_use` block with no `tool_result` in the next user
 *      turn → 400 "tool_use ids were found without tool_result blocks
 *      immediately after". Filled with a synthesized is_error result. This is
 *      the mid-tool crash failure mode: the session process died between
 *      `assistant.message.completed` (tool_use durably event-logged before
 *      tools run) and `tool.call.completed`, so resume rebuilds the history
 *      with the call permanently unanswered and every subsequent turn 400s.
 *
 *   2. A `tool_result` block whose `tool_use_id` has no matching assistant
 *      `tool_use` → 400 "unexpected tool_use_id". Dropped (the carrying user
 *      message is dropped too when nothing else remains). This salvages
 *      sessions where compaction split a pair before
 *      compactor.resolveTailStart was in place.
 *
 * The synthesized result is pushed as its own user message right after the
 * assistant turn; any surviving real results follow as further user messages.
 * The Messages API merges consecutive same-role turns, which the converter
 * already relies on (each internal tool message becomes its own user message).
 */
function repairToolResultPairs(messages) {
  // Position-aware first pass: a result only counts when its tool_use has
  // already been seen. A result that surfaces BEFORE its call (event-log
  // append used to be unserialized, so near-simultaneous events could land
  // on disk out of order and resume projects file order) is rejected by the
  // API just like a true orphan — treat it as one and let the placeholder
  // fill the call in.
  const seenUses = new Set();
  const answeredIds = new Set();
  for (const message of messages) {
    const blocks = Array.isArray(message?.content) ? message.content : [];
    for (const block of blocks) {
      if (message.role === "assistant" && block?.type === "tool_use" && typeof block.id === "string") {
        seenUses.add(block.id);
      }
      if (message.role === "user" && block?.type === "tool_result"
          && typeof block.tool_use_id === "string" && seenUses.has(block.tool_use_id)) {
        answeredIds.add(block.tool_use_id);
      }
    }
  }

  const seenUsesInOrder = new Set();
  const out = [];
  for (const message of messages) {
    const blocks = Array.isArray(message?.content) ? message.content : [];
    if (message.role === "user" && blocks.some((block) => block?.type === "tool_result")) {
      // Orphan result (no originating tool_use, or one that only appears
      // later in the stream): drop the block; drop the whole message when
      // nothing else remains.
      const kept = blocks.filter((block) =>
        !(block?.type === "tool_result"
          && (typeof block.tool_use_id !== "string" || !seenUsesInOrder.has(block.tool_use_id)))
      );
      if (kept.length === 0) continue;
      out.push(kept.length === blocks.length ? message : { ...message, content: kept });
      continue;
    }
    out.push(message);
    // Unanswered call: synthesize a placeholder result directly after the
    // assistant turn.
    if (message.role === "assistant") {
      for (const block of blocks) {
        if (block?.type === "tool_use" && typeof block.id === "string") seenUsesInOrder.add(block.id);
      }
      const missing = blocks.filter((block) =>
        block?.type === "tool_use" && typeof block.id === "string" && !answeredIds.has(block.id)
      );
      if (missing.length === 0) continue;
      out.push({
        role: "user",
        content: missing.map((block) => ({
          type: "tool_result",
          tool_use_id: block.id,
          is_error: true,
          content: JSON.stringify({
            error: "tool result missing (worker reaped or interrupted before completion)",
            tool: block.name ?? null,
            synthesized: true
          })
        }))
      });
      // Mark as covered so a duplicate tool_use id later in the stream
      // doesn't double-fill.
      for (const block of missing) answeredIds.add(block.id);
    }
  }
  return out;
}

/**
 * Normalize Anthropic response content blocks into our canonical shapes.
 * Returns `{ text, toolCalls }` so callers can decide which Message they
 * are building.
 *
 * @param {Array<object> | null | undefined} contentBlocks
 * @returns {{ text: string, toolCalls: Array<{ id: string, name: string, args: object }> }}
 */
export function fromAnthropicContent(contentBlocks) {
  const blocks = Array.isArray(contentBlocks) ? contentBlocks : [];
  const textParts = [];
  const toolCalls = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        args: block.input ?? {}
      });
    }
  }
  return { text: textParts.join(""), toolCalls };
}

/**
 * Convert internal tool definitions into Anthropic's `tools` payload.
 *
 * @param {Array<object>} tools
 * @returns {Array<object>}
 */
export function toAnthropicTools(tools = [], { cacheControl = true } = {}) {
  return tools.map((tool, index) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
    // Prompt-cache breakpoint on the LAST tool definition: the tool block is
    // byte-stable across rounds (deferred loads only APPEND), so every round
    // after the first reads it at ~10% input price on Anthropic. GA feature —
    // no beta header needed. Inert for non-Anthropic providers (this
    // formatter only runs for type:"anthropic").
    ...(cacheControl && index === tools.length - 1 ? { cache_control: { type: "ephemeral" } } : {})
  }));
}

/**
 * Prompt-cache breakpoints over the message history (2026-06-07 audit ④).
 *
 * The big byte-stable worker prompt (fundamental-rules + task SKILL +
 * checklist, ~25-38KB) is NOT in the `system` block — build-prompt.mjs ships
 * it as the FIRST USER message (run-task → prompt-builder), and the actual
 * system block is small and varies (cwd/root entries). So the two breakpoints
 * that matter are:
 *   1. the first user message — caches the static prefix incl. tools/system;
 *   2. the last message — the standard rolling breakpoint so each round
 *      re-reads the whole previous conversation from cache.
 * Stale-tool-result condensation only ever rewrites messages once (older
 * than the keepRecent boundary), so the long prefix stays byte-stable.
 * Operates on the FINAL anthropic-shaped array; blocks are converted from
 * string form where needed. Mutates the (freshly built) array in place.
 */
export function applyPromptCacheBreakpoints(anthropicMessages = []) {
  if (!Array.isArray(anthropicMessages) || anthropicMessages.length === 0) return anthropicMessages;
  const firstUserIndex = anthropicMessages.findIndex((m) => m?.role === "user");
  const targets = new Set([firstUserIndex, anthropicMessages.length - 1]);
  targets.delete(-1);
  for (const index of targets) {
    const message = anthropicMessages[index];
    if (typeof message.content === "string") {
      message.content = [{ type: "text", text: message.content }];
    }
    if (!Array.isArray(message.content) || message.content.length === 0) continue;
    const last = message.content[message.content.length - 1];
    // thinking blocks reject extra fields; text/tool_use/tool_result/image all
    // accept cache_control.
    if (last && typeof last === "object" && last.type !== "thinking") {
      message.content[message.content.length - 1] = { ...last, cache_control: { type: "ephemeral" } };
    }
  }
  return anthropicMessages;
}

function extractText(message) {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  const parts = [];
  for (const block of message.content) {
    if (block?.kind === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.length > 0 ? parts.join("") : JSON.stringify(message.content);
}

/**
 * Join only `text` blocks, with no JSON fallback. Used when a message also
 * carries image blocks — there the JSON fallback in extractText() would
 * stringify the (base64) image content into the text, which we must avoid.
 */
function textBlocksOnly(message) {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  const parts = [];
  for (const block of message.content) {
    if (block?.kind === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("");
}

function collectInlineImages(message) {
  if (!Array.isArray(message?.content)) return [];
  return message.content.filter(isInlineImageBlock);
}

function toAnthropicImageBlock(block) {
  return {
    type: "image",
    source: { type: "base64", media_type: block.mime, data: block.dataBase64 }
  };
}

function extractAssistantToolUses(message) {
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return message.tool_calls.map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.function?.name ?? toolCall.name,
      args: parseJsonArgs(toolCall.function?.arguments)
    }));
  }
  if (Array.isArray(message.content)) {
    return message.content
      .filter((block) => block?.kind === "tool_use")
      .map((block) => ({
        id: block.toolCallId,
        name: block.name,
        args: block.args ?? {}
      }));
  }
  return [];
}

function extractThinkingBlock(message) {
  const meta = message?.meta;
  if (!meta || typeof meta !== "object") return null;
  const thinking = meta.reasoningContent;
  const signature = meta.reasoningSignature;
  // A thinking block is only valid for echo when it carries the signature
  // Anthropic issued; without it the API rejects the request, so skip.
  if (typeof thinking !== "string" || thinking.length === 0) return null;
  if (typeof signature !== "string" || signature.length === 0) return null;
  return { type: "thinking", thinking, signature };
}

function extractToolResultText(message) {
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

function parseJsonArgs(value) {
  if (typeof value !== "string") return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
