import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve(import.meta.dirname, "../src/cli.mjs");
let tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("CLI config write scope", () => {
  it("writes config to user scope by default", async () => {
    const homeDir = await makeTempDir();
    const cwd = await makeTempDir();

    const { stdout } = await runCli(["config", "set", "approvalMode", "full-auto"], { cwd, homeDir });
    const result = JSON.parse(stdout);

    expect(result.scope).toBe("user");
    expect(result.path).toBe(path.join(homeDir, ".procway", "ai-agent", "settings.json"));
    await expect(readJson(result.path)).resolves.toEqual({ approvalMode: "full-auto" });
  });

  it("writes config to workspace scope only when requested", async () => {
    const homeDir = await makeTempDir();
    const cwd = await makeTempDir();

    const { stdout } = await runCli([
      "config", "set", "--scope", "workspace", "approvalMode", "auto-readonly"
    ], { cwd, homeDir });
    const result = JSON.parse(stdout);

    expect(result.scope).toBe("workspace");
    expect(result.path).toBe(path.join(cwd, ".procway", "ai-agent", "settings.json"));
    await expect(readJson(result.path)).resolves.toEqual({ approvalMode: "auto-readonly" });
  });

  it("rejects an unknown scope", async () => {
    const homeDir = await makeTempDir();
    const cwd = await makeTempDir();

    await expect(runCli(["config", "set", "--scope", "project", "approvalMode", "full-auto"], { cwd, homeDir }))
      .rejects.toMatchObject({ stderr: expect.stringContaining("--scope must be user or workspace") });
  });
});

async function runCli(args, { cwd, homeDir }) {
  return execFileAsync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    env: { ...process.env, HOME: homeDir }
  });
}

async function makeTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "procway-cli-scope-"));
  tempDirs.push(dir);
  // On macOS `os.tmpdir()` is `/var/folders/...`, a symlink to
  // `/private/var/folders/...`. The CLI resolves --cwd/HOME to a real path, so
  // comparing against the unresolved temp path fails there and only there.
  return realpath(dir);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}
