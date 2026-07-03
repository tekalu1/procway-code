import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resumeCommand } from "../src/core/commands/resume.mjs";
import { getSessionsDir } from "../src/session/store.mjs";

let cwd;

beforeEach(async () => {
  // Migration runs against the test-isolated home directory (see
  // tests/setup/test-home.mjs). `cwd` here is the workspace path recorded
  // in meta.cwd — it doesn't need to physically exist for these tests.
  cwd = path.join(process.cwd(), `procway-cli-migrate-${Date.now()}`);
});

afterEach(async () => {
  await rm(getSessionsDir(), { recursive: true, force: true, maxRetries: 5 });
});

async function writeLegacySession(workspace, sessionId) {
  const sessionsDir = getSessionsDir();
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(path.join(sessionsDir, `${sessionId}.state.json`), JSON.stringify({
    sessionId,
    title: "legacy",
    cwd: workspace,
    provider: "test",
    model: "test-model",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" }
    ]
  }), "utf8");
  await writeFile(path.join(sessionsDir, `${sessionId}.jsonl`), "", "utf8");
}

describe("CLI migrate hooks (phase3_E-3)", () => {
  it("resumeCommand migrates legacy sessions before loading state", async () => {
    await writeLegacySession(cwd, "legacy-resume");
    const result = await resumeCommand({ cwd, sessionId: "legacy-resume" });
    expect(result.sessionId).toBe("legacy-resume");
    expect(Array.isArray(result.state.messages)).toBe(true);
    expect(result.state.messages.length).toBeGreaterThan(0);
  });

  it("resumeCommand returns the session list when sessionId is omitted", async () => {
    await writeLegacySession(cwd, "legacy-pick");
    const result = await resumeCommand({ cwd: null });
    expect(result.sessions.map((s) => s.sessionId)).toContain("legacy-pick");
  });
});
