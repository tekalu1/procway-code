import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mergeSettings } from "../src/config/merge-settings.mjs";
import { DEFAULT_SETTINGS } from "../src/config/default-settings.mjs";
import { resolveContext } from "../src/context/context-resolver.mjs";

let tempDirs = [];
let homeFiles = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
  await Promise.all(homeFiles.map((file) => rm(file, { recursive: true, force: true })));
  homeFiles = [];
});

async function writeHomeClaude() {
  const userClaude = path.join(os.homedir(), ".claude", "CLAUDE.md");
  await mkdir(path.dirname(userClaude), { recursive: true });
  await writeFile(userClaude, "home claude instruction", "utf8");
  homeFiles.push(userClaude);
}

describe("resolveContext", () => {
  it("uses claude compatibility mode by default", async () => {
    const cwd = await makeWorkspace();
    await writeFile(path.join(cwd, "CLAUDE.md"), "claude instruction", "utf8");
    await writeFile(path.join(cwd, "AGENTS.md"), "codex instruction", "utf8");

    const context = await resolveContext({ cwd, settings: DEFAULT_SETTINGS });

    expect(context.compatibilityMode).toBe("claude");
    expect(context.instructions.map((item) => path.basename(item.path))).toEqual(["CLAUDE.md"]);
  });

  it("uses codex scanner when compatibilityMode is codex", async () => {
    const cwd = await makeWorkspace();
    await writeFile(path.join(cwd, "CLAUDE.md"), "claude instruction", "utf8");
    await writeFile(path.join(cwd, "AGENTS.md"), "codex instruction", "utf8");
    const settings = mergeSettings(DEFAULT_SETTINGS, {
      context: { compatibilityMode: "codex" }
    });

    const context = await resolveContext({ cwd, settings });

    expect(context.instructions.map((item) => path.basename(item.path))).toEqual(["AGENTS.md"]);
  });

  it("resolves CLAUDE.md from ./CLAUDE.md, ./.claude/CLAUDE.md and ~/.claude/CLAUDE.md in claude mode", async () => {
    const cwd = await makeWorkspace();
    await writeFile(path.join(cwd, "CLAUDE.md"), "claude instruction", "utf8");
    await mkdir(path.join(cwd, ".claude"), { recursive: true });
    await writeFile(path.join(cwd, ".claude", "CLAUDE.md"), "project dot claude instruction", "utf8");
    await writeHomeClaude();

    const context = await resolveContext({ cwd, settings: DEFAULT_SETTINGS });

    const paths = context.instructions.map((item) => item.path);
    expect(paths).toContain(path.join(cwd, "CLAUDE.md"));
    expect(paths).toContain(path.join(cwd, ".claude", "CLAUDE.md"));
    expect(paths).toContain(path.join(os.homedir(), ".claude", "CLAUDE.md"));
    // Nearest-most first: ./CLAUDE.md < ./.claude/CLAUDE.md < ~/.claude/CLAUDE.md.
    expect(context.instructions[0].path).toBe(path.join(cwd, "CLAUDE.md"));
    expect(context.instructions.filter((item) => item.path.endsWith("CLAUDE.md")).length).toBe(3);
  });

  it("resolves both CLAUDE.md and AGENTS.md locations in mixed mode", async () => {
    const cwd = await makeWorkspace();
    await writeFile(path.join(cwd, "CLAUDE.md"), "claude instruction", "utf8");
    await mkdir(path.join(cwd, ".claude"), { recursive: true });
    await writeFile(path.join(cwd, ".claude", "CLAUDE.md"), "project dot claude instruction", "utf8");
    await writeFile(path.join(cwd, "AGENTS.md"), "codex instruction", "utf8");
    const settings = mergeSettings(DEFAULT_SETTINGS, {
      context: { compatibilityMode: "mixed" }
    });

    const context = await resolveContext({ cwd, settings });

    const basenames = context.instructions.map((item) => path.basename(item.path));
    expect(basenames).toEqual(expect.arrayContaining(["CLAUDE.md", "AGENTS.md"]));
    expect(context.instructions.map((item) => path.basename(item.path))).toContain("CLAUDE.md");
    // mixed は .claude/CLAUDE.md も両方の読む場所を scan する
    expect(context.instructions.map((item) => item.path)).toContain(path.join(cwd, ".claude", "CLAUDE.md"));
  });

  it("does not read CLAUDE.md in codex mode (matches Codex behavior)", async () => {
    const cwd = await makeWorkspace();
    await writeFile(path.join(cwd, "CLAUDE.md"), "claude instruction", "utf8");
    await mkdir(path.join(cwd, ".claude"), { recursive: true });
    await writeFile(path.join(cwd, ".claude", "CLAUDE.md"), "project dot claude instruction", "utf8");
    await writeHomeClaude();
    await writeFile(path.join(cwd, "AGENTS.md"), "codex instruction", "utf8");
    const settings = mergeSettings(DEFAULT_SETTINGS, {
      context: { compatibilityMode: "codex" }
    });

    const context = await resolveContext({ cwd, settings });

    expect(context.instructions.map((item) => path.basename(item.path))).toEqual(["AGENTS.md"]);
  });

  it("scans direct skills directory in shared modes", async () => {
    const cwd = await makeWorkspace();
    await mkdir(path.join(cwd, "skills", "sample"), { recursive: true });
    await writeFile(path.join(cwd, "skills", "sample", "SKILL.md"), "# sample", "utf8");

    const context = await resolveContext({ cwd, settings: DEFAULT_SETTINGS });

    expect(context.skills.some((item) => item.path.endsWith(path.join("skills", "sample", "SKILL.md")))).toBe(true);
  });

  it("exposes Phase 7 v2 frontmatter when present", async () => {
    const cwd = await makeWorkspace();
    await mkdir(path.join(cwd, "skills", "v2"), { recursive: true });
    await writeFile(
      path.join(cwd, "skills", "v2", "SKILL.md"),
      "---\nname: v2-sample\ndescription: example\nallowed-tools: [\"read_file\"]\ntriggers: [\"sample\"]\n---\n\nbody",
      "utf8"
    );
    const context = await resolveContext({ cwd, settings: DEFAULT_SETTINGS });
    const v2 = context.skills.find((entry) => entry.name === "v2-sample");
    expect(v2?.version).toBe(2);
    expect(v2?.allowedTools).toEqual(["read_file"]);
    expect(v2?.triggers).toEqual(["sample"]);
  });
});

async function makeWorkspace() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "procway-code-"));
  tempDirs.push(dir);
  return dir;
}
