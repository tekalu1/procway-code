/**
 * Vision delegation seam (main AI + vision AI split).
 *
 * Some default providers run text-only models (e.g. deepseek-v4) that 400 on
 * image parts. `settings.visionProvider` names a second, vision-capable
 * provider used ONLY to answer questions about images:
 *
 *  - the `ask_image` tool (agent asks a targeted question about an image file)
 *  - attachment auto-describe in image-delegation.mjs (user uploads an image
 *    while the main model is text-only)
 *
 * Both run a one-shot, tool-less, non-streaming provider call against the
 * vision provider; the main conversation never changes provider. The
 * `runProviderImpl` parameter mirrors the llm-summary compactor's injection
 * pattern so this module never imports providers/index.mjs (no import cycle).
 */
import { randomUUID } from "node:crypto";

/**
 * Whether a provider's defaultModel can accept image inputs. Omitted flag =
 * true (status quo: every API provider used to receive images unconditionally).
 * cli-agent flattens to plain text, so it can never accept images.
 */
export function providerSupportsVision(provider) {
  if (!provider) return false;
  if (provider.type === "cli-agent") return false;
  return provider.supportsVision !== false;
}

/**
 * Resolve the provider id to use for vision delegation, or null when none is
 * usable (unset, unknown id, or itself marked text-only / cli-agent — the
 * latter two also fail validateSettings, but resolution stays defensive so a
 * hand-edited settings.json degrades to text notes instead of recursing).
 */
export function resolveVisionProviderId(settings) {
  const id = settings?.visionProvider;
  if (typeof id !== "string" || id.length === 0) return null;
  const provider = settings?.providers?.[id];
  if (!providerSupportsVision(provider)) return null;
  return id;
}

/**
 * Ask the vision provider one question about one or more inline images.
 * Returns the answer text. Throws when no vision provider is configured or
 * the provider returns an empty answer — callers turn that into a text note
 * (delegation) or a ToolResult error note (ask_image).
 *
 * @param {{
 *   settings: object,
 *   prompt: string,
 *   images: Array<{ mime: string, dataBase64: string }>,
 *   runProviderImpl: Function,
 *   cwd?: string,
 *   signal?: AbortSignal
 * }} input
 * @returns {Promise<string>}
 */
export async function runVisionOneShot({ settings, prompt, images, runProviderImpl, cwd = process.cwd(), signal }) {
  const visionProviderId = resolveVisionProviderId(settings);
  if (!visionProviderId) {
    throw new Error("No vision provider configured (settings.visionProvider)");
  }
  if (typeof runProviderImpl !== "function") {
    throw new Error("runVisionOneShot requires a runProviderImpl function");
  }
  const inlineImages = (Array.isArray(images) ? images : [])
    .filter((img) => img && typeof img.mime === "string" && typeof img.dataBase64 === "string");
  if (inlineImages.length === 0) {
    throw new Error("runVisionOneShot requires at least one inline image");
  }
  const response = await runProviderImpl({
    // Same settings, different active provider — `*-via-proxy` vision
    // providers keep working because only defaultProvider changes.
    settings: { ...settings, defaultProvider: visionProviderId },
    messages: [
      {
        id: randomUUID(),
        role: "user",
        content: [
          { kind: "text", text: prompt },
          ...inlineImages.map((img) => ({ kind: "image", mime: img.mime, dataBase64: img.dataBase64 }))
        ]
      }
    ],
    tools: [],
    cwd,
    stream: false,
    signal
  });
  const text = extractResponseText(response).trim();
  if (text.length === 0) {
    throw new Error(`Vision provider ${visionProviderId} returned an empty answer`);
  }
  return text;
}

/** Default prompt for attachment auto-describe (image-delegation.mjs). */
export const DESCRIBE_IMAGE_PROMPT = [
  "Describe this image in detail so a text-only assistant can work with it.",
  "Include: all visible text verbatim, UI elements and their approximate locations,",
  "error messages, diagrams/charts content, and anything unusual.",
  "Answer in the same language as any text in the image; otherwise use Japanese."
].join(" ");

function extractResponseText(response) {
  if (!response) return "";
  if (typeof response === "string") return response;
  const message = response.message;
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    return message.content
      .map((block) => (block?.kind === "text" && typeof block.text === "string") ? block.text : "")
      .join("");
  }
  return "";
}
