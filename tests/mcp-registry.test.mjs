import { describe, expect, it } from "vitest";
import { McpToolRegistry } from "../src/mcp/registry.mjs";

describe("McpToolRegistry", () => {
  it("discovers configured MCP tools and calls them by prefixed name", async () => {
    const transport = new MemoryMcpTransport({
      initialize: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "test" } },
      "tools/list": {
        tools: [{
          name: "echo",
          description: "Echo input",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } }
          }
        }]
      },
      "resources/list": { resources: [] },
      "prompts/list": { prompts: [] },
      "tools/call": { content: [{ type: "text", text: "ok" }] }
    });
    const registry = new McpToolRegistry({
      settings: {
        mcpServers: {
          local: { transport: "stdio", command: "unused" }
        }
      },
      transportFactory: () => transport
    });

    await registry.start();

    expect(registry.getToolDefinitions()).toEqual([
      expect.objectContaining({
        function: expect.objectContaining({
          name: "mcp__local__echo",
          parameters: expect.objectContaining({ type: "object" })
        })
      })
    ]);
    await expect(registry.callTool("mcp__local__echo", { text: "hi" }))
      .resolves.toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(transport.sent.find((message) => message.method === "tools/call")?.params)
      .toEqual({ name: "echo", arguments: { text: "hi" } });

    await registry.close();
  });
});

class MemoryMcpTransport {
  constructor(responses) {
    this.responses = responses;
    this.sent = [];
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
  }

  async start() {}

  async send(message) {
    this.sent.push(message);
    queueMicrotask(() => {
      this.onmessage?.({
        jsonrpc: "2.0",
        id: message.id,
        result: this.responses[message.method] ?? {}
      });
    });
  }

  async close() {
    this.onclose?.();
  }
}
