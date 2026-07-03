import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateLegacyFormatIfNeeded } from "../src/session/migration.mjs";
import { getSessionsDir, getSessionPaths, listSessions, loadSessionState } from "../src/session/store.mjs";
import { readEventLog } from "../src/session/event-log.mjs";
import { createEvent } from "../src/core/events/types.mjs";

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

function makeHomeWithLegacyFixture() {
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "procway-migration-"));
  tempDirs.push(homeDir);
  const dir = getSessionsDir({ homeDir });
  mkdirSync(dir, { recursive: true });
  const sessionId = "2026-01-01T00-00-00-000Z";
  const workspace = "/proj/legacy";
  const state = {
    sessionId,
    title: "legacy",
    cwd: workspace,
    provider: "openrouter",
    model: "model-legacy",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messages: [
      { role: "system", content: "system bootstrap" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" }
    ]
  };
  writeFileSync(path.join(dir, `${sessionId}.state.json`), JSON.stringify(state, null, 2), "utf8");
  // Mix of new-style AgentEvents (which should survive) and legacy log entries
  // (which should be skipped + logged in migrationNotes).
  const legacyLog = [
    { time: "2026-01-01T00:00:00.000Z", type: "session_start", cwd: workspace, provider: "openrouter", model: "model-legacy" },
    createEvent("user.prompt.submitted", {
      sessionId,
      messageId: "m-u",
      content: [{ kind: "text", text: "hello" }]
    }),
    { time: "2026-01-01T00:00:01.000Z", type: "model_request", round: 0 },
    "this line is not even json",
    createEvent("assistant.message.completed", {
      sessionId,
      messageId: "m-a",
      content: [{ kind: "text", text: "hi" }]
    })
  ];
  const lines = legacyLog
    .map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)))
    .join("\n") + "\n";
  writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines, "utf8");
  return { homeDir, workspace, sessionId };
}

describe("migrateLegacyFormatIfNeeded", () => {
  it("converts legacy <id>.state.json + <id>.jsonl into the Phase 3 layout", async () => {
    const { homeDir, workspace, sessionId } = makeHomeWithLegacyFixture();

    const result = await migrateLegacyFormatIfNeeded({ homeDir });
    expect(result.migrated).toHaveLength(1);
    expect(result.migrated[0]).toEqual(expect.objectContaining({
      sessionId,
      messageCount: 3,
      eventCount: 2
    }));
    expect(result.failed).toEqual([]);

    const paths = getSessionPaths({ homeDir, sessionId });
    expect(existsSync(paths.snapshotPath)).toBe(true);
    expect(existsSync(paths.metaPath)).toBe(true);
    expect(existsSync(paths.eventsPath)).toBe(true);

    const events = await readEventLog({ homeDir, sessionId });
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("user.prompt.submitted");
    expect(events[1].type).toBe("assistant.message.completed");

    const meta = JSON.parse(readFileSync(paths.metaPath, "utf8"));
    expect(meta).toEqual(expect.objectContaining({
      sessionId,
      title: "legacy",
      cwd: workspace,
      provider: "openrouter",
      model: "model-legacy",
      messageCount: 3
    }));
    expect(Array.isArray(meta.migrationNotes)).toBe(true);
    expect(meta.migrationNotes.length).toBeGreaterThan(0);

    // Legacy files should be moved into `.legacy/`, not deleted outright.
    const legacyDir = path.join(getSessionsDir({ homeDir }), ".legacy");
    expect(existsSync(path.join(legacyDir, `${sessionId}.state.json`))).toBe(true);
    expect(existsSync(path.join(legacyDir, `${sessionId}.jsonl`))).toBe(true);
    expect(existsSync(path.join(getSessionsDir({ homeDir }), `${sessionId}.state.json`))).toBe(false);

    const { sessions } = await listSessions({ homeDir, cwd: null });
    expect(sessions.map((session) => session.sessionId)).toContain(sessionId);

    const loaded = await loadSessionState({ homeDir, sessionId });
    expect(loaded.title).toBe("legacy");
    expect(loaded.messages).toHaveLength(3);
  });

  it("dryRun reports the same outcome without touching the filesystem", async () => {
    const { homeDir, sessionId } = makeHomeWithLegacyFixture();
    const result = await migrateLegacyFormatIfNeeded({ homeDir, dryRun: true });
    expect(result.migrated).toHaveLength(1);
    expect(result.migrated[0]).toEqual(expect.objectContaining({
      sessionId,
      dryRun: true,
      messageCount: 3,
      eventCount: 2
    }));
    // Files must remain untouched.
    expect(existsSync(path.join(getSessionsDir({ homeDir }), `${sessionId}.state.json`))).toBe(true);
    expect(existsSync(path.join(getSessionsDir({ homeDir }), `${sessionId}.jsonl`))).toBe(true);
    const paths = getSessionPaths({ homeDir, sessionId });
    expect(existsSync(paths.snapshotPath)).toBe(false);
  });

  it("is idempotent — re-running after migration becomes a no-op", async () => {
    const { homeDir, sessionId } = makeHomeWithLegacyFixture();
    await migrateLegacyFormatIfNeeded({ homeDir });
    const second = await migrateLegacyFormatIfNeeded({ homeDir });
    expect(second.migrated).toEqual([]);
    expect(second.skipped.length + second.failed.length + second.migrated.length).toBe(0);
    void sessionId;
  });

  it("returns an empty result when no sessions directory exists", async () => {
    const homeDir = mkdtempSync(path.join(os.tmpdir(), "procway-migration-empty-"));
    tempDirs.push(homeDir);
    const result = await migrateLegacyFormatIfNeeded({ homeDir });
    expect(result.migrated).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([]);
  });
});
