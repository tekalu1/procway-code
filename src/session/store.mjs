import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeSnapshot, readSnapshot } from "./snapshot.mjs";
import { writeTranscriptMarkdown } from "./transcript-md.mjs";
import {
  decodeCursor,
  encodeCursor,
  readSessionIndex,
  upsertSessionIndex
} from "./session-index.mjs";
import { deriveSessionContext, normalizeSessionContext } from "./session-context.mjs";

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/**
 * On-disk layout (workspace-independent):
 *
 *   ~/.procway/ai-agent/sessions/
 *     <sessionId>/
 *       events.jsonl
 *       snapshot.json
 *       meta.json          # meta.cwd records the workspace the session ran in
 *     index.json
 *
 * `homeDir` is a parameter so tests can isolate writes; production callers
 * leave it unset to fall back to `os.homedir()`. The `cwd` argument that used
 * to determine storage is now only meaningful as a filter on `listSessions`
 * (sessions remember their originating workspace via `meta.cwd`).
 */
export function getSessionsDir({ homeDir = os.homedir(), sessionsDir = null } = {}) {
  // WS-L D3 (ADR 0015 §D2-a — subpath rework). `sessionsDir` is an explicit
  // ABSOLUTE override of the sessions root. The dashboard's tenant-scoped AI
  // history reader passes the per-tenant subtree
  // (`<sessionsMount>/tenants/<id>`) so it lists ONLY the requesting tenant's
  // sessions; container-side callers leave it null and fall back to the
  // HOME-relative `<homeDir>/.procway/ai-agent/sessions` (byte-identical).
  if (typeof sessionsDir === "string" && sessionsDir.length > 0) return sessionsDir;
  return path.join(homeDir, ".procway", "ai-agent", "sessions");
}

export function getSessionDir({ homeDir = os.homedir(), sessionId } = {}) {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new TypeError("getSessionDir: sessionId is required");
  }
  return path.join(getSessionsDir({ homeDir }), sessionId);
}

export function createSessionId(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function getSessionPaths({ homeDir = os.homedir(), sessionId }) {
  const dir = getSessionDir({ homeDir, sessionId });
  return {
    dir,
    eventsPath: path.join(dir, "events.jsonl"),
    snapshotPath: path.join(dir, "snapshot.json"),
    metaPath: path.join(dir, "meta.json")
  };
}

export async function writeMeta({ homeDir = os.homedir(), sessionId, meta }) {
  const { dir, metaPath } = getSessionPaths({ homeDir, sessionId });
  await mkdir(dir, { recursive: true });
  await writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf8");
  return metaPath;
}

export async function readMeta({ homeDir = os.homedir(), sessionId } = {}) {
  const { metaPath } = getSessionPaths({ homeDir, sessionId });
  if (!existsSync(metaPath)) return null;
  try {
    const content = await readFile(metaPath, "utf8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Persist a session's projection.
 *
 * Layout is `<sessionsDir>/<sessionId>/{events.jsonl, snapshot.json,
 * meta.json}` with `index.json` at the sessions root. `saveSessionState`
 * writes the snapshot, meta, and index — events.jsonl is appended elsewhere
 * via the `EventLog` subscriber on `AgentSession`.
 *
 * `meta.createdAt` is written only on the first save and preserved on
 * subsequent saves (TK-126 / R1). `meta.cwd` reflects the workspace the
 * session ran in (sourced from `state.cwd`) and is preserved across saves.
 */
export async function saveSessionState({ homeDir = os.homedir(), sessionId, state, encryptionKey = null }) {
  const { dir } = getSessionPaths({ homeDir, sessionId });
  await mkdir(dir, { recursive: true });
  const messages = Array.isArray(state?.messages) ? state.messages : [];
  await writeSnapshot({
    homeDir,
    sessionId,
    snapshot: {
      eventCount: Number.isFinite(state?.eventCount) ? Number(state.eventCount) : 0,
      messages,
      usage: state?.usage,
      todos: state?.todos,
      planMode: state?.planMode,
      usageEvents: state?.usageEvents,
      alwaysAllow: state?.alwaysAllow,
      // Deferred-tool tier: without this passthrough the session's loaded
      // schemas were silently dropped on save (restore already read
      // snapshot.loadedTools — the write side was the missing half).
      loadedTools: state?.loadedTools,
      // ADR 0037 D4: the session's delegated jobs (background run_shell /
      // spawn_agent) so a Pod restart can rehydrate them.
      delegatedJobs: state?.delegatedJobs,
      // ADR 0037 D1: parked tool approvals (checkpoint for approve-after-restart).
      parkedApprovals: state?.parkedApprovals
    },
    encryptionKey
  });
  const updatedAt = state?.updatedAt ?? new Date().toISOString();
  const existing = await readMeta({ homeDir, sessionId });
  const createdAt = existing?.createdAt ?? state?.createdAt ?? updatedAt;
  const rawSessionCwd = state?.cwd ?? existing?.cwd ?? null;
  const sessionCwd = typeof rawSessionCwd === "string" && rawSessionCwd.length > 0
    ? path.resolve(rawSessionCwd)
    : null;
  const procwayMeta = state?.procwayMeta && typeof state.procwayMeta === "object"
    ? state.procwayMeta
    : (existing?.procwayMeta ?? null);
  // Session-context tag (project/ticket) used solely as a sidebar filter
  // dimension — separate from `procwayMeta` (worker enforcement state) so it
  // carries no behavioural side-effects. Explicit `state.sessionContext`
  // wins; otherwise it is sticky across saves; worker sessions that never had
  // one are derived from procwayMeta so legacy/runner history filters too.
  // Stays null for plain interactive chats until Phase 2 wires the tagging.
  const sessionContext = normalizeSessionContext(
    state?.sessionContext !== undefined
      ? state.sessionContext
      : (existing?.sessionContext ?? deriveSessionContext(procwayMeta))
  );
  // Session-origin tag. Sticky once set (a ChatPanel viewer saving a worker
  // session must not strip the tag). Sessions that predate the tag but carry
  // procwayMeta are runner sessions by definition — backfill them as "worker"
  // so the /ai sidebar filter hides legacy runner history too.
  const origin = (typeof state?.origin === "string" && state.origin.length > 0)
    ? state.origin
    : (typeof existing?.origin === "string" && existing.origin.length > 0)
      ? existing.origin
      : (procwayMeta ? "worker" : null);
  const pendingTaskCompletionReminder = typeof state?.pendingTaskCompletionReminder === "boolean"
    ? state.pendingTaskCompletionReminder
    : Boolean(existing?.pendingTaskCompletionReminder);
  await writeMeta({
    homeDir,
    sessionId,
    meta: {
      sessionId,
      title: state?.title ?? null,
      cwd: sessionCwd,
      provider: state?.provider ?? null,
      model: state?.model ?? null,
      createdAt,
      updatedAt,
      messageCount: messages.length,
      // Procway worker enforcement state (A+B). Null/false for non-runner
      // sessions; survives reload so ChatPanel takeover still nudges the
      // model to invoke `task complete`.
      ...(procwayMeta ? { procwayMeta } : {}),
      ...(origin ? { origin } : {}),
      ...(sessionContext ? { sessionContext } : {}),
      ...(pendingTaskCompletionReminder ? { pendingTaskCompletionReminder } : {})
    }
  });
  await upsertSessionIndex({
    homeDir,
    sessionId,
    entry: {
      title: state?.title ?? null,
      provider: state?.provider ?? null,
      model: state?.model ?? null,
      cwd: sessionCwd,
      createdAt,
      updatedAt,
      messageCount: messages.length,
      origin,
      sessionContext
    }
  });
  // TK-6: emit a pure-Markdown transcript next to snapshot.json so the
  // procway reviewer can read a single small file instead of hand-parsing the
  // events.jsonl. Plaintext only — encryption-at-rest opts out (the helper
  // skips when encryptionKey is set; reviewer falls back to events.jsonl).
  try {
    await writeTranscriptMarkdown({
      homeDir,
      sessionId,
      messages,
      meta: {
        cwd: sessionCwd,
        provider: state?.provider ?? null,
        model: state?.model ?? null,
        createdAt,
        updatedAt
      },
      encryptionKey
    });
  } catch {
    // Best-effort: transcript.md is a convenience for downstream readers,
    // never a contract guarantee. A failure here must not break the session
    // save (snapshot/meta/index above are the source of truth).
  }
  return { dir };
}

export async function loadSessionState({ homeDir = os.homedir(), sessionId, encryptionKey = null } = {}) {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new TypeError("loadSessionState: sessionId is required");
  }
  const snapshot = await readSnapshot({ homeDir, sessionId, encryptionKey });
  const meta = await readMeta({ homeDir, sessionId });
  if (!snapshot && !meta) {
    throw new Error(`No session found: ${sessionId}`);
  }
  return {
    sessionId,
    title: meta?.title ?? null,
    cwd: meta?.cwd ?? null,
    provider: meta?.provider ?? null,
    model: meta?.model ?? null,
    createdAt: meta?.createdAt ?? meta?.updatedAt ?? null,
    updatedAt: meta?.updatedAt ?? null,
    messages: snapshot?.messages ?? [],
    eventCount: snapshot?.eventCount ?? 0,
    snapshotId: snapshot?.snapshotId ?? null,
    usage: snapshot?.usage ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    todos: snapshot?.todos ?? [],
    planMode: snapshot?.planMode ?? undefined,
    usageEvents: snapshot?.usageEvents ?? [],
    alwaysAllow: snapshot?.alwaysAllow ?? [],
    procwayMeta: meta?.procwayMeta ?? null,
    origin: meta?.origin ?? null,
    sessionContext: normalizeSessionContext(meta?.sessionContext ?? null),
    pendingTaskCompletionReminder: Boolean(meta?.pendingTaskCompletionReminder)
  };
}

/**
 * List persisted sessions sorted by `updatedAt DESC` with a stable
 * `(updatedAt, sessionId)` tiebreak. Supports keyset pagination via the
 * opaque `cursor` produced by `encodeCursor` (ADR-126-01).
 *
 * `cwd` filters to sessions whose `meta.cwd` matches the resolved path —
 * pass `cwd: null` to disable filtering and list every session under
 * `~/.procway/ai-agent/sessions/`. The default filters by the caller's
 * current working directory so dashboards/REPLs only see workspace-relevant
 * sessions by default.
 *
 * `origin` filters by the session-origin tag (applied BEFORE pagination so
 * cursors stay stable): `null`/undefined lists everything, `"user"` keeps
 * only origin-less sessions (interactive chat), any other string matches
 * that exact tag (e.g. `"worker"` for programmatic serve-client runs).
 * An ARRAY lists sessions matching ANY of its entries — the dashboard
 * history sidebar passes `["user", "slack"]` so Slack-initiated
 * conversations (ADR 0021) appear alongside interactive chats.
 *
 * `project`/`ticket` filter by the session-context tag (also applied BEFORE
 * pagination). A null/empty value lists everything (untagged sessions are NOT
 * dropped); a non-empty value keeps only sessions whose `sessionContext` field
 * matches exactly. The /ai history sidebar uses these for the project/ticket
 * filter chips (Phase 1) and the docked side panel's default context filter
 * (Phase 2).
 *
 * @param {{ homeDir?: string, cwd?: string | null, limit?: number, cursor?: string | null, origin?: string | string[] | null, project?: string | null, ticket?: string | null }} input
 * @returns {Promise<{ sessions: Array<object>, nextCursor: string | null }>}
 */
/**
 * One origin term: `"user"` matches origin-less entries, any other string
 * matches that exact tag. A filter of null/undefined matches everything;
 * an array matches when ANY of its terms does.
 */
function matchesOriginFilter(entryOrigin, filter) {
  if (filter == null) return true;
  const terms = Array.isArray(filter) ? filter : [filter];
  if (terms.length === 0) return true;
  return terms.some((term) => {
    if (term === "user") return entryOrigin === null;
    if (typeof term === "string" && term.length > 0) return entryOrigin === term;
    return false;
  });
}

/**
 * Session-context field filter (project or ticket). A null/empty filter
 * matches everything — including UNTAGGED sessions — so the default listing is
 * never narrowed by an absent tag. When a value is given, only sessions whose
 * `sessionContext[key]` equals it match.
 */
function matchesSessionContextFilter(entryContext, key, value) {
  if (typeof value !== "string" || value.length === 0) return true;
  return Boolean(entryContext) && entryContext[key] === value;
}

export async function listSessions({
  homeDir = os.homedir(),
  sessionsDir = null,
  cwd = process.cwd(),
  limit = DEFAULT_LIST_LIMIT,
  cursor = null,
  origin = null,
  project = null,
  ticket = null
} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new RangeError(`listSessions: limit must be an integer in [1, ${MAX_LIST_LIMIT}]`);
  }
  // WS-L D3 (subpath rework): `sessionsDir` scopes the listing to a specific
  // sessions root (the dashboard passes the per-tenant subtree). Null → the
  // HOME-relative default, byte-identical to before.
  const index = await readSessionIndex({ homeDir, sessionsDir });
  const filterCwd = typeof cwd === "string" && cwd.length > 0 ? path.resolve(cwd) : null;
  const all = [];
  for (const [sessionId, entry] of Object.entries(index.sessions ?? {})) {
    const entryCwd = entry?.cwd ?? null;
    if (filterCwd && entryCwd !== filterCwd) continue;
    const entryOrigin = typeof entry?.origin === "string" && entry.origin.length > 0 ? entry.origin : null;
    if (!matchesOriginFilter(entryOrigin, origin)) continue;
    // Project/ticket filters (Phase 0). Applied BEFORE pagination — like the
    // origin filter — so keyset cursors stay stable. Untagged sessions only
    // drop out when a matching filter is actually supplied.
    const entryContext = normalizeSessionContext(entry?.sessionContext ?? null);
    if (!matchesSessionContextFilter(entryContext, "project", project)) continue;
    if (!matchesSessionContextFilter(entryContext, "ticket", ticket)) continue;
    const updatedAt = entry?.updatedAt ?? null;
    all.push({
      sessionId,
      title: entry?.title ?? null,
      provider: entry?.provider ?? null,
      model: entry?.model ?? null,
      cwd: entryCwd,
      createdAt: entry?.createdAt ?? updatedAt,
      updatedAt,
      messageCount: Number.isFinite(entry?.messageCount) ? Number(entry.messageCount) : 0,
      origin: entryOrigin,
      sessionContext: entryContext
    });
  }
  all.sort(compareDescByUpdatedAtAndId);

  let startIndex = 0;
  if (cursor) {
    const { updatedAt: cUpdatedAt, sessionId: cSessionId } = decodeCursor(cursor);
    startIndex = all.findIndex((s) =>
      compareDescByUpdatedAtAndId(s, { updatedAt: cUpdatedAt, sessionId: cSessionId }) > 0
    );
    if (startIndex === -1) startIndex = all.length;
  }

  const page = all.slice(startIndex, startIndex + limit);
  const hasMore = startIndex + limit < all.length;
  const nextCursor = hasMore && page.length > 0
    ? encodeCursor({ updatedAt: page[page.length - 1].updatedAt ?? "", sessionId: page[page.length - 1].sessionId })
    : null;
  return { sessions: page, nextCursor };
}

function compareDescByUpdatedAtAndId(a, b) {
  const ua = String(a.updatedAt ?? "");
  const ub = String(b.updatedAt ?? "");
  if (ua !== ub) return ub.localeCompare(ua);
  return String(b.sessionId).localeCompare(String(a.sessionId));
}
