import { stat } from "node:fs/promises";
import path from "node:path";
import { inferImageMime } from "../providers/image-hydration.mjs";

/**
 * `view_image` — let the agent actually SEE an image file from the workspace.
 *
 * The tool itself does not read the bytes: it validates the path and mime and
 * returns a normal text ToolResult plus an `attachments` hint. The turn
 * orchestrator turns that hint into a `file_ref` block on the tool message,
 * and the provider hydration layer inlines the bytes as base64 right before
 * the request (so screenshots saved by web_browser / desktop_action become
 * something the model can inspect, without bloating the session snapshot).
 *
 * @param {{ filePath: string, cwd?: string }} args
 * @returns {Promise<import("../core/types/tool-result.mjs").ToolResult & { attachments: Array<{ path: string, mime: string }> }>}
 */
export async function viewImage({ filePath, cwd = process.cwd() }) {
  if (typeof filePath !== "string" || filePath.trim().length === 0) {
    throw new Error("view_image requires a non-empty 'path'");
  }
  const resolved = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(cwd, filePath);
  const mime = inferImageMime(resolved);
  if (!mime) {
    throw new Error(`Unsupported image type for "${filePath}" (expected png, jpeg, gif, or webp)`);
  }
  const info = await stat(resolved);
  if (!info.isFile()) {
    throw new Error(`Not a file: ${filePath}`);
  }
  return {
    kind: "view_image",
    summary: `Loaded image ${path.basename(resolved)} (${formatBytes(info.size)})`,
    data: { path: resolved, mime, bytes: info.size },
    attachments: [{ path: resolved, mime }]
  };
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
