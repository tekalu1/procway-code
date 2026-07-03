import { randomUUID } from "node:crypto";

/**
 * @typedef {(
 *   | { kind: "text",        text: string }
 *   | { kind: "tool_use",    toolCallId: string, name: string, args: object }
 *   | { kind: "tool_result", toolCallId: string, result: import("./tool-result.mjs").ToolResult, ok: boolean }
 *   | { kind: "image",       mime: string, dataBase64: string }
 *   | { kind: "file_ref",    path: string, mime?: string, bytes?: number }
 *   | { kind: "attachment_ref", id: string, mime?: string }
 * )} ContentBlock
 *
 * `file_ref` points at a file on the SESSION's own filesystem (e.g. a
 * screenshot taken by view_image). `attachment_ref` points at a dashboard
 * upload by attachment id; its bytes are fetched over HTTP at hydration time
 * (single transport — no shared-volume path contract).
 */

/**
 * @typedef {{
 *   id: string,
 *   sessionId: string,
 *   role: "system" | "user" | "assistant" | "tool",
 *   content: ContentBlock[],
 *   toolCallId?: string,
 *   meta?: { compactedFrom?: string[] }
 * }} Message
 */

export const CONTENT_KINDS = Object.freeze([
  "text",
  "tool_use",
  "tool_result",
  "image",
  "file_ref",
  "attachment_ref"
]);

export const MESSAGE_ROLES = Object.freeze(["system", "user", "assistant", "tool"]);

/**
 * Construct a Message with an auto-generated `id`. `crypto.randomUUID()` is
 * a stand-in for ulid until later phases swap in a real implementation.
 *
 * Phase 2 (phase1_B-2): `sessionId` is now required to keep §2.2 of the
 * commercial-readiness plan honest. AgentSession passes its own `sessionId`
 * for every message it stores; projection helpers thread the sessionId from
 * the originating event.
 *
 * @param {{
 *   role: Message["role"],
 *   sessionId: string,
 *   content: ContentBlock[] | string,
 *   toolCallId?: string,
 *   meta?: Message["meta"],
 *   id?: string
 * }} input
 * @returns {Message}
 */
export function createMessage({ role, sessionId, content, toolCallId, meta, id } = {}) {
  if (!MESSAGE_ROLES.includes(role)) {
    throw new Error(`createMessage: invalid role "${String(role)}"`);
  }
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new TypeError("createMessage: sessionId is required");
  }
  const normalized = normalizeContent(content);
  /** @type {Message} */
  const message = {
    id: typeof id === "string" ? id : randomUUID(),
    sessionId,
    role,
    content: normalized
  };
  if (toolCallId) message.toolCallId = toolCallId;
  if (meta) message.meta = meta;
  return message;
}

/**
 * Join all `text` content blocks of a message into a single string.
 * Non-text blocks are ignored.
 *
 * @param {Message} message
 * @returns {string}
 */
export function messageContentToText(message) {
  if (!message || !Array.isArray(message.content)) return "";
  const parts = [];
  for (const block of message.content) {
    if (block && block.kind === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("");
}

function normalizeContent(content) {
  if (typeof content === "string") {
    return [{ kind: "text", text: content }];
  }
  if (!Array.isArray(content)) {
    throw new TypeError("createMessage: content must be a string or ContentBlock[]");
  }
  return content;
}
