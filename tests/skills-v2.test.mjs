import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scanSkills, filterSkillsByTrigger } from "../src/context/skill-scanner.mjs";
import { DEFAULT_SETTINGS } from "../src/config/default-settings.mjs";

let cwd;
beforeEach(async () => { cwd = await mkdtemp(path.join(os.tmpdir(), "procway-skills2-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

async function writeSkill(relPath, body) {
  const fullPath = path.join(cwd, relPath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, body, "utf8");
}

describe("skills v2", () => {
  it("parses YAML frontmatter and exposes structured fields", async () => {
    const frontmatter = [
      "---",
      "name: vitest",
      "description: Vitest workflow",
      "allowed-tools: [\"read_file\", \"run_shell\"]",
      "scope: this-repo",
      "triggers: [\"vitest\", \"test\", \".test.mjs\"]",
      "priority: 75",
      "---",
      "",
      "Run vitest with `pnpm test`.",
      ""
    ].join("\n");
    await writeSkill("skills/vitest/SKILL.md", frontmatter);
    const skills = await scanSkills({ cwd, settings: DEFAULT_SETTINGS });
    const vitest = skills.find((entry) => entry.name === "vitest");
    expect(vitest).toBeTruthy();
    expect(vitest.version).toBe(2);
    expect(vitest.allowedTools).toEqual(["read_file", "run_shell"]);
    expect(vitest.triggers).toEqual(["vitest", "test", ".test.mjs"]);
    expect(vitest.scope).toBe("this-repo");
    expect(vitest.priority).toBe(75);
  });

  it("treats files without frontmatter as v1 (always-on, scanner priority)", async () => {
    await writeSkill("skills/legacy/SKILL.md", "# Legacy skill\nNo frontmatter.\n");
    const skills = await scanSkills({ cwd, settings: DEFAULT_SETTINGS });
    const legacy = skills.find((entry) => entry.path.includes("legacy"));
    expect(legacy?.version).toBe(1);
    expect(legacy?.allowedTools).toBeNull();
  });

  it("filterSkillsByTrigger keeps v1 always and gates v2 by trigger match", async () => {
    await writeSkill("skills/legacy/SKILL.md", "# Legacy");
    await writeSkill("skills/vitest/SKILL.md", "---\nname: vitest\ndescription: x\ntriggers: [vitest, test]\n---\n\nbody");
    const skills = await scanSkills({ cwd, settings: DEFAULT_SETTINGS });
    const filtered = filterSkillsByTrigger(skills, "please run pnpm test", { workspaceDir: cwd });
    expect(filtered.find((entry) => entry.name === "vitest")).toBeTruthy();
    expect(filtered.find((entry) => entry.path.includes("legacy"))).toBeTruthy();

    const filteredEmpty = filterSkillsByTrigger(skills, "", { workspaceDir: cwd });
    expect(filteredEmpty.find((entry) => entry.name === "vitest")).toBeFalsy();
    expect(filteredEmpty.find((entry) => entry.path.includes("legacy"))).toBeTruthy();
  });

  it("respects scope: this-repo by filtering skills outside the workspace", async () => {
    const otherCwd = await mkdtemp(path.join(os.tmpdir(), "procway-skills2-other-"));
    try {
      await writeSkill("skills/local/SKILL.md", "---\nname: local\ndescription: x\nscope: this-repo\ntriggers: [local]\n---\nbody");
      const skills = await scanSkills({ cwd, settings: DEFAULT_SETTINGS });
      const filtered = filterSkillsByTrigger(skills, "local action", { workspaceDir: otherCwd });
      expect(filtered.find((entry) => entry.name === "local")).toBeFalsy();
    } finally {
      await rm(otherCwd, { recursive: true, force: true });
    }
  });

  it("loads user-scope claude skills from ~/.claude/skills in claude mode", async () => {
    // tests/setup/test-home.mjs redirects os.homedir() to a fresh temp dir
    // per test file, so writing under the home dir is safe and isolated.
    const home = os.homedir();
    const userSkillPath = path.join(home, ".claude", "skills", "user-skill", "SKILL.md");
    await mkdir(path.dirname(userSkillPath), { recursive: true });
    await writeFile(userSkillPath, "# user skill", "utf8");
    try {
      const skills = await scanSkills({ cwd, settings: DEFAULT_SETTINGS });
      const userSkill = skills.find((entry) => entry.path.endsWith(path.join(".claude", "skills", "user-skill", "SKILL.md")));
      expect(userSkill).toBeTruthy();
      expect(userSkill.scannerId).toBe("user-claude-skills");
    } finally {
      await rm(path.join(home, ".claude"), { recursive: true, force: true });
    }
  });

  it("does not list a skill twice when cwd is the home dir (./.claude/skills == ~/.claude/skills)", async () => {
    const home = os.homedir();
    const skillPath = path.join(home, ".claude", "skills", "home-skill", "SKILL.md");
    await mkdir(path.dirname(skillPath), { recursive: true });
    await writeFile(skillPath, "# home skill", "utf8");
    try {
      const skills = await scanSkills({ cwd: home, settings: DEFAULT_SETTINGS });
      const matches = skills.filter((entry) => entry.name === "home-skill");
      expect(matches).toHaveLength(1);
      expect(matches[0].scannerId).toBe("claude-skills");
    } finally {
      await rm(path.join(home, ".claude"), { recursive: true, force: true });
    }
  });
});
