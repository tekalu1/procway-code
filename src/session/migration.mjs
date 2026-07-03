import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isAgentEvent } from "../core/events/types.mjs";
import { getSessionDir, getSessionsDir, writeMeta } from "./store.mjs";
import { writeSnapshot } from "./snapshot.mjs";
import { upsertSessionIndex } from "./session-index.mjs";

const LEGACY_DIR_NAME = ".legacy";

/**
 * Walk `~/.procway/ai-agent/sessions/` and convert any legacy
 * `<id>.state.json` / `<id>.jsonl` pair (a pre-Phase-3 flat layout) into the
 * directory layout (`<id>/{events.jsonl, snapshot.json, meta.json}`).
 *
 * - Idempotent: sessions already in the new layout are skipped.
 * - Safe by default: legacy files are moved to `.legacy/` (not deleted) so
 *   a botched migration can still be recovered.
 * - `dryRun: true` reports what would change without touching the filesystem.
 *
 * Note: this migration is independent of the workspace→home relocation. The
 * old workspace-local `<cwd>/.procway/ai-agent/sessions/` directory is not
 * scanned — users who upgrade are expected to start fresh in `~/`.
 */
export async function migrateLegacyFormatIfNeeded({ homeDir = os.homedir(), dryRun = false } = {}) {
  const sessionsDir = getSessionsDir({ homeDir });
  if (!existsSync(sessionsDir)) {
    return { migrated: [], skipped: [], failed: [], dir: sessionsDir, dryRun };
  }
  let entries;
  try {
    entries = await readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return { migrated: [], skipped: [], failed: [], dir: sessionsDir, dryRun };
  }
  const stateFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".state.json"));
  const migrated = [];
  const skipped = [];
  const failed = [];
  for (const entry of stateFiles) {
    const sessionId = entry.name.replace(/\.state\.json$/, "");
    try {
      const result = await migrateOne({ homeDir, sessionId, dryRun });
      if (result.migrated) migrated.push(result);
      else skipped.push(result);
    } catch (error) {
      failed.push({ sessionId, error: error?.message ?? String(error) });
    }
  }
  return { migrated, skipped, failed, dir: sessionsDir, dryRun };
}

async function migrateOne({ homeDir, sessionId, dryRun }) {
  const sessionsDir = getSessionsDir({ homeDir });
  const statePath = path.join(sessionsDir, `${sessionId}.state.json`);
  const logPath = path.join(sessionsDir, `${sessionId}.jsonl`);
  const newDir = getSessionDir({ homeDir, sessionId });

  if (existsSync(newDir)) {
    return { sessionId, migrated: false, reason: "new-layout-already-exists" };
  }

  let state;
  try {
    state = JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    return { sessionId, migrated: false, reason: `state.json parse error: ${error?.message ?? String(error)}` };
  }
  const messages = Array.isArray(state.messages) ? state.messages : [];
  const migrationNotes = [];
  const events = [];
  if (existsSync(logPath)) {
    let logContent;
    try {
      logContent = await readFile(logPath, "utf8");
    } catch (error) {
      migrationNotes.push(`failed to read legacy log: ${error?.message ?? String(error)}`);
      logContent = "";
    }
    for (const line of logContent.split("\n")) {
      if (!line) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        migrationNotes.push("skipped invalid jsonl line");
        continue;
      }
      if (isAgentEvent(parsed)) {
        events.push(parsed);
      } else {
        migrationNotes.push(`skipped legacy log entry type=${String(parsed?.type ?? "(none)")}`);
      }
    }
  }

  const updatedAt = state.updatedAt ?? new Date().toISOString();

  if (dryRun) {
    return {
      sessionId,
      migrated: true,
      dryRun: true,
      messageCount: messages.length,
      eventCount: events.length,
      migrationNotes
    };
  }

  await mkdir(newDir, { recursive: true });
  if (events.length > 0) {
    const eventsPath = path.join(newDir, "events.jsonl");
    const lines = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
    await writeFile(eventsPath, lines, "utf8");
  }
  await writeSnapshot({
    homeDir,
    sessionId,
    snapshot: { eventCount: events.length, messages }
  });
  await writeMeta({
    homeDir,
    sessionId,
    meta: {
      sessionId,
      title: state.title ?? null,
      cwd: state.cwd ?? null,
      provider: state.provider ?? null,
      model: state.model ?? null,
      updatedAt,
      messageCount: messages.length,
      migrationNotes
    }
  });
  await upsertSessionIndex({
    homeDir,
    sessionId,
    entry: {
      title: state.title ?? null,
      provider: state.provider ?? null,
      model: state.model ?? null,
      updatedAt,
      messageCount: messages.length
    }
  });

  const legacyDir = path.join(sessionsDir, LEGACY_DIR_NAME);
  await mkdir(legacyDir, { recursive: true });
  await rename(statePath, path.join(legacyDir, `${sessionId}.state.json`));
  if (existsSync(logPath)) {
    await rename(logPath, path.join(legacyDir, `${sessionId}.jsonl`));
  }

  return {
    sessionId,
    migrated: true,
    messageCount: messages.length,
    eventCount: events.length,
    migrationNotes
  };
}
