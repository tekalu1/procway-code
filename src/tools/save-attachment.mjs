/**
 * save_attachment — materialize a dashboard attachment into the session
 * workspace as a real file.
 *
 * Attachments (chat-UI uploads, Slack files, any future ingress) live in the
 * dashboard's attachment store and reach the session ONLY over HTTP
 * (`GET $PROCWAY_DASHBOARD_URL/api/ai/attachments/<id>`, the single
 * transport — same endpoint the provider hydration layer uses). Hydration
 * makes images VISIBLE to the model but leaves no file on disk; this tool is
 * the counterpart that gives the session the BYTES, so it can re-upload,
 * edit, convert, or archive the original. Attachment ids arrive in the user
 * message next to the attachment refs (conversation.mjs appends a note).
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fetchAttachmentBytes } from "../providers/image-hydration.mjs";

/** Defensive cap — ingress paths already cap uploads well below this. */
const MAX_SAVE_BYTES = 50 * 1024 * 1024;

const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export async function saveAttachment({
  attachmentId,
  filePath,
  cwd = process.cwd(),
  dashboardUrl = process.env.PROCWAY_DASHBOARD_URL,
  proxyToken = process.env.PROCWAY_PROXY_TOKEN,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS
} = {}) {
  const id = typeof attachmentId === "string" ? attachmentId.trim() : "";
  if (!id) throw new Error("attachmentId is required");
  if (!filePath || !String(filePath).trim()) throw new Error("filePath is required");

  // Same containment rule as write_file: the destination must stay inside
  // the workspace (cwd).
  const root = path.resolve(cwd);
  const resolved = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(root, filePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Path escapes workspace: ${filePath}`);
  }

  const { buf, contentType } = await fetchAttachmentBytes(id, {
    dashboardUrl, proxyToken, fetchImpl, timeoutMs
  });
  if (buf.length > MAX_SAVE_BYTES) {
    throw new Error(`attachment ${id} is ${buf.length} bytes (max ${MAX_SAVE_BYTES})`);
  }

  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, buf);

  return {
    kind: "save_attachment",
    summary: `Saved attachment ${id} (${buf.length} bytes) to ${filePath}`,
    data: { path: resolved, bytes: buf.length, mime: contentType }
  };
}
