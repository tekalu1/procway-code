/**
 * Slack MCP tools (Phase 1 of the Slack integration plan). Read +
 * post-message surface exposed to procway-code via the host's tool
 * registry, using the tenant-shared bot token (kind='oauth-bot') the
 * dashboard stores under the `slack` connection.
 *
 * Slack Web API quirk every call must handle: errors arrive as HTTP 200
 * with `{ ok: false, error: "..." }`, so we re-check `ok` after callApi
 * (which only throws on non-2xx) and convert failures to
 * IntegrationApiError to ride the registry's PROVIDER_ERROR mapping.
 */

import { callApi, IntegrationApiError } from "./_auth.mjs";

const ID = "slack";

function clampLimit(n, fallback, max) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 1) return fallback;
  return Math.min(Math.floor(v), max);
}

async function slackCall({ cwd, method = "GET", path, query, body, fetchImpl }) {
  const out = await callApi({ cwd, id: ID, method, path, query, body, fetchImpl });
  if (out && typeof out === "object" && out.ok === false) {
    throw new IntegrationApiError(ID, method, path, 200, out.error ?? "unknown_error");
  }
  return out;
}

/**
 * Accept either a channel id (`C...`/`D...`) or a `#name` / bare name.
 * Names are resolved through conversations.list (public channels, first
 * 200) — fine for the MVP surface; pass ids for big workspaces.
 */
async function resolveChannelId({ cwd, channel, fetchImpl }) {
  const raw = String(channel ?? "").trim();
  if (!raw) throw new Error("channel is required");
  if (/^[CDG][A-Z0-9]+$/.test(raw)) return raw;
  const name = raw.replace(/^#/, "");
  const out = await slackCall({
    cwd, fetchImpl,
    path: "/conversations.list",
    query: { types: "public_channel", exclude_archived: true, limit: 200 }
  });
  const match = (out.channels ?? []).find((c) => c.name === name);
  if (!match) {
    throw new Error(`Channel "#${name}" not found among the first 200 public channels. Pass the channel id instead.`);
  }
  return match.id;
}

function channelSummary(c) {
  return {
    id: c.id,
    name: c.name,
    isPrivate: Boolean(c.is_private),
    isArchived: Boolean(c.is_archived),
    numMembers: c.num_members ?? null,
    topic: c.topic?.value || null
  };
}

function messageSummary(m) {
  return {
    ts: m.ts,
    user: m.user ?? m.bot_id ?? null,
    text: m.text ?? "",
    threadTs: m.thread_ts ?? null,
    replyCount: m.reply_count ?? 0
  };
}

export async function listChannels({ cwd, limit, fetchImpl } = {}) {
  const out = await slackCall({
    cwd, fetchImpl,
    path: "/conversations.list",
    query: { types: "public_channel", exclude_archived: true, limit: clampLimit(limit, 100, 200) }
  });
  return (out.channels ?? []).map(channelSummary);
}

export async function readChannel({ cwd, channel, limit, fetchImpl } = {}) {
  const channelId = await resolveChannelId({ cwd, channel, fetchImpl });
  const out = await slackCall({
    cwd, fetchImpl,
    path: "/conversations.history",
    query: { channel: channelId, limit: clampLimit(limit, 20, 100) }
  });
  // Slack returns newest-first; flip so the model reads chronologically.
  return {
    channel: channelId,
    messages: (out.messages ?? []).map(messageSummary).reverse(),
    hasMore: Boolean(out.has_more)
  };
}

export async function readThread({ cwd, channel, threadTs, limit, fetchImpl } = {}) {
  if (!threadTs) throw new Error("threadTs is required");
  const channelId = await resolveChannelId({ cwd, channel, fetchImpl });
  const out = await slackCall({
    cwd, fetchImpl,
    path: "/conversations.replies",
    query: { channel: channelId, ts: threadTs, limit: clampLimit(limit, 50, 200) }
  });
  return {
    channel: channelId,
    threadTs,
    messages: (out.messages ?? []).map(messageSummary),
    hasMore: Boolean(out.has_more)
  };
}

export async function postMessage({ cwd, channel, text, threadTs, fetchImpl } = {}) {
  if (!text || !String(text).trim()) throw new Error("text is required");
  const channelId = await resolveChannelId({ cwd, channel, fetchImpl });
  const body = { channel: channelId, text };
  if (threadTs) body.thread_ts = threadTs;
  const out = await slackCall({ cwd, fetchImpl, method: "POST", path: "/chat.postMessage", body });
  return { channel: out.channel ?? channelId, ts: out.ts ?? null, threadTs: threadTs ?? null };
}

// Outbound file delivery to Slack is no longer a runtime tool. Files are
// attached surface-agnostically via `attach_file` (Phase 1-2); the Slack
// surface adapter (dashboard server/services/slack-mirror.service.ts) reflects
// them to the bound thread with the dashboard-held bot token. The former
// slack_upload_file tool + uploadFile() were removed in Phase 3.
