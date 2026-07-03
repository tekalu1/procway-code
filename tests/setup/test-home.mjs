/**
 * Per-test-file home directory isolation.
 *
 * After TK-137 the session store writes to `~/.procway/ai-agent/sessions/`
 * (resolved via `os.homedir()`), so anything that constructs an `AgentSession`
 * — or otherwise hits the store without an explicit `homeDir` override —
 * would otherwise pollute the developer's real home directory during tests.
 *
 * This setup file replaces `HOME` / `USERPROFILE` with a fresh temp
 * directory per test file. `os.homedir()` reads these env vars on each call
 * on modern Node, so any code that defaults `homeDir = os.homedir()` picks
 * up the temp location automatically.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

const testHome = mkdtempSync(path.join(os.tmpdir(), `procway-test-home-${process.pid}-`));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

afterAll(() => {
  try {
    rmSync(testHome, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // best-effort cleanup; the temp dir will be reclaimed by the OS.
  }
});
