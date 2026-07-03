// TK-6: pure Markdown projection of a session transcript, written alongside
// snapshot.json so the procway reviewer can read a single small file instead
// of parsing the raw events.jsonl (which can run to ~500KB+ per worker run
// and uses different shapes across runners).
//
// Contract:
//   renderTranscriptMarkdown({ sessionId, messages, meta? }) -> string
//   writeTranscriptMarkdown({ homeDir, sessionId, messages, meta?, encryptionKey? }) -> Promise<{ filePath, skipped } | { filePath, bytes }>
//
// When `encryptionKey` is set we skip the write — transcript.md is plaintext
// by design, and re-emitting a plaintext copy of an encrypted session would
// defeat the encryption-at-rest opt-in. The reviewer falls back to events.jsonl
// in that case (which is itself encryption-aware).

import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { transcriptFromMessages } from "../core/projections/transcript.mjs";
import { getSessionDir } from "./store.mjs";

const DEFAULT_MAX_MESSAGES = 500;
// Tool results / pasted blobs can be enormous (e.g. the reviewer reading a
// worker's events.jsonl in a previous incident). Tighten the per-block cap so
// the reviewer never has to scroll through a 200KB tool result rendered in
// full — they can drop down to events.jsonl for the gory detail if needed.
const DEFAULT_MAX_BLOCK_CHARS = 4000;

export function renderTranscriptMarkdown({
  sessionId,
  messages,
  meta = null,
  maxMessages = DEFAULT_MAX_MESSAGES,
  maxBlockChars = DEFAULT_MAX_BLOCK_CHARS,
} = {}) {
  const nodes = transcriptFromMessages(messages, { maxMessages });
  const lines = [];
  lines.push(`# Session transcript`);
  lines.push("");
  if (sessionId) lines.push(`- sessionId: \`${sessionId}\``);
  if (meta?.cwd) lines.push(`- cwd: \`${meta.cwd}\``);
  if (meta?.provider) lines.push(`- provider: \`${meta.provider}\``);
  if (meta?.model) lines.push(`- model: \`${meta.model}\``);
  if (meta?.createdAt) lines.push(`- createdAt: \`${meta.createdAt}\``);
  if (meta?.updatedAt) lines.push(`- updatedAt: \`${meta.updatedAt}\``);
  lines.push(`- messageCount: ${Array.isArray(messages) ? messages.length : 0}`);
  lines.push(`- transcriptNodeCount: ${nodes.length}`);
  lines.push("");
  lines.push("---");
  lines.push("");
  if (nodes.length === 0) {
    lines.push("_(no messages projected)_");
    lines.push("");
    return lines.join("\n");
  }
  for (const node of nodes) {
    lines.push(renderNode(node, { maxBlockChars }));
    lines.push("");
  }
  return lines.join("\n");
}

function renderNode(node, { maxBlockChars }) {
  if (node.kind === "user") {
    return `## You\n\n${fenceIfMultiline(truncate(node.text, maxBlockChars))}`;
  }
  if (node.kind === "assistant") {
    return `## Assistant\n\n${truncate(node.text, maxBlockChars)}`;
  }
  if (node.kind === "assistant-tool-calls") {
    const lines = ["## Assistant — tool calls", ""];
    for (const call of node.toolCalls) {
      const args = safeStringify(call.args);
      lines.push(
        `- \`${call.name}\`${call.toolCallId ? ` _(id: ${call.toolCallId})_` : ""}\n` +
        "  ```json\n" +
        indent(truncate(args, maxBlockChars), "  ") + "\n" +
        "  ```"
      );
    }
    return lines.join("\n");
  }
  if (node.kind === "tool") {
    const idHint = node.toolCallId ? ` _(id: ${node.toolCallId})_` : "";
    return `## Tool result${idHint}\n\n${fenceIfMultiline(truncate(node.text, maxBlockChars))}`;
  }
  return `## ${escapeHeader(String(node.role || node.kind || "unknown"))}\n\n${truncate(node.text, maxBlockChars)}`;
}

function truncate(value, maxChars) {
  if (typeof value !== "string") return safeStringify(value);
  if (!Number.isFinite(maxChars) || maxChars <= 0) return value;
  if (value.length <= maxChars) return value;
  const head = value.slice(0, maxChars);
  return `${head}\n…[truncated ${value.length - maxChars} chars — see events.jsonl for full payload]`;
}

function fenceIfMultiline(text) {
  if (typeof text !== "string") text = safeStringify(text);
  // Plain text bodies that contain newlines or fence markers are safer rendered
  // inside a fenced block so the reviewer's Markdown viewer doesn't reflow
  // them. Single-line bodies stay inline so casual scanning is still pleasant.
  if (!text.includes("\n") && !text.includes("```")) return text;
  // Pick a fence length that's longer than any run inside the body so we don't
  // accidentally close the fence early on nested code.
  const longestRun = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longestRun + 1);
  return `${fence}\n${text}\n${fence}`;
}

function indent(text, prefix) {
  return text.split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function safeStringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function escapeHeader(text) {
  return text.replace(/\n+/g, " ").trim();
}

export function transcriptPath({ homeDir = os.homedir(), sessionId } = {}) {
  return path.join(getSessionDir({ homeDir, sessionId }), "transcript.md");
}

export async function writeTranscriptMarkdown({
  homeDir = os.homedir(),
  sessionId,
  messages,
  meta = null,
  encryptionKey = null,
} = {}) {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new TypeError("writeTranscriptMarkdown: sessionId is required");
  }
  const filePath = transcriptPath({ homeDir, sessionId });
  if (encryptionKey) {
    // Encryption-at-rest is opt-in; emitting a plaintext transcript would
    // silently defeat it. Reviewer falls back to events.jsonl in this case.
    return { filePath, skipped: "encrypted-session" };
  }
  const markdown = renderTranscriptMarkdown({ sessionId, messages, meta });
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, markdown, "utf8");
  return { filePath, bytes: Buffer.byteLength(markdown, "utf8") };
}
