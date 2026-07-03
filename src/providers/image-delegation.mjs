/**
 * Image delegation for TEXT-ONLY main providers (supportsVision: false).
 *
 * Counterpart of image-hydration.mjs: where hydration inlines image bytes for
 * a vision-capable model, delegation makes sure NO image part ever reaches a
 * text-only model (which would 400 the whole turn). Per ref kind:
 *
 *  - `attachment_ref` (user chat upload) — auto-describe via the vision
 *    provider (settings.visionProvider) and substitute the description text.
 *    The user attached the image expecting the assistant to "see" it, so this
 *    happens eagerly. The description is cached IN PLACE on the original ref
 *    block (`block.visionDescription`) — message content is persisted as-is
 *    in snapshots/event-log, so each attachment costs at most ONE vision call
 *    for the session's lifetime, and the untouched ref keeps working if the
 *    user later switches to a vision-capable main provider.
 *
 *  - `file_ref` (view_image / web_browser / desktop screenshots) — degrade to
 *    a text note pointing the model at the `ask_image` tool. No automatic
 *    vision call: screenshot loops are high-volume, and a targeted question
 *    through ask_image beats a generic caption on both cost and quality.
 *
 *  - inline `image` (already-hydrated block, transient edge case) — degrade
 *    to a text note; persisted messages only ever carry refs.
 *
 * When no vision provider is configured every image degrades to an
 * explanatory note (still a strict improvement over the previous behavior:
 * the provider request used to fail outright).
 */
import {
  isImageFileRef,
  isImageAttachmentRef,
  isInlineImageBlock,
  isImageMime,
  messageHasImageRef,
  fetchAttachmentBytes,
  DEFAULT_MAX_IMAGE_BYTES
} from "./image-hydration.mjs";
import { resolveVisionProviderId, runVisionOneShot, DESCRIBE_IMAGE_PROMPT } from "./vision.mjs";

const DEFAULT_ATTACHMENT_FETCH_TIMEOUT_MS = 15_000;

function messageHasImagePart(message) {
  return messageHasImageRef(message)
    || (Array.isArray(message?.content) && message.content.some(isInlineImageBlock));
}

/**
 * Replace every image block with text a text-only model can consume. Pure
 * with respect to the returned array (changed messages are shallow-copied),
 * EXCEPT for the deliberate `visionDescription` cache annotation written onto
 * original attachment_ref blocks (see module doc).
 *
 * Never throws for a single bad image — each block degrades independently to
 * a text note, mirroring hydration's failure behavior.
 *
 * @param {Array<object>} messages
 * @param {{
 *   settings: object,
 *   runProviderImpl: Function,
 *   cwd?: string,
 *   signal?: AbortSignal,
 *   maxBytes?: number,
 *   dashboardUrl?: string,
 *   proxyToken?: string,
 *   fetchImpl?: typeof fetch,
 *   fetchTimeoutMs?: number,
 *   describePrompt?: string
 * }} opts
 * @returns {Promise<Array<object>>}
 */
export async function delegateImageRefsForTextOnly(messages, {
  settings,
  runProviderImpl,
  cwd = process.cwd(),
  signal,
  maxBytes = DEFAULT_MAX_IMAGE_BYTES,
  dashboardUrl = process.env.PROCWAY_DASHBOARD_URL,
  proxyToken = process.env.PROCWAY_PROXY_TOKEN,
  fetchImpl = fetch,
  fetchTimeoutMs = DEFAULT_ATTACHMENT_FETCH_TIMEOUT_MS,
  describePrompt = DESCRIBE_IMAGE_PROMPT
} = {}) {
  if (!Array.isArray(messages)) return messages;
  if (!messages.some(messageHasImagePart)) return messages;

  const visionAvailable = resolveVisionProviderId(settings) != null && typeof runProviderImpl === "function";

  const out = [];
  for (const message of messages) {
    if (!messageHasImagePart(message)) {
      out.push(message);
      continue;
    }
    const content = [];
    for (const block of message.content) {
      if (isImageAttachmentRef(block)) {
        content.push(await delegateAttachmentRef(block, {
          settings, runProviderImpl, cwd, signal, maxBytes,
          dashboardUrl, proxyToken, fetchImpl, fetchTimeoutMs,
          describePrompt, visionAvailable
        }));
        continue;
      }
      if (isImageFileRef(block)) {
        content.push({
          kind: "text",
          text: visionAvailable
            ? `[image saved at ${block.path} — the current model cannot view images directly; call the ask_image tool with this path and a specific question to inspect it]`
            : `[image saved at ${block.path} — the current model cannot view images and no vision provider is configured]`
        });
        continue;
      }
      if (isInlineImageBlock(block)) {
        content.push({ kind: "text", text: "[inline image omitted: the current model cannot view images]" });
        continue;
      }
      content.push(block);
    }
    out.push({ ...message, content });
  }
  return out;
}

async function delegateAttachmentRef(block, {
  settings, runProviderImpl, cwd, signal, maxBytes,
  dashboardUrl, proxyToken, fetchImpl, fetchTimeoutMs,
  describePrompt, visionAvailable
}) {
  // Cache hit: this attachment was already described in an earlier round.
  if (typeof block.visionDescription === "string" && block.visionDescription.length > 0) {
    return attachmentDescriptionBlock(block.id, block.visionDescription);
  }
  if (!visionAvailable) {
    return {
      kind: "text",
      text: `[attached image ${block.id} cannot be viewed: the current model is text-only and no vision provider is configured — ask the user to set one in AI settings]`
    };
  }
  try {
    const { buf, mime: responseMime } = await fetchAttachmentBytes(block.id, {
      dashboardUrl, proxyToken, fetchImpl, timeoutMs: fetchTimeoutMs
    });
    if (buf.length > maxBytes) {
      return { kind: "text", text: `[attachment ${block.id} omitted: ${buf.length} bytes exceeds ${maxBytes} byte limit]` };
    }
    const mime = responseMime ?? (isImageMime(block.mime) ? block.mime.toLowerCase() : null);
    if (!mime) {
      return { kind: "text", text: `[attachment ${block.id} unavailable: unsupported image type]` };
    }
    const description = await runVisionOneShot({
      settings,
      prompt: describePrompt,
      images: [{ mime, dataBase64: buf.toString("base64") }],
      runProviderImpl,
      cwd,
      signal
    });
    // Deliberate in-place annotation: the session owns these message objects
    // and persists content blocks verbatim, so the description survives both
    // later rounds and snapshot/resume — one vision call per attachment.
    block.visionDescription = description;
    return attachmentDescriptionBlock(block.id, description);
  } catch (err) {
    const reason = err && typeof err.message === "string" ? err.message : String(err);
    return { kind: "text", text: `[attached image ${block.id} could not be described: ${reason}]` };
  }
}

function attachmentDescriptionBlock(id, description) {
  return {
    kind: "text",
    text: `[attached image ${id} — described by the vision model]\n${description}`
  };
}
