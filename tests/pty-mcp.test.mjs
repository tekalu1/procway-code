/**
 * e2e — `/mcp` in the real REPL on a pty.
 *
 * Drives `src/cli.mjs` under a real terminal (script(1)) and exercises the
 * MCP commands end to end against a live stdio MCP server:
 *
 *   /mcp (empty list) → /mcp add <stdio echo server> (reconnect + list)
 *   → /mcp remove → /mcp (empty again) → exit.
 *
 * This is the closest thing to "e2e" for a TUI feature: the same process a
 * user runs, the same bytes a user sees, a real MCP subprocess, and a change
 * that becomes live inside the running session. Each test owns its own
 * HOME + workspace so persisted settings never leak across cases.
 */
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { PROMPT, makePtyEnv, plainPty, ptySupported, runPty } from "./helpers/pty.mjs";

const describePty = ptySupported() ? describe : describe.skip;

const CTRL_D = "\x04";
const fixture = fileURLToPath(new URL("./fixtures/mcp-echo-server.mjs", import.meta.url));

describePty("pty: /mcp command", () => {
  async function withEnv(fn) {
    const env = await makePtyEnv();
    try {
      await fn(env);
    } finally {
      await env.cleanup();
    }
  }

  it("lists, adds a live MCP server, then removes it", async () => {
    const nodePath = process.execPath;
    await withEnv(async (env) => {
      const run = await runPty({
        home: env.home,
        workspace: env.workspace,
        steps: [
          { waitFor: PROMPT, send: "/mcp\r" },
          { waitFor: /no MCP servers/, send: `/mcp add demo stdio --command ${nodePath} --args ${fixture}\r` },
          { waitFor: /Added MCP server "demo"/, send: "/mcp\r" },
          { waitFor: /demo: echo/, send: "/mcp remove demo\r" },
          { waitFor: /Removed MCP server "demo"/, send: "/mcp\r" },
          { waitFor: /no MCP servers/, send: CTRL_D }
        ]
      });
      expect(run.exitCode).toBe(0);
      const plain = plainPty(run.output, env);
      // The handshake worked and the discovered tool is listed.
      expect(plain).toContain("1 connected");
      expect(plain).toContain("demo");
      expect(plain).toContain("demo: echo");
      expect(plain).toContain("Removed MCP server \"demo\"");
      // After removal the list is empty again.
      expect(plain).toContain("no MCP servers");
    });
  }, 60000);

  it("adds a server non-interactively and it becomes live", async () => {
    const nodePath = process.execPath;
    await withEnv(async (env) => {
      const run = await runPty({
        home: env.home,
        workspace: env.workspace,
        steps: [
          { waitFor: PROMPT, send: `/mcp add persisted stdio --command ${nodePath} --args ${fixture}\r` },
          { waitFor: /Added MCP server "persisted"/, send: "/mcp\r" },
          { waitFor: /persisted: echo/, send: CTRL_D }
        ]
      });
      expect(run.exitCode).toBe(0);
      const plain = plainPty(run.output, env);
      expect(plain).toContain("persisted: echo");
      expect(plain).toContain("1 connected");
    });
  }, 60000);

  it("adds a server through the interactive wizard", async () => {
    const nodePath = process.execPath;
    await withEnv(async (env) => {
      const run = await runPty({
        home: env.home,
        workspace: env.workspace,
        steps: [
          { waitFor: PROMPT, send: "/mcp add\r" },
          { waitFor: /Server id \(e\.g\. demo\)/, send: "echo\r" },
          { waitFor: /Transport \(stdio\|http\|sse\)/, send: "\r" },
          { waitFor: /Command/, send: nodePath + "\r" },
          { waitFor: /Args \(space separated, optional\)/, send: fixture + "\r" },
          { waitFor: /Added MCP server "echo"/, send: "/mcp\r" },
          { waitFor: /echo: echo/, send: CTRL_D }
        ]
      });
      expect(run.exitCode).toBe(0);
      const plain = plainPty(run.output, env);
      expect(plain).toContain('Added MCP server "echo"');
      expect(plain).toContain("echo: echo");
    });
  }, 60000);
});
