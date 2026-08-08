import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { getSessionsDir } from "./store.mjs";
import { resolveSessionContext } from "./session-context.mjs";

// v2: entries carry `origin` (null = user session, "worker" = programmatic
// serve-client run).
// v3: entries carry `sessionContext` ({ project?, ticket? } | null) for the
// /ai history project/ticket filter — derived from a worker session's
// procwayMeta when not natively tagged.
// A version mismatch triggers a full rebuild from the per-session meta.json
// files so pre-vN indexes pick the new fields up (including the procwayMeta →
// "worker"/sessionContext backfill for legacy runner sessions).
const VERSION = 3;

function indexPath(homeDir, sessionsDir = null) {
  return path.join(getSessionsDir({ homeDir, sessionsDir }), "index.json");
}

/**
 * Write the index via temp file + rename instead of opening index.json
 * directly. The file lives on the shared workspaces volume and has TWO
 * writers in different pods: the dashboard (uid 1000) and the session pod's
 * serve (root, but strict hardening drops ALL capabilities — no
 * DAC_OVERRIDE — with only a supplementary gid 1000). A plain writeFile
 * creates it 0644 (umask) owned by whichever side wrote first, and the other
 * side then fails open(O_WRONLY) with EACCES (group bit is r--), which
 * surfaced as "session start failed" on k8s (2026-06-06, app.dev).
 *
 * rename(2) is permission-checked against the DIRECTORY (group-writable for
 * both sides), not the destination file, so this also replaces a stale 0644
 * index. chmod 0664 keeps the file group-writable for the other side, and
 * temp+rename makes the concurrent cross-pod writes atomic (no torn reads).
 */
// Transient rename failures worth retrying. ENOENT is included deliberately:
// before the random suffix below, two same-millisecond writers in this process
// (upsert + remove during a run loop's rapid session churn) produced an
// IDENTICAL tmp path, so the first rename consumed the file and the second hit
// `ENOENT: rename ...index.json.tmp-*` with no recovery — the actual TK-8 hang
// source (#122 層1). EBUSY/EPERM/EACCES cover the cross-pod / Windows window.
const TRANSIENT_WRITE_ERRORS = new Set(["ENOENT", "EBUSY", "EPERM", "EACCES"]);
const WRITE_INDEX_TRIES = 6;
const WRITE_INDEX_BASE_MS = 25;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function writeIndexFile(file, payload) {
  await mkdir(path.dirname(file), { recursive: true });
  let lastError = null;
  for (let attempt = 0; attempt < WRITE_INDEX_TRIES; attempt++) {
    // A random suffix makes the tmp path unique per write, so concurrent writers
    // in the same process/ms can never collide on it. Each retry uses a fresh
    // name so a half-written tmp from a previous attempt is never reused.
    const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
    try {
      await writeFile(tmp, payload, "utf8");
      // chmod 0664 keeps the file group-writable for the OTHER pod (see the
      // cross-pod permission note above); rename(2) is dir-permission checked.
      await chmod(tmp, 0o664);
      await rename(tmp, file);
      return;
    } catch (error) {
      lastError = error;
      await rm(tmp, { force: true }).catch(() => {});
      const code = error && typeof error === "object" ? error.code : null;
      if (!TRANSIENT_WRITE_ERRORS.has(code) || attempt === WRITE_INDEX_TRIES - 1) {
        throw error;
      }
      await sleep(WRITE_INDEX_BASE_MS * 2 ** attempt);
    }
  }
  throw lastError;
}

export async function readSessionIndex({ homeDir = os.homedir(), sessionsDir = null } = {}) {
  const file = indexPath(homeDir, sessionsDir);
  if (!existsSync(file)) {
    return rebuildAndPersistIndex({ homeDir, sessionsDir });
  }
  try {
    const content = await readFile(file, "utf8");
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || !parsed.sessions || typeof parsed.sessions !== "object") {
      return rebuildAndPersistIndex({ homeDir, sessionsDir });
    }
    // Older index versions lack fields added later (e.g. v2 `origin`).
    // Rebuild from meta.json instead of trusting the stale entries.
    if (parsed.version !== VERSION) {
      return rebuildAndPersistIndex({ homeDir, sessionsDir });
    }
    return { version: VERSION, sessions: parsed.sessions };
  } catch {
    return rebuildAndPersistIndex({ homeDir, sessionsDir });
  }
}

/**
 * Rebuild the index from meta.json files and write the result back so the
 * one-time migration (or corrupt-file recovery) doesn't repeat on every
 * read — the dashboard polls listSessions every 10s and a v1 index would
 * otherwise re-scan all session dirs each time. The write is best-effort:
 * a read-only mount still gets a correct (if uncached) listing.
 */
async function rebuildAndPersistIndex({ homeDir, sessionsDir = null }) {
  const rebuilt = await rebuildIndex({ homeDir, sessionsDir });
  try {
    const file = indexPath(homeDir, sessionsDir);
    await writeIndexFile(file, JSON.stringify(rebuilt, null, 2) + "\n");
  } catch {
    // Best-effort persistence only.
  }
  return rebuilt;
}

export async function upsertSessionIndex({ homeDir = os.homedir(), sessionId, entry } = {}) {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new TypeError("upsertSessionIndex: sessionId is required");
  }
  const index = await readSessionIndex({ homeDir });
  const sessions = { ...(index.sessions ?? {}) };
  sessions[sessionId] = { ...(sessions[sessionId] ?? {}), ...(entry ?? {}) };
  const next = { version: VERSION, sessions };
  await writeIndexFile(indexPath(homeDir), JSON.stringify(next, null, 2) + "\n");
  return next;
}

export async function removeSessionIndex({ homeDir = os.homedir(), sessionsDir = null, sessionId } = {}) {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new TypeError("removeSessionIndex: sessionId is required");
  }
  // `sessionsDir` scopes the removal to a specific sessions root (the
  // dashboard passes the per-tenant subtree) — same contract as listSessions.
  // Omitted → the HOME-relative default, byte-identical to before.
  const index = await readSessionIndex({ homeDir, sessionsDir });
  const sessions = { ...(index.sessions ?? {}) };
  delete sessions[sessionId];
  const next = { version: VERSION, sessions };
  await writeIndexFile(indexPath(homeDir, sessionsDir), JSON.stringify(next, null, 2) + "\n");
  return next;
}

/**
 * Encode a `(updatedAt, sessionId)` pair into a base64 cursor (ADR-126-01).
 */
export function encodeCursor({ updatedAt, sessionId }) {
  if (typeof updatedAt !== "string" || typeof sessionId !== "string") {
    throw new TypeError("encodeCursor: updatedAt and sessionId must be strings");
  }
  return Buffer.from(`${updatedAt}|${sessionId}`, "utf8").toString("base64");
}

/**
 * Decode a base64 cursor produced by `encodeCursor`. Throws on malformed input.
 */
export function decodeCursor(cursor) {
  if (typeof cursor !== "string" || cursor.length === 0) {
    throw new TypeError("decodeCursor: cursor must be a non-empty string");
  }
  const decoded = Buffer.from(cursor, "base64").toString("utf8");
  const sepIdx = decoded.indexOf("|");
  if (sepIdx <= 0 || sepIdx === decoded.length - 1) {
    throw new Error("decodeCursor: malformed cursor");
  }
  return { updatedAt: decoded.slice(0, sepIdx), sessionId: decoded.slice(sepIdx + 1) };
}

async function rebuildIndex({ homeDir, sessionsDir = null }) {
  const dir = getSessionsDir({ homeDir, sessionsDir });
  if (!existsSync(dir)) return { version: VERSION, sessions: {} };
  const sessions = {};
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { version: VERSION, sessions };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    const metaPath = path.join(dir, entry.name, "meta.json");
    if (!existsSync(metaPath)) continue;
    try {
      const content = await readFile(metaPath, "utf8");
      const meta = JSON.parse(content);
      const updatedAt = meta.updatedAt ?? null;
      sessions[entry.name] = {
        title: meta.title ?? null,
        provider: meta.provider ?? null,
        model: meta.model ?? null,
        updatedAt,
        createdAt: meta.createdAt ?? updatedAt,
        cwd: meta.cwd ?? null,
        messageCount: Number.isFinite(meta.messageCount) ? Number(meta.messageCount) : 0,
        // v2: pre-origin runner sessions are recognizable by their persisted
        // procwayMeta — backfill them as "worker" so the sidebar filter
        // applies to legacy history as well.
        origin: meta.origin ?? (meta.procwayMeta ? "worker" : null),
        // v3: project/ticket filter tag. Use the natively persisted value when
        // present, else derive it from the worker's procwayMeta so legacy
        // runner history is filterable too (shared helper in session-context.mjs).
        sessionContext: resolveSessionContext(meta)
      };
    } catch {
      // Skip unreadable meta — the rest of the index is still valid.
    }
  }
  return { version: VERSION, sessions };
}
