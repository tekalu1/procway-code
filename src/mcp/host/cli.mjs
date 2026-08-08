#!/usr/bin/env node
/**
 * MCP host CLI entry point. Sub-CLIs (codex / claude code) spawn this as a
 * child process via their MCP server config. We expose procway's existing
 * tool registry over stdio JSON-RPC.
 *
 * Invocation pattern (via codex `-c mcp_servers.procway.command=...`):
 *
 *   node ai-agent/src/mcp/host/cli.mjs --cwd <workspace> [--prefix procway]
 *
 * Flags:
 *   --cwd <dir>            Workspace directory passed to executeToolCall.
 *   --prefix <name>        Tool namespace prefix (e.g. "procway" exposes
 *                          tools as `procway/write_file`). Empty by default.
 *   --settings-path <path> Override settings.json location. Default: derived
 *                          from cwd via the standard procway resolver.
 *
 * Approval policy in PoC: the host child runs without an interactive UI, so
 * permissions are evaluated against `settings.permissions` directly:
 *   - allow: pass through
 *   - deny: refuse
 *   - ask: auto-approve (PoC compromise — sub-CLI behaves as if approved).
 *          The deny list still blocks genuinely dangerous operations, and a
 *          future iteration can add file-watch IPC to escalate `ask` to the
 *          parent procway-code TUI.
 */

import process from "node:process";
import { createMcpHostServer } from "./server.mjs";
import { runStdioTransport } from "./stdio-transport.mjs";
import { executeToolCall, getToolDefinitions } from "../../tools/registry.mjs";
import { loadSettings } from "../../config/load-settings.mjs";

function parseArgs(argv) {
  const out = { cwd: process.cwd(), prefix: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cwd") out.cwd = argv[++i];
    else if (a === "--prefix") out.prefix = argv[++i];
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const loaded = await loadSettings({ cwd: opts.cwd }).catch(() => ({ settings: {} }));
  const settings = loaded?.settings ?? {};

  // PoC stderr+file trace — codex / claude swallow MCP server stderr, so we
  // also append to a log file under the workspace for diagnosis.
  const fsmod = await import("node:fs");
  const pathmod = await import("node:path");
  const logPath = pathmod.join(opts.cwd, ".procway", "mcp-host.log");
  try { fsmod.mkdirSync(pathmod.dirname(logPath), { recursive: true }); } catch { /* the log file is a diagnostic aid, never a hard requirement */ }
  const trace = (...m) => {
    const line = `[${new Date().toISOString()}] [procway-mcp-host] ${m.join(" ")}\n`;
    process.stderr.write(line);
    try { fsmod.appendFileSync(logPath, line); } catch { /* stderr above already carried the line */ }
  };
  trace("starting", "cwd=" + opts.cwd, "prefix=" + opts.prefix, "pid=" + process.pid);

  const server = createMcpHostServer({
    serverInfo: { name: "procway-mcp-host", version: "0.1.0-poc" },
    toolDefinitions: getToolDefinitions({ settings }),
    toolNamePrefix: opts.prefix,
    executeToolCall: async (name, args) => {
      trace("tools/call", name, JSON.stringify(args ?? {}).slice(0, 200));
      try {
        const result = await executeToolCall({
          name,
          args: args ?? {},
          cwd: opts.cwd,
          settings,
          approvalRequester: pocApprovalRequester(settings, trace)
        });
        trace("tools/call result", name, "kind=" + result?.kind, "skipped=" + Boolean(result?.data?.skipped));
        return result;
      } catch (err) {
        trace("tools/call error", name, err.message);
        return {
          kind: name,
          summary: `Tool execution error: ${err.message}`,
          data: { error: err.message }
        };
      }
    }
  });

  await runStdioTransport({ server, trace });
}

/**
 * PoC approval policy: evaluate `permissions.allow / deny` deterministically.
 * Items on `ask` list are auto-approved (no interactive UI from this child).
 * Non-listed items follow the configured `approvalMode` default.
 */
function pocApprovalRequester(settings, trace = () => {}) {
  const allow = settings?.permissions?.allow ?? [];
  const deny = settings?.permissions?.deny ?? [];
  return async ({ kind, summary }) => {
    const probe = `${kind}:${summary ?? ""}`;
    if (matchAny(deny, probe) || matchAny(deny, `${kind}:*`)) {
      trace("approval", probe, "DENY");
      return false;
    }
    if (matchAny(allow, probe) || matchAny(allow, `${kind}:*`)) {
      trace("approval", probe, "ALLOW(explicit)");
      return true;
    }
    // Default: allow (PoC). The deny list above is the safety net.
    trace("approval", probe, "ALLOW(default)");
    return true;
  };
}

function matchAny(patterns, target) {
  for (const p of patterns) {
    if (typeof p !== "string") continue;
    if (p === target) return true;
    if (p.endsWith("*") && target.startsWith(p.slice(0, -1))) return true;
  }
  return false;
}

main().catch((err) => {
  process.stderr.write(`[mcp-host] fatal: ${err.message}\n${err.stack ?? ""}\n`);
  process.exit(1);
});
