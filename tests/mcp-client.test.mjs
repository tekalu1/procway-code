import { describe, expect, it } from "vitest";
import { McpClient, discoverMcpServer } from "../src/mcp/client.mjs";

describe("McpClient", () => {
  it("initializes and discovers server capabilities", async () => {
    const transport = new MemoryMcpTransport({
      "initialize": { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "test" } },
      "tools/list": { tools: [{ name: "tool_a" }] },
      "resources/list": { resources: [{ uri: "file://a" }] },
      "prompts/list": { prompts: [{ name: "prompt_a" }] }
    });
    const client = new McpClient({ transport, timeoutMs: 1000 });

    await expect(client.start()).resolves.toEqual(expect.objectContaining({ protocolVersion: "2025-06-18" }));
    await expect(discoverMcpServer(client)).resolves.toEqual({
      tools: [{ name: "tool_a" }],
      resources: [{ uri: "file://a" }],
      prompts: [{ name: "prompt_a" }]
    });
  });
});

class MemoryMcpTransport {
  constructor(responses) {
    this.responses = responses;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
  }

  async start() {}

  async send(message) {
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
