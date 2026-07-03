import { describe, expect, it } from "vitest";
import { evaluatePermissions } from "../src/safety/permissions.mjs";

describe("evaluatePermissions", () => {
  it("allows read-only kinds by default", () => {
    expect(evaluatePermissions({ kind: "read_file", summary: "x.txt" })).toBe("allow");
    expect(evaluatePermissions({ kind: "list_files", summary: "." })).toBe("allow");
    expect(evaluatePermissions({ kind: "search_files", summary: "TODO" })).toBe("allow");
  });

  it("asks for mutation kinds with no rules", () => {
    expect(evaluatePermissions({ kind: "write_file", summary: "x.txt", mutation: true })).toBe("ask");
  });

  it("matches kind:* prefix glob in allow", () => {
    const rules = { allow: ["write_file:*"] };
    expect(evaluatePermissions({ rules, kind: "write_file", summary: "any.txt" })).toBe("allow");
    expect(evaluatePermissions({ rules, kind: "apply_patch", summary: "any" })).toBe("ask");
  });

  it("matches kind:prefix* in deny", () => {
    const rules = { deny: ["run_shell:rm -rf*"] };
    expect(evaluatePermissions({ rules, kind: "run_shell", summary: "rm -rf foo" })).toBe("deny");
    expect(evaluatePermissions({ rules, kind: "run_shell", summary: "ls" })).toBe("ask");
  });

  it("supports regex rules across kind:summary target", () => {
    const rules = { deny: ["/^run_shell:.*--force/"] };
    expect(evaluatePermissions({ rules, kind: "run_shell", summary: "git push --force" })).toBe("deny");
    expect(evaluatePermissions({ rules, kind: "run_shell", summary: "git push" })).toBe("ask");
  });

  it("orders deny over allow", () => {
    const rules = {
      allow: ["run_shell:*"],
      deny: ["run_shell:rm -rf*"]
    };
    expect(evaluatePermissions({ rules, kind: "run_shell", summary: "rm -rf /" })).toBe("deny");
    expect(evaluatePermissions({ rules, kind: "run_shell", summary: "ls" })).toBe("allow");
  });

  it("falls back to ask when ask rule matches and allow does not", () => {
    const rules = { ask: ["mcp:*"] };
    expect(evaluatePermissions({ rules, kind: "mcp", summary: "mcp__local__echo" })).toBe("ask");
  });

  it("ignores invalid regex rules without throwing", () => {
    const rules = { deny: ["/[invalid/"] };
    expect(evaluatePermissions({ rules, kind: "run_shell", summary: "ls" })).toBe("ask");
  });

  it("matches plan_apply kind via the default-settings ask list", async () => {
    const { DEFAULT_SETTINGS } = await import("../src/config/default-settings.mjs");
    const rules = DEFAULT_SETTINGS.permissions;
    expect(evaluatePermissions({ rules, kind: "plan_apply", summary: "session abcd1234" })).toBe("ask");
    expect(rules.ask).toContain("plan_apply:*");
  });
});
