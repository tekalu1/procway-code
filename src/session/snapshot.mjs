import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getSessionDir } from "./store.mjs";
import { ENCRYPTION_MAGIC, decryptJson, encryptJson, isEncryptedBuffer } from "./encryption.mjs";

export const SNAPSHOT_INTERVAL = 50;
export const SNAPSHOT_INTERVAL_MS_DEFAULT = 30000;

/**
 * Phase 6 §2.13 — guard `AgentSession.save()` so we don't rewrite snapshot.json
 * on every event. The throttle returns `true` when at least `intervalEvents`
 * new events have arrived OR `intervalMs` have elapsed since the last write,
 * and `force` always flushes. event-log.append still runs unconditionally so
 * crashes never lose more than the current event.
 */
export class SnapshotThrottle {
  constructor({ intervalEvents = SNAPSHOT_INTERVAL, intervalMs = SNAPSHOT_INTERVAL_MS_DEFAULT, now = () => Date.now() } = {}) {
    this.intervalEvents = Math.max(1, Math.floor(intervalEvents));
    this.intervalMs = Math.max(0, Math.floor(intervalMs));
    this.now = now;
    this.lastWrittenEventCount = 0;
    this.lastWrittenAt = 0;
  }

  shouldWrite({ eventCount, force = false } = {}) {
    if (force) return true;
    const observed = Number.isFinite(eventCount) ? Number(eventCount) : 0;
    if (observed - this.lastWrittenEventCount >= this.intervalEvents) return true;
    if (this.intervalMs > 0 && this.now() - this.lastWrittenAt >= this.intervalMs) return true;
    return false;
  }

  recordWrite({ eventCount } = {}) {
    if (Number.isFinite(eventCount)) this.lastWrittenEventCount = Number(eventCount);
    this.lastWrittenAt = this.now();
  }
}

const ZERO_USAGE = Object.freeze({ inputTokens: 0, outputTokens: 0, costUsd: 0 });

function snapshotPath({ homeDir, sessionId }) {
  return path.join(getSessionDir({ homeDir, sessionId }), "snapshot.json");
}

export async function writeSnapshot({ homeDir = os.homedir(), sessionId, snapshot, encryptionKey = null }) {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new TypeError("writeSnapshot: sessionId is required");
  }
  const filePath = snapshotPath({ homeDir, sessionId });
  await mkdir(path.dirname(filePath), { recursive: true });
  const payload = {
    snapshotId: typeof snapshot?.snapshotId === "string" && snapshot.snapshotId.length > 0
      ? snapshot.snapshotId
      : randomUUID(),
    createdAt: typeof snapshot?.createdAt === "string" ? snapshot.createdAt : new Date().toISOString(),
    eventCount: Number.isFinite(snapshot?.eventCount) ? Number(snapshot.eventCount) : 0,
    messages: Array.isArray(snapshot?.messages) ? snapshot.messages : [],
    usage: normalizeUsage(snapshot?.usage),
    todos: Array.isArray(snapshot?.todos) ? snapshot.todos.map(normalizeTodo) : [],
    planMode: snapshot?.planMode ? normalizePlanMode(snapshot.planMode) : undefined,
    usageEvents: Array.isArray(snapshot?.usageEvents) ? snapshot.usageEvents : [],
    alwaysAllow: Array.isArray(snapshot?.alwaysAllow) ? snapshot.alwaysAllow : [],
    // Deferred-tool tier (loadedTools — the write half that was missing; the
    // restore side already read snapshot.loadedTools) + ADR 0037 D4 delegated
    // jobs. Omitted when empty so pre-existing snapshot shapes stay stable.
    ...(Array.isArray(snapshot?.loadedTools) && snapshot.loadedTools.length > 0
      ? { loadedTools: snapshot.loadedTools }
      : {}),
    ...(Array.isArray(snapshot?.delegatedJobs) && snapshot.delegatedJobs.length > 0
      ? { delegatedJobs: snapshot.delegatedJobs }
      : {}),
    // ADR 0037 D1: parked tool approvals (checkpoint for approve-after-restart).
    ...(Array.isArray(snapshot?.parkedApprovals) && snapshot.parkedApprovals.length > 0
      ? { parkedApprovals: snapshot.parkedApprovals }
      : {})
  };
  if (encryptionKey) {
    const buffer = encryptJson({ data: payload, key: encryptionKey });
    await writeFile(filePath, buffer);
  } else {
    await writeFile(filePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  }
  return payload;
}

export async function readSnapshot({ homeDir = os.homedir(), sessionId, encryptionKey = null } = {}) {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new TypeError("readSnapshot: sessionId is required");
  }
  const filePath = snapshotPath({ homeDir, sessionId });
  if (!existsSync(filePath)) return null;
  try {
    const buffer = await readFile(filePath);
    if (isEncryptedBuffer(buffer)) {
      if (!encryptionKey) return null;
      const decrypted = decryptJson({ ciphertext: buffer, key: encryptionKey });
      if (!decrypted || typeof decrypted !== "object" || !Array.isArray(decrypted.messages)) return null;
      return decrypted;
    }
    const head = buffer.slice(0, ENCRYPTION_MAGIC.length).toString("utf8");
    if (head === ENCRYPTION_MAGIC && !encryptionKey) return null;
    const parsed = JSON.parse(buffer.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.messages)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function isSnapshotStale({ homeDir = os.homedir(), sessionId, eventCount, encryptionKey = null }) {
  const snapshot = await readSnapshot({ homeDir, sessionId, encryptionKey });
  if (!snapshot) return true;
  const observed = Number.isFinite(eventCount) ? Number(eventCount) : 0;
  const stored = Number.isFinite(snapshot.eventCount) ? Number(snapshot.eventCount) : 0;
  return (observed - stored) >= SNAPSHOT_INTERVAL;
}

/**
 * Write a frozen snapshot under a custom file name (e.g. `pre-compact-<n>.json`).
 * Used by AgentSession.compact() to archive the state immediately before the
 * compaction so the original messages can always be reconstructed from
 * events.jsonl alone.
 */
export async function writeArchivedSnapshot({ homeDir = os.homedir(), sessionId, name, snapshot, encryptionKey = null }) {
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("writeArchivedSnapshot: name is required");
  }
  const filePath = path.join(getSessionDir({ homeDir, sessionId }), `${name}.json`);
  await mkdir(path.dirname(filePath), { recursive: true });
  const payload = {
    snapshotId: typeof snapshot?.snapshotId === "string" && snapshot.snapshotId.length > 0
      ? snapshot.snapshotId
      : randomUUID(),
    createdAt: typeof snapshot?.createdAt === "string" ? snapshot.createdAt : new Date().toISOString(),
    eventCount: Number.isFinite(snapshot?.eventCount) ? Number(snapshot.eventCount) : 0,
    messages: Array.isArray(snapshot?.messages) ? snapshot.messages : [],
    usage: normalizeUsage(snapshot?.usage),
    todos: Array.isArray(snapshot?.todos) ? snapshot.todos.map(normalizeTodo) : [],
    planMode: snapshot?.planMode ? normalizePlanMode(snapshot.planMode) : undefined,
    usageEvents: Array.isArray(snapshot?.usageEvents) ? snapshot.usageEvents : [],
    alwaysAllow: Array.isArray(snapshot?.alwaysAllow) ? snapshot.alwaysAllow : []
  };
  if (encryptionKey) {
    const buffer = encryptJson({ data: payload, key: encryptionKey });
    await writeFile(filePath, buffer);
  } else {
    await writeFile(filePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  }
  return { filePath, snapshot: payload };
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return { ...ZERO_USAGE };
  return {
    inputTokens: Number.isFinite(usage.inputTokens) ? Number(usage.inputTokens) : 0,
    outputTokens: Number.isFinite(usage.outputTokens) ? Number(usage.outputTokens) : 0,
    costUsd: Number.isFinite(usage.costUsd) ? Number(usage.costUsd) : 0
  };
}

const VALID_TODO_STATUS = new Set(["pending", "in_progress", "completed"]);

function normalizeTodo(todo) {
  if (!todo || typeof todo !== "object") return null;
  const id = typeof todo.id === "string" && todo.id.length > 0 ? todo.id : null;
  const content = typeof todo.content === "string" && todo.content.length > 0 ? todo.content : null;
  const status = VALID_TODO_STATUS.has(todo.status) ? todo.status : "pending";
  const activeForm = typeof todo.activeForm === "string" && todo.activeForm.length > 0 ? todo.activeForm : (content ?? "");
  if (!id || !content) return null;
  return { id, content, status, activeForm };
}

function normalizePlanMode(pm) {
  if (!pm || typeof pm !== "object") return undefined;
  const active = pm.active === true;
  const queue = Array.isArray(pm.queue) ? pm.queue.filter((e) => e && typeof e === "object") : [];
  return { active, queue };
}
