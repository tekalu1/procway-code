/**
 * Builds CLI-side flags / config to make sub-CLIs (codex / claude code) speak
 * to procway's MCP host. Each provider has its own config shape; this module
 * isolates that knowledge so cli-agent.mjs stays provider-agnostic.
 *
 * Returns:
 *   {
 *     extraArgs:     string[]       // appended to provider.args
 *     env:           object|null    // env vars to set on the spawned child
 *     tempFiles:     string[]       // files to clean up after the run
 *   }
 */

import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const HOST_CLI_REL = "ai-agent/src/mcp/host/cli.mjs";
const SERVER_NAME = "procway";

/**
 * @param {object} opts
 * @param {"codex"|"claude"} opts.provider — sub-CLI flavor
 * @param {string} [opts.repoRoot] — absolute path of the procway repo root
 *   (the dir containing `ai-agent/`, `dashboard/`, etc.). The host CLI is at
 *   `${repoRoot}/${HOST_CLI_REL}`. Only used when `hostCli` is omitted.
 * @param {string} [opts.hostCli] — absolute path of the MCP host CLI. Prefer
 *   this: `repoRoot` bakes in the monorepo layout, which does not exist once
 *   the package is installed from npm (the package root is
 *   `node_modules/procway-code`, not `<repo>/ai-agent`). Callers inside the
 *   package resolve `src/mcp/host/cli.mjs` from their own module URL instead.
 * @param {string} opts.cwd — workspace dir to pass to the host child
 * @param {boolean} [opts.disallowBuiltinMutations] — when true, append flags
 *   that block sub-CLI built-in writes/shell so MCP becomes the only path.
 *   Default: true.
 */
export function buildMcpInjection({ provider, repoRoot, hostCli: hostCliOverride, cwd, disallowBuiltinMutations = true }) {
  const hostCli = hostCliOverride ?? path.resolve(repoRoot, HOST_CLI_REL);
  if (provider === "codex") {
    return buildForCodex({ hostCli, cwd, disallowBuiltinMutations });
  }
  if (provider === "claude") {
    return buildForClaude({ hostCli, cwd, disallowBuiltinMutations });
  }
  throw new Error(`buildMcpInjection: unsupported provider "${provider}"`);
}

function buildForCodex({ hostCli, cwd, disallowBuiltinMutations }) {
  // We register our MCP server via CODEX_HOME-redirection rather than
  // `-c mcp_servers.<name>.args=[...]` because the latter requires passing a
  // TOML array as a CLI value, which gets mangled by cmd.exe quoting on
  // Windows (becomes a string instead of a sequence). A scratch CODEX_HOME
  // with our config.toml dodges the quoting layer entirely.
  //
  // IMPORTANT: place the scratch dir under `~/.procway/codex-homes/`, NOT
  // os.tmpdir(). codex refuses to install its PATH/helper binaries under
  // temp dirs (warning: "Refusing to create helper binaries under temporary
  // dir") which on first run leaves codex hanging on `Reading prompt from
  // stdin...` until our 5-min timeout. A persistent home satisfies codex's
  // safety check.
  const homeRoot = path.join(os.homedir(), ".procway", "codex-homes");
  fs.mkdirSync(homeRoot, { recursive: true });
  const tmpHome = fs.mkdtempSync(path.join(homeRoot, "run-"));
  const userHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");

  // 1. Carry over auth (subscription / API key tokens). Without this, codex
  //    would re-prompt for login and fail in non-interactive exec mode.
  const userAuth = path.join(userHome, "auth.json");
  if (fs.existsSync(userAuth)) {
    fs.copyFileSync(userAuth, path.join(tmpHome, "auth.json"));
  }

  // 2. Inherit user's config.toml (model preferences, project trust, sandbox
  //    flags etc.) and prepend our top-level keys + append our
  //    [mcp_servers.procway] section. Order matters in TOML: top-level keys
  //    MUST come before any section header, otherwise they're parsed as
  //    belonging to the section above them.
  const userConfig = path.join(userHome, "config.toml");
  let userToml = "";
  if (fs.existsSync(userConfig)) userToml = fs.readFileSync(userConfig, "utf8");

  // Top-level overrides (prepended). `approval_policy = "never"` lets codex
  // auto-approve MCP tool calls in non-interactive exec mode; safety is
  // provided by procway's own permission system on the MCP server side.
  let header = "";
  if (!/^\s*approval_policy\s*=/m.test(userToml)) {
    header += `approval_policy = "never"\n`;
  }

  // Trailing additions (appended at end of file).
  let trailer = "";
  if (!/\[mcp_servers\.procway\]/.test(userToml)) {
    const argsArray = JSON.stringify([hostCli, "--cwd", cwd, "--prefix", SERVER_NAME]);
    trailer += `\n[mcp_servers.${SERVER_NAME}]\ncommand = "node"\nargs = ${argsArray}\n`;
  }

  let configToml = header;
  if (userToml) {
    configToml += userToml;
    if (!configToml.endsWith("\n")) configToml += "\n";
  }
  configToml += trailer;
  fs.writeFileSync(path.join(tmpHome, "config.toml"), configToml);

  const extraArgs = [];
  if (disallowBuiltinMutations) {
    // -s read-only blocks codex's built-in apply_patch and shell, forcing it
    // to call MCP-provided tools instead. Read tools (Read/Grep/etc.) keep
    // working natively — that's intentional, MCP doesn't need to replace them.
    extraArgs.push("-s", "read-only");
  }
  return {
    extraArgs,
    env: { CODEX_HOME: tmpHome, PROCWAY_MCP_HOST_CLI: hostCli },
    tempFiles: [tmpHome]
  };
}

function buildForClaude({ hostCli, cwd, disallowBuiltinMutations }) {
  // claude code accepts MCP config via JSON file path. Write a temp file.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "procway-mcp-"));
  const cfgPath = path.join(tmpDir, "claude-mcp.json");
  const cfg = {
    mcpServers: {
      [SERVER_NAME]: {
        command: "node",
        args: [hostCli, "--cwd", cwd, "--prefix", SERVER_NAME]
      }
    }
  };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
  const extraArgs = ["--mcp-config", cfgPath, "--strict-mcp-config"];
  if (disallowBuiltinMutations) {
    extraArgs.push(
      "--disallowedTools", "Bash,Write,Edit,WebFetch,Task",
      "--allowedTools", `Read,Glob,Grep,mcp__${SERVER_NAME}__*`
    );
  }
  return {
    extraArgs,
    env: null,
    tempFiles: [cfgPath, tmpDir]
  };
}
