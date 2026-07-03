import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildSystemMessage,
  renderSkillsSection,
  refreshSystemMessageSkills,
  renderProjectContextSection,
  renderUserEnvSection,
  renderRulesSection,
  refreshSystemMessageRules
} from "../src/agent/prompt-builder.mjs";
import { resolveSessionRules } from "../src/context/context-resolver.mjs";
import { createMessage } from "../src/core/types/message.mjs";

let cwd;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "procway-prompt-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function makeSkill(overrides = {}) {
  return {
    type: "skill",
    scannerId: "repo-skills",
    compatibility: "shared",
    priority: 80,
    path: "/work/skills/vitest/SKILL.md",
    name: "vitest",
    description: "Vitest workflow",
    ...overrides
  };
}

function makeContext({ skills = [], rules = [] } = {}) {
  return { compatibilityMode: "claude", instructions: [], skills, rules };
}

describe("renderSkillsSection", () => {
  it("lists each skill as name, single-line description, and SKILL.md path", () => {
    const section = renderSkillsSection([makeSkill()]);
    expect(section).toContain("## Available Skills");
    expect(section).toContain("- vitest: Vitest workflow (/work/skills/vitest/SKILL.md)");
  });

  it("includes the read_file usage instruction when skills exist", () => {
    const section = renderSkillsSection([makeSkill()]);
    expect(section).toContain("read its SKILL.md with read_file first and follow its instructions");
  });

  it("omits the description separator when the skill has no description", () => {
    const section = renderSkillsSection([makeSkill({ description: "" })]);
    expect(section).toContain("- vitest (/work/skills/vitest/SKILL.md)");
    expect(section).not.toContain("- vitest:");
  });

  it("falls back to the skill directory name when name is missing", () => {
    const section = renderSkillsSection([makeSkill({ name: "", description: "" })]);
    expect(section).toContain("- vitest (/work/skills/vitest/SKILL.md)");
  });

  it("collapses multi-line descriptions to their first line and truncates long ones", () => {
    const longLine = "x".repeat(300);
    const section = renderSkillsSection([
      makeSkill({ name: "multi", description: "first line\nsecond line" }),
      makeSkill({ name: "long", path: "/work/skills/long/SKILL.md", description: longLine })
    ]);
    expect(section).toContain("- multi: first line (");
    expect(section).not.toContain("second line");
    expect(section).toContain(`- long: ${"x".repeat(200)}... (`);
  });

  it("renders a placeholder (without usage note) when no skills are discovered", () => {
    const section = renderSkillsSection([]);
    expect(section).toBe("## Available Skills\n(no skills discovered)");
  });

  it("caps the list at 40 skills", () => {
    const skills = Array.from({ length: 50 }, (_, index) =>
      makeSkill({ name: `skill-${index}`, path: `/work/skills/skill-${index}/SKILL.md`, description: "" })
    );
    const section = renderSkillsSection(skills);
    expect(section).toContain("- skill-39 ");
    expect(section).not.toContain("- skill-40 ");
  });
});

describe("renderUserEnvSection (ADR 0024)", () => {
  it("returns null for an empty / non-array summary", () => {
    expect(renderUserEnvSection([])).toBeNull();
    expect(renderUserEnvSection(null)).toBeNull();
    expect(renderUserEnvSection(undefined)).toBeNull();
  });

  it("lists key names and marks secrets, never values", () => {
    const section = renderUserEnvSection([
      { key: "DATABASE_URL", isSecret: false },
      { key: "API_TOKEN", isSecret: true }
    ]);
    expect(section).toContain("## Available Environment Variables");
    expect(section).toContain("- DATABASE_URL");
    expect(section).toContain("- API_TOKEN (secret)");
    // guidance to reference via $NAME and never print secrets
    expect(section).toContain("$NAME");
    expect(section.toLowerCase()).toContain("never print");
  });

  it("ADR 0024 Phase 3: advertises switchable projects + the load_project_env tool", () => {
    const section = renderUserEnvSection([{ key: "X", isSecret: false }], {
      availableProjects: ["shop", "billing"]
    });
    expect(section).toContain("load_project_env");
    expect(section).toContain("shop");
    expect(section).toContain("billing");
  });

  it("renders for projects-only (no env yet) and null when truly empty", () => {
    const projectsOnly = renderUserEnvSection([], { availableProjects: ["shop"] });
    expect(projectsOnly).toContain("load_project_env");
    expect(projectsOnly).toContain("shop");
    expect(renderUserEnvSection([], { availableProjects: [] })).toBeNull();
    expect(renderUserEnvSection([])).toBeNull();
  });
});

describe("renderProjectContextSection", () => {
  it("returns null when PROCWAY_SESSION_PROJECT is unset", () => {
    expect(renderProjectContextSection({})).toBeNull();
    expect(renderProjectContextSection({ PROCWAY_SESSION_PROJECT: "  " })).toBeNull();
  });

  it("points at the shared workspace tree derived from the file:// workspace URI", () => {
    const section = renderProjectContextSection({
      PROCWAY_SESSION_PROJECT: "popism-v2",
      PROCWAY_WORKSPACE_URI: "file:///procway-workspaces"
    });
    expect(section).toContain("## Project Context");
    expect(section).toContain('project "popism-v2"');
    expect(section).toContain("/procway-workspaces/projects/popism-v2/production/code/<repo>");
    expect(section).toContain("/procway-workspaces/projects/popism-v2/backlogs/<ticketId>/code/<repo>");
    expect(section).toContain("starts EMPTY");
  });

  it("defaults the workspace root when the URI is missing and accepts a bare path", () => {
    expect(renderProjectContextSection({ PROCWAY_SESSION_PROJECT: "p" }))
      .toContain("/procway-workspaces/projects/p/production/code/<repo>");
    expect(renderProjectContextSection({
      PROCWAY_SESSION_PROJECT: "p",
      PROCWAY_WORKSPACE_URI: "/data/ws/"
    })).toContain("/data/ws/projects/p/production/code/<repo>");
  });
});

describe("renderRulesSection (all-sessions Rules)", () => {
  it("returns null when there are no rules (section omitted)", () => {
    expect(renderRulesSection([])).toBeNull();
    expect(renderRulesSection(null)).toBeNull();
    expect(renderRulesSection(undefined)).toBeNull();
    expect(renderRulesSection(["  ", ""])).toBeNull();
  });

  it("renders the forced ## Rules header + usage note + a single body", () => {
    const section = renderRulesSection(["Always write tests."]);
    expect(section).toContain("## Rules");
    expect(section).toContain("forced, high-priority");
    expect(section).toContain("Always write tests.");
  });

  it("joins multiple bodies with the --- ruler (core composeRulesSections convention)", () => {
    const section = renderRulesSection(["rule one", "rule two", "rule three"]);
    expect(section).toBe(
      "## Rules\nThese are forced, high-priority operating rules for every session. Follow them.\n\n"
      + "rule one\n\n---\n\nrule two\n\n---\n\nrule three"
    );
  });

  it("trims bodies and drops blank ones", () => {
    const section = renderRulesSection(["  a  ", "   ", "b"]);
    expect(section).toContain("a\n\n---\n\nb");
    expect(section).not.toMatch(/---\n\n\s*---/);
  });
});

describe("buildSystemMessage — ## Rules placement", () => {
  it("injects ## Rules near the top: after base instructions, before ## Instructions / ## Available Skills", async () => {
    const message = await buildSystemMessage({
      cwd,
      context: makeContext({ skills: [makeSkill()], rules: ["Forced rule body"] }),
      sessionId: "s1"
    });
    const text = message.content[0].text;
    expect(text).toContain("## Rules");
    expect(text).toContain("Forced rule body");
    // Prominent placement: before Root Entries, Instructions, and Skills.
    expect(text.indexOf("## Rules")).toBeLessThan(text.indexOf("## Root Entries"));
    expect(text.indexOf("## Rules")).toBeLessThan(text.indexOf("## Instructions"));
    expect(text.indexOf("## Rules")).toBeLessThan(text.indexOf("## Available Skills"));
    // After the base agent instruction block.
    expect(text.indexOf("You are procway-code")).toBeLessThan(text.indexOf("## Rules"));
  });

  it("places ## Rules before ## Project Context in a project-scoped session", async () => {
    const prev = process.env.PROCWAY_SESSION_PROJECT;
    process.env.PROCWAY_SESSION_PROJECT = "shop";
    try {
      const message = await buildSystemMessage({
        cwd,
        context: makeContext({ rules: ["Forced rule body"] }),
        sessionId: "s1"
      });
      const text = message.content[0].text;
      expect(text.indexOf("## Rules")).toBeLessThan(text.indexOf("## Project Context"));
    } finally {
      if (prev === undefined) delete process.env.PROCWAY_SESSION_PROJECT;
      else process.env.PROCWAY_SESSION_PROJECT = prev;
    }
  });

  it("omits the ## Rules section entirely when there are no rules (no regression)", async () => {
    const message = await buildSystemMessage({
      cwd,
      context: makeContext({ skills: [makeSkill()] }),
      sessionId: "s1"
    });
    expect(message.content[0].text).not.toContain("## Rules");
  });
});

describe("refreshSystemMessageRules", () => {
  it("swaps an existing ## Rules section on resume, preserving surrounding sections", async () => {
    const message = await buildSystemMessage({
      cwd,
      context: makeContext({ skills: [makeSkill()], rules: ["old rule"] }),
      sessionId: "s1"
    });
    const replaced = refreshSystemMessageRules(message, ["new rule a", "new rule b"]);
    expect(replaced).toBe(true);
    const text = message.content[0].text;
    expect(text).toContain("new rule a\n\n---\n\nnew rule b");
    expect(text).not.toContain("old rule");
    // Surrounding sections survive and ordering holds.
    expect(text).toContain("## Available Skills");
    expect(text.indexOf("## Rules")).toBeLessThan(text.indexOf("## Available Skills"));
  });

  it("drops the ## Rules section when rules become empty on resume", async () => {
    const message = await buildSystemMessage({
      cwd,
      context: makeContext({ skills: [makeSkill()], rules: ["old rule"] }),
      sessionId: "s1"
    });
    const replaced = refreshSystemMessageRules(message, []);
    expect(replaced).toBe(true);
    const text = message.content[0].text;
    expect(text).not.toContain("## Rules");
    expect(text).not.toContain("old rule");
    // Adjacent sections remain intact.
    expect(text).toContain("## Root Entries");
    expect(text).toContain("## Available Skills");
  });

  it("returns false when there is no ## Rules section to swap", async () => {
    const message = await buildSystemMessage({
      cwd,
      context: makeContext({ skills: [makeSkill()] }),
      sessionId: "s1"
    });
    expect(refreshSystemMessageRules(message, ["x"])).toBe(false);
  });

  it("does not leak stale rule content when the OLD body embeds a '## ' header", async () => {
    const message = await buildSystemMessage({
      cwd,
      context: makeContext({
        skills: [makeSkill()],
        rules: ["Old rule.\n\n## Section A\nold detail."]
      }),
      sessionId: "s1"
    });
    const replaced = refreshSystemMessageRules(message, ["brand new rule"]);
    expect(replaced).toBe(true);
    const text = message.content[0].text;
    expect(text).toContain("brand new rule");
    // The old body and its embedded header must be fully gone.
    expect(text).not.toContain("## Section A");
    expect(text).not.toContain("old detail.");
    expect(text).not.toContain("Old rule.");
    // The next real section is still intact and correctly ordered.
    expect(text).toContain("## Available Skills");
    expect(text.indexOf("## Rules")).toBeLessThan(text.indexOf("## Available Skills"));
  });

  it("fully removes a ## Rules section whose OLD body embeds a '## ' header when rules become empty", async () => {
    const message = await buildSystemMessage({
      cwd,
      context: makeContext({
        skills: [makeSkill()],
        rules: ["Old rule.\n\n## Section A\nold detail."]
      }),
      sessionId: "s1"
    });
    const replaced = refreshSystemMessageRules(message, []);
    expect(replaced).toBe(true);
    const text = message.content[0].text;
    expect(text).not.toContain("## Rules");
    expect(text).not.toContain("## Section A");
    expect(text).not.toContain("old detail.");
    // Adjacent sections survive (no orphaning of the prompt tail).
    expect(text).toContain("## Root Entries");
    expect(text).toContain("## Available Skills");
  });
});

describe("resolveSessionRules (bucket selection)", () => {
  const settings = {
    rules: {
      all: ["global rule"],
      projects: { shop: ["shop resolved rule"] }
    }
  };

  it("picks the project bucket when PROCWAY_SESSION_PROJECT matches a bucket", () => {
    expect(resolveSessionRules(settings, { PROCWAY_SESSION_PROJECT: "shop" }))
      .toEqual(["shop resolved rule"]);
  });

  it("falls back to the global `all` bucket for a tenant-global session", () => {
    expect(resolveSessionRules(settings, {})).toEqual(["global rule"]);
  });

  it("falls back to `all` when the project has no bucket", () => {
    expect(resolveSessionRules(settings, { PROCWAY_SESSION_PROJECT: "unknown" }))
      .toEqual(["global rule"]);
  });

  it("returns [] when settings.rules is absent and filters blanks", () => {
    expect(resolveSessionRules({}, {})).toEqual([]);
    expect(resolveSessionRules({ rules: { all: ["", "  ", "keep"] } }, {})).toEqual(["keep"]);
  });
});

describe("buildSystemMessage", () => {
  it("injects the project context section when PROCWAY_SESSION_PROJECT is set", async () => {
    const prev = process.env.PROCWAY_SESSION_PROJECT;
    process.env.PROCWAY_SESSION_PROJECT = "popism-v2";
    try {
      const message = await buildSystemMessage({
        cwd,
        context: makeContext(),
        sessionId: "s1"
      });
      const text = message.content[0].text;
      expect(text).toContain("## Project Context");
      expect(text).toContain('project "popism-v2"');
      // Project context lands before the root listing / instructions.
      expect(text.indexOf("## Project Context")).toBeLessThan(text.indexOf("## Root Entries"));
    } finally {
      if (prev === undefined) delete process.env.PROCWAY_SESSION_PROJECT;
      else process.env.PROCWAY_SESSION_PROJECT = prev;
    }
  });

  it("omits the project context section outside a project-scoped session", async () => {
    const prev = process.env.PROCWAY_SESSION_PROJECT;
    delete process.env.PROCWAY_SESSION_PROJECT;
    try {
      const message = await buildSystemMessage({ cwd, context: makeContext(), sessionId: "s1" });
      expect(message.content[0].text).not.toContain("## Project Context");
    } finally {
      if (prev !== undefined) process.env.PROCWAY_SESSION_PROJECT = prev;
    }
  });

  it("injects the skills index with usage instruction into the system prompt", async () => {
    const message = await buildSystemMessage({
      cwd,
      context: makeContext({ skills: [makeSkill()] }),
      sessionId: "s1"
    });
    const text = message.content[0].text;
    expect(text).toContain("## Available Skills");
    expect(text).toContain("- vitest: Vitest workflow (/work/skills/vitest/SKILL.md)");
    expect(text).toContain("read its SKILL.md with read_file");
  });

  it("keeps the placeholder when the context has no skills", async () => {
    const message = await buildSystemMessage({
      cwd,
      context: makeContext(),
      sessionId: "s1"
    });
    expect(message.content[0].text).toContain("## Available Skills\n(no skills discovered)");
  });
});

describe("refreshSystemMessageSkills", () => {
  it("replaces the skills section in-place and preserves surrounding sections", async () => {
    const memorySnapshot = {
      selected: [{ type: "user", name: "pref", description: "desc", body: "remember this" }]
    };
    const message = await buildSystemMessage({
      cwd,
      context: makeContext({ skills: [makeSkill()] }),
      sessionId: "s1",
      memorySnapshot
    });

    const replaced = refreshSystemMessageSkills(message, [
      makeSkill({ name: "deploy", path: "/work/skills/deploy/SKILL.md", description: "Deploy steps" })
    ]);

    expect(replaced).toBe(true);
    const text = message.content[0].text;
    expect(text).toContain("- deploy: Deploy steps (/work/skills/deploy/SKILL.md)");
    expect(text).not.toContain("vitest");
    // Sections before and after the skills index stay intact.
    expect(text).toContain("## Instructions");
    expect(text).toContain("## Memory");
    expect(text.indexOf("## Available Skills")).toBeLessThan(text.indexOf("## Memory"));
  });

  it("handles a skills section at the end of the prompt", async () => {
    const message = await buildSystemMessage({
      cwd,
      context: makeContext({ skills: [makeSkill()] }),
      sessionId: "s1"
    });
    const replaced = refreshSystemMessageSkills(message, []);
    expect(replaced).toBe(true);
    expect(message.content[0].text.endsWith("## Available Skills\n(no skills discovered)\n")).toBe(true);
  });

  it("returns false for non-system messages or prompts without a skills section", () => {
    const userMessage = createMessage({
      role: "user",
      sessionId: "s1",
      content: [{ kind: "text", text: "## Available Skills\nwhatever" }]
    });
    expect(refreshSystemMessageSkills(userMessage, [])).toBe(false);

    const systemMessage = createMessage({
      role: "system",
      sessionId: "s1",
      content: [{ kind: "text", text: "no skills header here" }]
    });
    expect(refreshSystemMessageSkills(systemMessage, [])).toBe(false);
  });
});
