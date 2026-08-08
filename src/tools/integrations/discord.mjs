/**
 * Discord tools (ADR 0031 Phase 1). Read + post-message surface exposed
 * to procway-code via the host's tool registry — the Slack quartet's
 * shape on Discord's REST surface.
 *
 * Auth difference vs Slack (see _auth.mjs buildDiscordAuth): with the
 * procway-managed `bot-install` connection the calls ride the
 * dashboard's guild-scope broker (the app-global bot token never enters
 * the Pod), so every path here is relative to EITHER the broker or
 * discord.com/api/v10 — the two expose the same sub-paths.
 *
 * Discord REST notes:
 *   - errors are real HTTP statuses (no Slack-style ok:false-on-200),
 *     so callApi's non-2xx handling is sufficient;
 *   - a thread IS a channel (GET /channels/{threadId}/messages);
 *   - message content caps at 2000 chars → postMessage chunks.
 */

import { callApi, resolveAuthForConnection } from "./_auth.mjs";

const ID = "discord";

export const DISCORD_MESSAGE_LIMIT = 2000;

/** Guild channel types we surface in list_channels (text-bearing). */
const CHANNEL_TYPE_LABELS = {
  0: "text",
  5: "announcement",
  15: "forum",
};

function clampLimit(n, fallback, max) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 1) return fallback;
  return Math.min(Math.floor(v), max);
}

async function guildIdFor(cwd) {
  const auth = await resolveAuthForConnection(cwd, ID);
  const guildId = auth.meta?.guildId;
  if (!guildId) throw new Error("Discord connection has no guildId. Reconnect it in Settings > Connections.");
  return guildId;
}

async function listGuildChannels({ cwd, fetchImpl }) {
  const guildId = await guildIdFor(cwd);
  const out = await callApi({
    cwd, id: ID, fetchImpl,
    path: `/guilds/${encodeURIComponent(guildId)}/channels`
  });
  return Array.isArray(out) ? out : [];
}

/**
 * Accept either a channel id (snowflake) or a `#name` / bare name.
 * Names are resolved through the guild channel list.
 */
async function resolveChannelId({ cwd, channel, fetchImpl }) {
  const raw = String(channel ?? "").trim();
  if (!raw) throw new Error("channel is required");
  if (/^\d{5,25}$/.test(raw)) return raw;
  const name = raw.replace(/^#/, "").toLowerCase();
  const channels = await listGuildChannels({ cwd, fetchImpl });
  const match = channels.find((c) => typeof c.name === "string" && c.name.toLowerCase() === name);
  if (!match) {
    throw new Error(`Channel "#${name}" not found in the connected guild. Pass the channel id instead.`);
  }
  return match.id;
}

function channelSummary(c) {
  return {
    id: c.id,
    name: c.name ?? null,
    type: CHANNEL_TYPE_LABELS[c.type] ?? `type-${c.type}`,
    topic: c.topic || null,
    parentId: c.parent_id ?? null,
    position: c.position ?? null
  };
}

function messageSummary(m) {
  return {
    id: m.id,
    author: m.author ? { id: m.author.id, username: m.author.username ?? null, bot: Boolean(m.author.bot) } : null,
    content: m.content ?? "",
    timestamp: m.timestamp ?? null,
    // A reply carries the referenced message; a thread-starter carries
    // the thread object. Either is enough for the model to follow up.
    replyTo: m.referenced_message?.id ?? m.message_reference?.message_id ?? null,
    threadId: m.thread?.id ?? null,
    attachments: Array.isArray(m.attachments) && m.attachments.length > 0
      ? m.attachments.map((a) => ({ id: a.id, filename: a.filename ?? null, size: a.size ?? null }))
      : undefined
  };
}

export async function listChannels({ cwd, limit, fetchImpl } = {}) {
  const channels = await listGuildChannels({ cwd, fetchImpl });
  const textLike = channels
    .filter((c) => c.type in CHANNEL_TYPE_LABELS)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  return textLike.slice(0, clampLimit(limit, 100, 200)).map(channelSummary);
}

export async function readChannel({ cwd, channel, limit, fetchImpl } = {}) {
  const channelId = await resolveChannelId({ cwd, channel, fetchImpl });
  const out = await callApi({
    cwd, id: ID, fetchImpl,
    path: `/channels/${encodeURIComponent(channelId)}/messages`,
    query: { limit: clampLimit(limit, 20, 100) }
  });
  // Discord returns newest-first; flip so the model reads chronologically.
  return {
    channel: channelId,
    messages: (Array.isArray(out) ? out : []).map(messageSummary).reverse()
  };
}

export async function readThread({ cwd, threadId, limit, fetchImpl } = {}) {
  const id = String(threadId ?? "").trim();
  if (!/^\d{5,25}$/.test(id)) throw new Error("threadId must be a Discord thread id (snowflake).");
  const out = await callApi({
    cwd, id: ID, fetchImpl,
    path: `/channels/${encodeURIComponent(id)}/messages`,
    query: { limit: clampLimit(limit, 50, 100) }
  });
  return {
    threadId: id,
    messages: (Array.isArray(out) ? out : []).map(messageSummary).reverse()
  };
}

/**
 * Split text into ≤2000-char chunks, preferring newline then space
 * boundaries so mid-word cuts only happen on pathological input.
 */
export function chunkDiscordText(text, max = DISCORD_MESSAGE_LIMIT) {
  const out = [];
  let rest = String(text);
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

export async function postMessage({ cwd, channel, text, threadId, fetchImpl } = {}) {
  if (!text || !String(text).trim()) throw new Error("text is required");
  // A thread is a channel — when threadId is given it IS the target.
  const targetId = threadId
    ? String(threadId).trim()
    : await resolveChannelId({ cwd, channel, fetchImpl });
  if (!/^\d{5,25}$/.test(targetId)) throw new Error("threadId must be a Discord thread id (snowflake).");

  const chunks = chunkDiscordText(String(text));
  let firstId = null;
  let lastId = null;
  for (const content of chunks) {
    const out = await callApi({
      cwd, id: ID, fetchImpl, method: "POST",
      path: `/channels/${encodeURIComponent(targetId)}/messages`,
      body: { content }
    });
    firstId = firstId ?? out?.id ?? null;
    lastId = out?.id ?? lastId;
  }
  return {
    channel: targetId,
    messageId: firstId,
    ...(chunks.length > 1 ? { chunks: chunks.length, lastMessageId: lastId } : {}),
    threadId: threadId ?? null
  };
}
