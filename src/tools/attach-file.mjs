/**
 * attach_file — attach a workspace file to the Procway conversation.
 *
 * The surface-agnostic counterpart to save_attachment: where save_attachment
 * pulls an attachment's bytes DOWN into the workspace, attach_file pushes a
 * workspace file UP into the dashboard attachment store, where it becomes an
 * id-addressed object every surface renders the same way
 * (`GET /api/ai/attachments/<id>` — dashboard thumbnail/download, and any
 * connected surface's reflection such as Slack). The model never names a
 * channel or a surface: it just "attaches a file to the chat"; the runtime
 * emits an outbound attachment and the surfaces deliver it. This is why there
 * is no slack_upload_file — adding a surface needs no new model-facing tool.
 *
 * Bytes travel the single attachment transport (HTTP POST to the dashboard,
 * authenticated with the session's PROCWAY_PROXY_TOKEN); the session never
 * writes to a shared volume, so behavior is identical across runtime engines.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { uploadAttachmentBytes } from "../providers/image-hydration.mjs";

/**
 * Outbound attachment cap. Independent literal (ai-agent must not import from
 * the monorepo — ADR 0030 D2), kept in sync with the dashboard's
 * MAX_UPLOAD_ATTACHMENT_BYTES (50MB).
 */
const MAX_ATTACH_BYTES = 50 * 1024 * 1024;

const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

// Minimal extension→mime map so images register as kind 'image' (dashboard
// thumbnail) and common documents carry a sensible type. Anything unknown
// falls back to application/octet-stream (kind 'file', download link).
const MIME_BY_EXT = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".xml": "application/xml",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar"
});

function inferMime(filename) {
  const ext = path.extname(typeof filename === "string" ? filename : "").toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

export async function attachFile({
  filePath,
  name,
  comment,
  cwd = process.cwd(),
  dashboardUrl = process.env.PROCWAY_DASHBOARD_URL,
  proxyToken = process.env.PROCWAY_PROXY_TOKEN,
  sessionId = process.env.PROCWAY_SESSION_ID,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS
} = {}) {
  if (!filePath || !String(filePath).trim()) throw new Error("filePath is required");

  // Same containment rule as save_attachment / write_file: the source must
  // stay inside the workspace (cwd).
  const root = path.resolve(cwd);
  const resolved = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(root, filePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Path escapes workspace: ${filePath}`);
  }

  const info = await stat(resolved).catch(() => null);
  if (!info || !info.isFile()) throw new Error(`File not found: ${filePath}`);
  if (info.size === 0) throw new Error(`File is empty: ${filePath}`);
  if (info.size > MAX_ATTACH_BYTES) {
    throw new Error(`File too large: ${info.size} bytes (max ${MAX_ATTACH_BYTES})`);
  }

  const filename = typeof name === "string" && name.trim() ? name.trim() : path.basename(resolved);
  const mime = inferMime(filename);
  const buf = await readFile(resolved);

  const { id, mime: storedMime, bytes } = await uploadAttachmentBytes(buf, {
    filename, mime, sessionId, dashboardUrl, proxyToken, fetchImpl, timeoutMs
  });

  const effectiveMime = storedMime || mime;
  return {
    kind: "attach_file",
    summary: `Attached ${filename} (${bytes} bytes) to the conversation`,
    data: { id, name: filename, mime: effectiveMime, bytes, ...(comment ? { comment } : {}) },
    // Hint consumed by turn-orchestrator.appendToolResult: turns into an
    // outbound attachment_ref block on the tool message and an
    // `attachment.produced` event for live surface delivery.
    outboundAttachments: [{ id, mime: effectiveMime, name: filename, ...(comment ? { comment } : {}) }]
  };
}
