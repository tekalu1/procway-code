import { describe, expect, it } from "vitest";
import {
  renderBranch,
  renderCompact,
  renderContext,
  renderMemory,
  renderModel,
  renderPlan,
  renderTodos,
  renderUsage
} from "../src/adapters/tui/command-render.mjs";
import { stripAnsi, visibleWidth } from "../src/adapters/tui/ansi.mjs";

/**
 * P3b-1: these seven commands printed `JSON.stringify(result, null, 2)`. The
 * assertions below are the contract that replaced it — every renderer takes
 * exactly the object its `core/commands/*.mjs` counterpart returns.
 */

const OPTS = { width: 80, color: false };

describe("/usage", () => {
  const result = {
    sessionId: "s",
    pricingKey: "openai:gpt-5.4",
    totals: { inputTokens: 13_456, outputTokens: 2890, costUsd: 0.1234 },
    rounds: [
      { round: 0, inputTokens: 12_000, outputTokens: 1200, costUsd: 0.1 },
      { round: 1, inputTokens: 1456, outputTokens: 1690, costUsd: 0.0234 }
    ]
  };

  it("renders a per-round table with a totals footer", () => {
    const out = renderUsage(result, OPTS);
    expect(out).toContain("▌ Usage  openai:gpt-5.4");
    expect(out).toContain("12,000");
    expect(out).toContain("total");
    expect(out).toContain("$0.12");
    expect(out).not.toContain("{");
  });

  it("lines the digits up in one column", () => {
    const lines = renderUsage(result, OPTS).trimEnd().split("\n");
    const rows = lines.filter((line) => /\$\d/.test(line));
    expect(rows.length).toBeGreaterThan(1);
    expect(new Set(rows.map((line) => line.length)).size).toBe(1);
  });

  it("surfaces the missing-pricing warning with a fix", () => {
    const out = renderUsage({ ...result, diagnostics: { warnings: ["no pricing for x:y"] } }, OPTS);
    expect(out).toContain("no pricing for x:y");
    expect(out).toContain("settings.usage.pricing");
  });

  it("says so when no round has run yet", () => {
    expect(renderUsage({ rounds: [], totals: {} }, OPTS)).toContain("total");
  });
});

describe("/context", () => {
  it("lists instructions and skills with workspace-relative paths", () => {
    const out = renderContext({
      compatibilityMode: "mixed",
      instructions: [{ scannerId: "claude", path: "/repo/CLAUDE.md", bytes: 2048 }],
      skills: [{ scannerId: "shared", priority: 10, path: "/repo/skills/vd/SKILL.md", bytes: 812 }]
    }, { ...OPTS, cwd: "/repo" });
    expect(out).toContain("compatibility: mixed");
    expect(out).toContain("▌ Instructions");
    expect(out).toContain("CLAUDE.md");
    expect(out).not.toContain("/repo/CLAUDE.md");
    expect(out).toContain("2 KB");
    expect(out).toContain("skills/vd/SKILL.md");
  });

  it("reports empty sections rather than empty JSON arrays", () => {
    const out = renderContext({ compatibilityMode: "claude", instructions: [], skills: [] }, OPTS);
    expect(out).toContain("(no instruction files resolved)");
    expect(out).toContain("(no skills resolved)");
  });
});

describe("/todos", () => {
  it("renders a checklist, not a one-line summary plus JSON", () => {
    const out = renderTodos({
      todos: [
        { status: "completed", content: "Read the renderer" },
        { status: "in_progress", content: "Refactor the renderer", activeForm: "Refactoring the renderer" },
        { status: "pending", content: "Write tests" }
      ],
      summary: { total: 3, completed: 1 }
    }, OPTS);
    expect(out).toContain("1/3 done");
    expect(out).toContain("✔ Read the renderer");
    expect(out).toContain("▸ Refactoring the renderer");
    expect(out).toContain("○ Write tests");
  });

  it("handles an empty list", () => {
    expect(renderTodos({ todos: [], summary: { total: 0 } }, OPTS)).toContain("(no todos)");
  });
});

describe("/memory", () => {
  it("summarises counts by type and lists the entries", () => {
    const out = renderMemory({
      dir: "/home/u/.procway/memory",
      count: 2,
      types: { user: 1, project: 1 },
      entries: [
        { file: "a.md", name: "prefs", description: "User preferences", type: "user" },
        { file: "b.md", name: "arch", description: "Architecture notes", type: "project" }
      ]
    }, OPTS);
    expect(out).toContain("▌ Memory  /home/u/.procway/memory");
    expect(out).toContain("user=1");
    expect(out).toContain("Architecture notes");
  });

  it("handles the no-memory case", () => {
    expect(renderMemory({ dir: null, count: 0, types: {}, entries: [] }, OPTS))
      .toContain("(no memory entries)");
  });
});

describe("/plan", () => {
  it("shows the state and the queued writes", () => {
    const out = renderPlan({ active: true, available: true, pending: [{ entryId: "1", name: "write_file", summary: "src/a.mjs" }] }, OPTS);
    expect(out).toContain("state   on");
    expect(out).toContain("1 write");
    expect(out).toContain("write_file");
    expect(out).toContain("src/a.mjs");
  });

  it("explains what plan mode does when it is off", () => {
    const out = renderPlan({ active: false, available: true, pending: [] }, OPTS);
    expect(out).toContain("state   off");
    expect(out).toContain("/plan on");
  });

  it("reports an unavailable plan mode", () => {
    expect(renderPlan({ available: false }, OPTS)).toContain("unavailable");
  });
});

describe("/branch", () => {
  it("reports where the branch went", () => {
    const out = renderBranch({
      ok: true,
      branchSessionId: "s-branch-abc",
      fromMessageId: "m-1",
      branchDir: "/repo/.x/branches/1"
    }, { ...OPTS, cwd: "/repo" });
    expect(out).toContain("s-branch-abc");
    expect(out).toContain("/checkout s-branch-abc");
  });

  it("reports the failure with the usage hint", () => {
    const out = renderBranch({ ok: false, error: "missing fromMessageId", hint: "Usage: /branch from <messageId>" }, OPTS);
    expect(out).toContain("missing fromMessageId");
    expect(out).toContain("/branch from <messageId>");
  });
});

describe("/compact", () => {
  it("renders --status against its thresholds", () => {
    const out = renderCompact({
      status: {
        enabled: true,
        messageCount: 40,
        messageCountThreshold: 100,
        estimatedTokens: 12_000,
        estimatedTokensThreshold: 80_000,
        strategy: "summarize-context",
        keepLastMessages: 10,
        shouldCompact: false
      }
    }, OPTS);
    expect(out).toContain("40 / 100");
    expect(out).toContain("12,000 / 80,000");
    expect(out).toContain("due now      no");
  });

  it("renders an applied pass", () => {
    const out = renderCompact({ compacted: true, strategy: "summarize-context", removedMessages: 12, keepLastMessages: 10, messageCount: 18 }, OPTS);
    expect(out).toContain("applied");
    expect(out).toContain("12 messages");
  });

  it("renders a no-op pass", () => {
    expect(renderCompact({ compacted: false, messageCount: 4 }, OPTS)).toContain("nothing to compact");
  });
});

describe("/model", () => {
  it("prints one coloured line", () => {
    expect(stripAnsi(renderModel({ provider: "p", model: "m" }, { color: true }))).toBe("model  p:m\n");
  });
});

describe("narrow terminals", () => {
  it("keeps every panel inside 60 columns", () => {
    const rendered = [
      renderUsage({ pricingKey: "p:m", totals: { inputTokens: 1, outputTokens: 2, costUsd: 0.5 }, rounds: [{ round: 0, inputTokens: 1, outputTokens: 2, costUsd: 0.5 }] }, { width: 60, color: false }),
      renderContext({ compatibilityMode: "mixed", instructions: [{ scannerId: "claude", path: "/a/very/long/path/to/CLAUDE.md", bytes: 10 }], skills: [] }, { width: 60, color: false, cwd: "/nowhere" }),
      renderTodos({ todos: [{ status: "pending", content: "a todo whose text is quite long and keeps going for a while" }], summary: { total: 1, completed: 0 } }, { width: 60, color: false }),
      renderPlan({ active: true, available: true, pending: [] }, { width: 60, color: false }),
      renderCompact({ compacted: true, strategy: "s", removedMessages: 1, keepLastMessages: 2, messageCount: 3 }, { width: 60, color: false })
    ].join("");
    for (const line of rendered.split("\n")) {
      expect(visibleWidth(line), line).toBeLessThanOrEqual(60);
    }
  });
});
