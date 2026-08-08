import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildMcpInjection } from "../../src/mcp/host/inject-config.mjs";

const REPO_ROOT = "/fake/repo";

const cleanupPaths = [];
afterAll(() => {
  for (const p of cleanupPaths) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("buildMcpInjection: codex", () => {
  it("redirects CODEX_HOME and writes config.toml with [mcp_servers.procway]", () => {
    const out = buildMcpInjection({ provider: "codex", repoRoot: REPO_ROOT, cwd: "/work" });
    cleanupPaths.push(...out.tempFiles);

    expect(out.extraArgs).toEqual(["-s", "read-only"]);
    expect(out.env.CODEX_HOME).toBeDefined();
    expect(out.env.PROCWAY_MCP_HOST_CLI).toBe(path.resolve(REPO_ROOT, "ai-agent/src/mcp/host/cli.mjs"));

    const cfgPath = path.join(out.env.CODEX_HOME, "config.toml");
    expect(fs.existsSync(cfgPath)).toBe(true);
    const cfg = fs.readFileSync(cfgPath, "utf8");
    expect(cfg).toContain("[mcp_servers.procway]");
    expect(cfg).toContain('command = "node"');
    expect(cfg).toContain('"--cwd"');
    expect(cfg).toContain('"/work"');
    expect(cfg).toContain('"--prefix"');
    expect(cfg).toContain('"procway"');
  });

  it("omits sandbox flag when disallowBuiltinMutations=false", () => {
    const out = buildMcpInjection({ provider: "codex", repoRoot: REPO_ROOT, cwd: "/work", disallowBuiltinMutations: false });
    cleanupPaths.push(...out.tempFiles);
    expect(out.extraArgs).not.toContain("read-only");
  });
});

describe("buildMcpInjection: claude", () => {
  it("writes a JSON config file and returns --mcp-config + --strict-mcp-config", () => {
    const out = buildMcpInjection({ provider: "claude", repoRoot: REPO_ROOT, cwd: "/work" });
    cleanupPaths.push(...out.tempFiles);

    expect(out.extraArgs).toContain("--mcp-config");
    expect(out.extraArgs).toContain("--strict-mcp-config");
    expect(out.extraArgs).toContain("--disallowedTools");
    expect(out.extraArgs).toContain("--allowedTools");

    const cfgIdx = out.extraArgs.indexOf("--mcp-config");
    const cfgPath = out.extraArgs[cfgIdx + 1];
    expect(fs.existsSync(cfgPath)).toBe(true);

    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    expect(cfg.mcpServers.procway.command).toBe("node");
    expect(cfg.mcpServers.procway.args).toContain("--cwd");
    expect(cfg.mcpServers.procway.args).toContain("/work");
    expect(cfg.mcpServers.procway.args[0]).toBe(path.resolve(REPO_ROOT, "ai-agent/src/mcp/host/cli.mjs"));
  });

  it("omits disallowed/allowed flags when disallowBuiltinMutations=false", () => {
    const out = buildMcpInjection({ provider: "claude", repoRoot: REPO_ROOT, cwd: "/work", disallowBuiltinMutations: false });
    cleanupPaths.push(...out.tempFiles);
    expect(out.extraArgs).not.toContain("--disallowedTools");
    expect(out.extraArgs).not.toContain("--allowedTools");
  });
});

describe("buildMcpInjection: rejection", () => {
  it("throws on unsupported provider", () => {
    expect(() => buildMcpInjection({ provider: "gemini", repoRoot: REPO_ROOT, cwd: "/work" })).toThrow(/unsupported/);
  });
});
