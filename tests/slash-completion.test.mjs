import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SLASH_COMMANDS, createSlashCompleter, describeCommand, formatMenu, findSkillMd, isBuiltinSlashCommand, slashCommandName } from "../src/adapters/tui/slash-completion.mjs";

describe("slash completion", () => {
  it("lists the canonical commands and includes Phase 7 additions", () => {
    const names = SLASH_COMMANDS.map((entry) => entry.name);
    expect(names).toEqual(expect.arrayContaining(["/plan", "/todos", "/memory", "/branch", "/exit"]));
  });

  it("returns prefix matches via the completer", () => {
    const complete = createSlashCompleter();
    const [matches] = complete("/co");
    expect(matches).toEqual(expect.arrayContaining(["/compact", "/config", "/context"]));
  });

  it("returns no matches when the line is not a slash command", () => {
    const complete = createSlashCompleter();
    const [matches] = complete("hello world");
    expect(matches).toHaveLength(0);
  });

  it("formats a menu with descriptions and arg hints", () => {
    const menu = formatMenu("/br", { width: 200 });
    expect(menu).toContain("/branch");
    expect(menu).toContain("from <messageId>");
  });

  it("describeCommand returns the entry by name", () => {
    expect(describeCommand("/plan")?.description).toMatch(/plan mode/i);
    expect(describeCommand("/missing")).toBeNull();
  });
});

describe("slashCommandName", () => {
  it("strips leading slash", () => {
    expect(slashCommandName("/procway")).toBe("procway");
  });

  it("strips leading slash with trailing spaces", () => {
    expect(slashCommandName("/vitest ")).toBe("vitest");
  });

  it("returns empty for empty input", () => {
    expect(slashCommandName("")).toBe("");
    expect(slashCommandName(null)).toBe("");
  });

  it("returns the whole word after slash", () => {
    expect(slashCommandName("/stripe")).toBe("stripe");
  });
});

describe("isBuiltinSlashCommand", () => {
  it("returns true for known commands", () => {
    expect(isBuiltinSlashCommand("/exit")).toBe(true);
    expect(isBuiltinSlashCommand("/plan")).toBe(true);
    expect(isBuiltinSlashCommand("/todos")).toBe(true);
  });

  it("returns true for known bare names (without slash)", () => {
    expect(isBuiltinSlashCommand("exit")).toBe(true);
    expect(isBuiltinSlashCommand("config")).toBe(true);
  });

  it("returns false for unknown commands", () => {
    expect(isBuiltinSlashCommand("/procway")).toBe(false);
    expect(isBuiltinSlashCommand("/vitest")).toBe(false);
    expect(isBuiltinSlashCommand("")).toBe(false);
  });
});

describe("findSkillMd", () => {
  it("returns null for empty name", async () => {
    const result = await findSkillMd({ cwd: process.cwd(), name: "" });
    expect(result).toBeNull();
  });

  it("returns null for invalid name (special chars only)", async () => {
    const result = await findSkillMd({ cwd: process.cwd(), name: "///" });
    expect(result).toBeNull();
  });

  it("returns null when SKILL.md does not exist", async () => {
    const result = await findSkillMd({ cwd: process.cwd(), name: "nonexistent-skill-12345" });
    expect(result).toBeNull();
  });

  it("finds and reads a real SKILL.md from skills/{name}/SKILL.md", async () => {
    // Self-contained temp workspace: must not depend on the monorepo's
    // skills/ tree — this suite also runs standalone in the published
    // procway-code repo, where ai-agent is the repo root and no skills/
    // directory exists.
    const cwd = await makeSlashTempDir();
    await writeSkillMd(cwd, "skills/vitest", "# vitest skill\n\nTest management skill.\n");
    const result = await findSkillMd({ cwd, name: "vitest" });
    expect(result).not.toBeNull();
    expect(result.name).toBe("vitest");
    expect(result.path).toContain("skills");
    expect(result.path).toContain("SKILL.md");
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content).toContain("# "); // markdown heading
  });

  it("finds SKILL.md from .claude/skills first (higher priority)", async () => {
    // Use a tmp workspace with both locations populated so the assertion
    // does not depend on `pnpm sync:claude-skills` having been run locally
    // (the .claude/skills/ tree is gitignored as a sync artifact).
    const cwd = await makeSlashTempDir();
    await writeSkillMd(cwd, ".claude/skills/procway", "# procway (from .claude)\n");
    await writeSkillMd(cwd, "skills/procway", "# procway (from skills)\n");

    const result = await findSkillMd({ cwd, name: "procway" });
    expect(result).not.toBeNull();
    expect(result.name).toBe("procway");
    expect(result.path).toContain(".claude");
    expect(result.content).toContain("from .claude");
  });
});

let slashTempDirs = [];

afterEach(async () => {
  await Promise.all(slashTempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  slashTempDirs = [];
});

async function makeSlashTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "procway-slash-"));
  slashTempDirs.push(dir);
  return dir;
}

async function writeSkillMd(root, relativeDir, content) {
  const dir = path.join(root, relativeDir);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), content, "utf8");
}
