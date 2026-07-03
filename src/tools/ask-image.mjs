import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { inferImageMime, DEFAULT_MAX_IMAGE_BYTES } from "../providers/image-hydration.mjs";
import { runProvider } from "../providers/index.mjs";
import { resolveVisionProviderId, runVisionOneShot } from "../providers/vision.mjs";

/**
 * `ask_image` — ask the configured vision provider a question about an image
 * file and return its answer as text.
 *
 * Unlike `view_image` (which routes the image into the conversation via a
 * `file_ref` block, for vision-capable main models), this tool is fully
 * self-contained: the image bytes go to the vision provider in a one-shot
 * call and ONLY the answer text enters the conversation. That keeps text-only
 * main models (deepseek-v4 etc.) usable with screenshots/diagrams, keeps the
 * session snapshot small, and bounds vision-model cost to one call per
 * question.
 *
 * Path/mime/size validation mirrors view_image. A missing vision provider
 * degrades to an informative ToolResult (not a throw) so the model can tell
 * the user to configure `settings.visionProvider`.
 *
 * @param {{
 *   filePath: string,
 *   prompt: string,
 *   cwd?: string,
 *   settings?: object,
 *   runProviderImpl?: Function,
 *   signal?: AbortSignal
 * }} args
 * @returns {Promise<import("../core/types/tool-result.mjs").ToolResult>}
 */
export async function askImage({ filePath, prompt, cwd = process.cwd(), settings = {}, runProviderImpl = runProvider, signal }) {
  if (typeof filePath !== "string" || filePath.trim().length === 0) {
    throw new Error("ask_image requires a non-empty 'path'");
  }
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new Error("ask_image requires a non-empty 'prompt'");
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
  const maxBytes = settings?.attachments?.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  if (info.size > maxBytes) {
    throw new Error(`Image ${filePath} is ${info.size} bytes, exceeding the ${maxBytes} byte limit`);
  }
  if (!resolveVisionProviderId(settings)) {
    return {
      kind: "ask_image",
      summary: "No vision provider configured",
      data: {
        path: resolved,
        prompt,
        skipped: true,
        error: "No vision provider is configured (settings.visionProvider). Ask the user to set one in AI settings."
      }
    };
  }
  const buf = await readFile(resolved);
  const answer = await runVisionOneShot({
    settings,
    prompt,
    images: [{ mime, dataBase64: buf.toString("base64") }],
    runProviderImpl,
    cwd,
    signal
  });
  return {
    kind: "ask_image",
    summary: truncate(answer),
    data: { path: resolved, mime, bytes: info.size, prompt, answer }
  };
}

function truncate(text, max = 120) {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= max ? single : `${single.slice(0, max - 3)}...`;
}
