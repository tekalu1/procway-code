/**
 * Image-ref hydration: the single egress point that turns lightweight image
 * reference blocks into inline `image` blocks
 * (`{ kind: "image", mime, dataBase64 }`) right before a provider request is
 * built. Two reference kinds, one transport each:
 *
 *  - `file_ref`       — a path on the SESSION's own filesystem (view_image
 *                        screenshots etc.); read locally.
 *  - `attachment_ref` — a dashboard upload, by attachment id; bytes are
 *                        fetched over HTTP from the dashboard
 *                        (`GET $PROCWAY_DASHBOARD_URL/api/ai/attachments/<id>`,
 *                        authenticated with the session's PROCWAY_PROXY_TOKEN).
 *                        Sessions never read attachment blobs off a shared
 *                        volume — the HTTP fetch is the single transport, so
 *                        behavior is identical across runtime engines.
 *
 * Why a separate, transient step:
 *  - Persisted messages keep only the refs (path/id + mime), so session
 *    snapshots stay small even when many screenshots are attached.
 *  - Base64 bytes leave the process exactly once — here — so this is the
 *    only place that reads attachment bytes and hands them to a third-party
 *    model. No presigned URLs, no storage credentials ever leave.
 *
 * The format adapters downstream only ever see `image` blocks, never a ref,
 * so each adapter has one shape to translate.
 */
import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import path from "node:path";

/** Header carrying the session-scoped token to the dashboard (02.auth.ts). */
const SESSION_TOKEN_HEADER = "x-procway-session";

/** Default timeout for one attachment fetch. */
const DEFAULT_ATTACHMENT_FETCH_TIMEOUT_MS = 15_000;

const IMAGE_MIME_BY_EXT = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp"
});

const SUPPORTED_IMAGE_MIMES = new Set(Object.values(IMAGE_MIME_BY_EXT));

/** Default cap per image (bytes). Larger files degrade to a text note. */
export const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function isImageMime(mime) {
  return typeof mime === "string" && SUPPORTED_IMAGE_MIMES.has(mime.toLowerCase());
}

/**
 * Resolve the image mime for a file_ref: prefer an explicit (supported) mime,
 * else infer from the file extension. Returns null for non-images.
 */
export function inferImageMime(filePath, explicit) {
  if (isImageMime(explicit)) return explicit.toLowerCase();
  const ext = path.extname(typeof filePath === "string" ? filePath : "").toLowerCase();
  return IMAGE_MIME_BY_EXT[ext] ?? null;
}

export function isImageFileRef(block) {
  return Boolean(block)
    && block.kind === "file_ref"
    && typeof block.path === "string"
    && inferImageMime(block.path, block.mime) != null;
}

// An id is enough to hydrate — the authoritative mime arrives with the bytes
// (response Content-Type). Outbound refs (direction:"outbound") are attachments
// the SESSION itself produced via attach_file; they are NOT re-inlined into the
// model (it already has the source), so they're excluded here — they ride along
// only for persistence/replay and surface delivery.
export function isImageAttachmentRef(block) {
  return Boolean(block)
    && block.kind === "attachment_ref"
    && typeof block.id === "string"
    && block.id.length > 0
    && block.direction !== "outbound";
}

export function messageHasImageRef(message) {
  return Array.isArray(message?.content)
    && message.content.some((b) => isImageFileRef(b) || isImageAttachmentRef(b));
}

/**
 * Fetch a dashboard attachment's bytes. Returns `{ buf, mime, contentType }`
 * — `mime` only for supported image types (the hydration consumer), while
 * `contentType` carries the raw response type for any-file consumers
 * (save_attachment). Throws on a missing base URL, non-2xx response, or
 * timeout. The session token header is only attached when a token was
 * injected (SaaS); local mode has no auth.
 */
export async function fetchAttachmentBytes(id, { dashboardUrl, proxyToken, fetchImpl, timeoutMs }) {
  if (!dashboardUrl) {
    throw new Error("PROCWAY_DASHBOARD_URL is not set");
  }
  const url = `${dashboardUrl.replace(/\/+$/, "")}/api/ai/attachments/${encodeURIComponent(id)}`;
  const headers = proxyToken ? { [SESSION_TOKEN_HEADER]: proxyToken } : {};
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    throw new Error(`attachment fetch failed: ${res.status} ${res.statusText ?? ""}`.trim());
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const contentType = (res.headers?.get?.("content-type") ?? "").split(";")[0].trim().toLowerCase();
  return { buf, mime: isImageMime(contentType) ? contentType : null, contentType: contentType || null };
}

/**
 * Upload bytes to the dashboard attachment store and return the minted
 * `{ id, mime, bytes }`. The counterpart to fetchAttachmentBytes: the session
 * pushes a workspace file UP the same single transport
 * (`POST $PROCWAY_DASHBOARD_URL/api/ai/attachments`, multipart, authenticated
 * with the session's PROCWAY_PROXY_TOKEN). `attach_file` uses this so an
 * outbound attachment becomes an id-addressed store object that every surface
 * (dashboard preview, future Slack reflection) renders via the GET endpoint —
 * no surface-specific upload path. Throws on a missing base URL, non-2xx
 * response, or timeout.
 */
export async function uploadAttachmentBytes(buf, { filename, mime, sessionId, dashboardUrl, proxyToken, fetchImpl = fetch, timeoutMs = DEFAULT_ATTACHMENT_FETCH_TIMEOUT_MS }) {
  if (!dashboardUrl) {
    throw new Error("PROCWAY_DASHBOARD_URL is not set");
  }
  const url = `${dashboardUrl.replace(/\/+$/, "")}/api/ai/attachments`;
  const form = new FormData();
  form.append("file", new Blob([buf], { type: mime || "application/octet-stream" }), filename || "attachment");
  if (typeof sessionId === "string" && sessionId) form.append("sessionId", sessionId);
  const headers = proxyToken ? { [SESSION_TOKEN_HEADER]: proxyToken } : {};
  const res = await fetchImpl(url, { method: "POST", headers, body: form, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    throw new Error(`attachment upload failed: ${res.status} ${res.statusText ?? ""}`.trim());
  }
  return await res.json();
}

/**
 * Replace every image `file_ref` block with an inline `image` block by
 * reading the referenced file and base64-encoding it. Pure with respect to
 * the input: returns a new array (and shallow-copies only the messages that
 * change). Non-image file_refs and all other blocks pass through untouched.
 *
 * On a read error or oversize file the block degrades to a `text` note so the
 * provider request still succeeds and the model is told an image was meant to
 * be there (instead of silently going blind or crashing the turn).
 *
 * `maxTotalBytes` bounds the CUMULATIVE on-the-wire image payload across the
 * whole conversation. Without it, a long agentic loop that calls `view_image`
 * repeatedly (e.g. an acceptance task comparing screenshots) re-sends EVERY
 * accumulated image on EVERY round — ballooning the request to multiple MB and,
 * for backends that buffer the whole multimodal request before responding
 * (the ChatGPT `codex` backend), hanging until the headers timeout fires and
 * the turn retries forever. When set, the NEWEST images are kept within budget
 * (most recent = most relevant to the current step) and older ones degrade to
 * a text note. Default (undefined) preserves the prior unbounded behavior.
 *
 * @param {Array<object>} messages
 * @param {{
 *   cwd?: string,
 *   readFile?: typeof fsReadFile,
 *   stat?: typeof fsStat,
 *   maxBytes?: number,
 *   maxTotalBytes?: number,
 *   dashboardUrl?: string,
 *   proxyToken?: string,
 *   fetchImpl?: typeof fetch,
 *   fetchTimeoutMs?: number
 * }} [opts]
 * @returns {Promise<Array<object>>}
 */
export async function hydrateImageRefs(messages, {
  cwd = process.cwd(),
  readFile = fsReadFile,
  stat = fsStat,
  maxBytes = DEFAULT_MAX_IMAGE_BYTES,
  maxTotalBytes,
  dashboardUrl = process.env.PROCWAY_DASHBOARD_URL,
  proxyToken = process.env.PROCWAY_PROXY_TOKEN,
  fetchImpl = fetch,
  fetchTimeoutMs = DEFAULT_ATTACHMENT_FETCH_TIMEOUT_MS
} = {}) {
  if (!Array.isArray(messages)) return messages;
  // Fast path: nothing to hydrate, return the original array unchanged.
  if (!messages.some(messageHasImageRef)) return messages;

  // When a cumulative budget is set, decide up front which image refs to keep.
  // Walk newest→oldest, summing file sizes (cheap stat, no read), and drop
  // older refs once the budget is exceeded. Keyed by "msgIdx:blockIdx".
  const droppedRefs = await selectDroppedImageRefs(messages, { cwd, stat, maxTotalBytes });

  const out = [];
  for (let mi = 0; mi < messages.length; mi += 1) {
    const message = messages[mi];
    if (!messageHasImageRef(message)) {
      out.push(message);
      continue;
    }
    const content = [];
    for (let bi = 0; bi < message.content.length; bi += 1) {
      const block = message.content[bi];
      if (isImageAttachmentRef(block)) {
        // Dashboard upload: bytes come over HTTP — the single attachment
        // transport (never a shared-volume path). Failures degrade to a text
        // note like every other hydration miss.
        try {
          const { buf, mime: responseMime } = await fetchAttachmentBytes(block.id, {
            dashboardUrl, proxyToken, fetchImpl, timeoutMs: fetchTimeoutMs
          });
          if (buf.length > maxBytes) {
            content.push({
              kind: "text",
              text: `[attachment ${block.id} omitted: ${buf.length} bytes exceeds ${maxBytes} byte limit]`
            });
            continue;
          }
          const mime = responseMime ?? (isImageMime(block.mime) ? block.mime.toLowerCase() : null);
          if (!mime) {
            content.push({ kind: "text", text: `[attachment ${block.id} unavailable: unsupported image type]` });
            continue;
          }
          content.push({ kind: "image", mime, dataBase64: buf.toString("base64") });
        } catch (err) {
          const reason = err && typeof err.message === "string" ? err.message : String(err);
          content.push({ kind: "text", text: `[attachment ${block.id} unavailable: ${reason}]` });
        }
        continue;
      }
      if (!isImageFileRef(block)) {
        content.push(block);
        continue;
      }
      if (droppedRefs && droppedRefs.has(`${mi}:${bi}`)) {
        content.push({
          kind: "text",
          text: `[earlier image ${block.path} omitted to bound multimodal request size; re-attach if still needed]`
        });
        continue;
      }
      const mime = inferImageMime(block.path, block.mime);
      const resolved = path.isAbsolute(block.path) ? block.path : path.resolve(cwd, block.path);
      try {
        const buf = await readFile(resolved);
        if (buf.length > maxBytes) {
          content.push({
            kind: "text",
            text: `[image ${block.path} omitted: ${buf.length} bytes exceeds ${maxBytes} byte limit]`
          });
          continue;
        }
        content.push({ kind: "image", mime, dataBase64: Buffer.from(buf).toString("base64") });
      } catch (err) {
        const reason = err && typeof err.message === "string" ? err.message : String(err);
        content.push({ kind: "text", text: `[image ${block.path} unavailable: ${reason}]` });
      }
    }
    out.push({ ...message, content });
  }
  return out;
}

/**
 * Decide which image file_refs to drop to honor a cumulative byte budget.
 * Returns a Set of "msgIdx:blockIdx" keys, or null when no budget is set.
 * Keeps the newest images (latest in the message order) within budget.
 *
 * `attachment_ref` blocks are exempt: their size isn't knowable without a
 * fetch, and the budget exists for the view_image screenshot loop (file_refs
 * accumulating every round) — user attachments are few and explicit.
 */
async function selectDroppedImageRefs(messages, { cwd, stat, maxTotalBytes }) {
  if (!Number.isFinite(maxTotalBytes) || maxTotalBytes <= 0) return null;
  const refs = [];
  for (let mi = 0; mi < messages.length; mi += 1) {
    const content = messages[mi]?.content;
    if (!Array.isArray(content)) continue;
    for (let bi = 0; bi < content.length; bi += 1) {
      if (isImageFileRef(content[bi])) refs.push({ key: `${mi}:${bi}`, path: content[bi].path });
    }
  }
  if (refs.length === 0) return null;
  const dropped = new Set();
  let total = 0;
  for (let i = refs.length - 1; i >= 0; i -= 1) {
    const ref = refs[i];
    const resolved = path.isAbsolute(ref.path) ? ref.path : path.resolve(cwd, ref.path);
    let size;
    try { size = (await stat(resolved)).size; } catch { size = 0; }
    // Always keep at least the single newest image, even if it alone exceeds
    // the budget — dropping the very thing the model just asked to look at is
    // worse than a one-off large request.
    if (total > 0 && total + size > maxTotalBytes) {
      dropped.add(ref.key);
    } else {
      total += size;
    }
  }
  return dropped;
}

/** True for a hydrated inline image block. */
export function isInlineImageBlock(block) {
  return Boolean(block)
    && block.kind === "image"
    && typeof block.dataBase64 === "string"
    && typeof block.mime === "string";
}

/** Build a `data:` URL from a hydrated image block (OpenAI-family adapters). */
export function imageBlockToDataUrl(block) {
  return `data:${block.mime};base64,${block.dataBase64}`;
}
