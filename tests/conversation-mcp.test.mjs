import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "../src/agent/conversation.mjs";
import { isToolResult } from "../src/core/types/tool-result.mjs";

describe("AgentSession MCP integration", () => {
  it("merges MCP tools when starting a new session", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "procway-code-"));
    const mcpRegistry = createFakeMcpRegistry();

    try {
      const session = await new AgentSession({
        settings: baseSettings(),
        cwd,
        mcpRegistry
      }).initialize();

      expect(mcpRegistry.start).toHaveBeenCalledOnce();
      expect(session.tools.map((tool) => tool.function.name)).toContain("mcp__local__echo");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("merges MCP tools when resuming an existing session", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "procway-code-"));
    const mcpRegistry = createFakeMcpRegistry();

    try {
      const session = await new AgentSession({
        settings: baseSettings(),
        cwd,
        sessionId: "resume-test",
        messages: [{ role: "system", content: "existing" }],
        mcpRegistry
      }).initialize();

      expect(mcpRegistry.start).toHaveBeenCalledOnce();
      expect(session.tools.map((tool) => tool.function.name)).toContain("mcp__local__echo");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("routes MCP tool calls through the MCP registry with approval and returns a ToolResult", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "procway-code-"));
    const mcpRegistry = createFakeMcpRegistry();
    const approvalRequester = vi.fn(async () => true);

    try {
      const session = await new AgentSession({
        settings: baseSettings(),
        cwd,
        mcpRegistry,
        approvalRequester
      }).initialize();
      const result = await session.executeSingleToolCall({
        name: "mcp__local__echo",
        args: { text: "hello" }
      });

      expect(approvalRequester).toHaveBeenCalledWith(expect.objectContaining({ kind: "mcp", mutation: true }));
      expect(mcpRegistry.callTool).toHaveBeenCalledWith("mcp__local__echo", { text: "hello" });
      expect(isToolResult(result)).toBe(true);
      expect(result.kind).toBe("mcp");
      expect(result.summary).toContain("mcp__local__echo");
      expect(result.data).toEqual(expect.objectContaining({
        tool: "mcp__local__echo",
        response: { content: [{ type: "text", text: "ok" }] }
      }));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

function baseSettings() {
  return {
    defaultProvider: "test",
    defaultModel: "test-model",
    approvalMode: "auto-readonly",
    session: { enabled: false },
    tools: {},
    agents: {}
  };
}

function createFakeMcpRegistry() {
  return {
    start: vi.fn(async () => {}),
    getToolDefinitions: vi.fn(() => [{
      type: "function",
      function: {
        name: "mcp__local__echo",
        description: "Echo input",
        parameters: { type: "object", properties: { text: { type: "string" } } }
      }
    }]),
    isMcpTool: vi.fn((name) => name.startsWith("mcp__")),
    callTool: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }))
  };
}
