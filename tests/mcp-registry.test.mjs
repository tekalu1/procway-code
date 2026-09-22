import { describe, expect, it } from "vitest";
import { McpToolRegistry } from "../src/mcp/registry.mjs";
import { runOpenAiCompatibleProvider } from "../src/providers/openai-compatible.mjs";
import { toAnthropicTools } from "../src/providers/format/anthropic.mjs";

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

    // Exercise the actual provider serializer with discovered MCP definitions.
    // A permissive mock server otherwise hides unsupported fields in production.
    const tools = registry.getToolDefinitions();
    await runOpenAiCompatibleProvider({
      provider: { type: "openai-via-proxy", baseUrl: "http://fixture.invalid", maxRetries: 0 },
      model: "fixture",
      prompt: "List available tools",
      tools,
      stream: false,
      fetchImpl: async (_url, request) => {
        const body = JSON.parse(request.body);
        expect(body.tools).toEqual([{
          type: "function",
          function: {
            name: "mcp__local__echo",
            description: "[MCP local] Echo input",
            parameters: { type: "object", properties: { text: { type: "string" } } }
          }
        }]);
        return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
      }
    });
    expect(toAnthropicTools(tools, { cacheControl: false })).toEqual([{
      name: "mcp__local__echo",
      description: "[MCP local] Echo input",
      input_schema: { type: "object", properties: { text: { type: "string" } } }
    }]);

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
