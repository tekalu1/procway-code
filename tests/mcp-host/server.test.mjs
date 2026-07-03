import { describe, expect, it, vi } from "vitest";
import { createMcpHostServer } from "../../src/mcp/host/server.mjs";

const sampleTools = [
  {
    type: "function",
    function: {
      name: "web_browser",
      description: "Run browser actions",
      parameters: {
        type: "object",
        properties: { steps: { type: "array", items: { type: "object" } } },
        required: ["steps"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
    }
  }
];

function buildServer(overrides = {}) {
  return createMcpHostServer({
    serverInfo: { name: "test-server", version: "1.0.0" },
    toolDefinitions: sampleTools,
    executeToolCall: vi.fn(async () => ({ kind: "noop", summary: "ok", data: { ok: true } })),
    ...overrides
  });
}

describe("createMcpHostServer", () => {
  it("responds to initialize with protocol version and serverInfo", async () => {
    const server = buildServer();
    const res = await server.handleMessage({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } }
    });
    expect(res.result.protocolVersion).toBe("2025-06-18");
    expect(res.result.serverInfo).toEqual({ name: "test-server", version: "1.0.0" });
    expect(res.result.capabilities.tools).toBeDefined();
  });

  it("ignores notifications (no response)", async () => {
    const server = buildServer();
    const res = await server.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res).toBeNull();
  });

  it("converts OpenAI tool defs to MCP shape on tools/list", async () => {
    const server = buildServer();
    const res = await server.handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(res.result.tools).toHaveLength(3);
    const t = res.result.tools.find((tool) => tool.name === "web_browser");
    expect(t.description).toBe("Run browser actions");
    expect(t.inputSchema).toEqual(sampleTools[0].function.parameters);
  });

  it("namespaces tool names with toolNamePrefix", async () => {
    const server = buildServer({ toolNamePrefix: "procway" });
    const res = await server.handleMessage({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    expect(res.result.tools.map((t) => t.name)).toEqual(["procway/web_browser", "procway/write_file", "procway/read_file"]);
  });

  it("dispatches tools/call to executeToolCall and strips the prefix", async () => {
    const exec = vi.fn(async () => ({ kind: "write_file", summary: "wrote 100 bytes", data: { bytes: 100 } }));
    const server = buildServer({ toolNamePrefix: "procway", executeToolCall: exec });
    const res = await server.handleMessage({
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "procway/write_file", arguments: { path: "a.txt", content: "x" } }
    });
    expect(exec).toHaveBeenCalledWith("write_file", { path: "a.txt", content: "x" });
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0].type).toBe("text");
    expect(res.result.content[0].text).toContain("wrote 100 bytes");
  });

  it("marks isError=true when executeToolCall returns a skipped/error result", async () => {
    const exec = vi.fn(async () => ({ kind: "write_file", summary: "denied", data: { skipped: true, error: "User denied approval" } }));
    const server = buildServer({ executeToolCall: exec });
    const res = await server.handleMessage({
      jsonrpc: "2.0", id: 5, method: "tools/call",
      params: { name: "write_file", arguments: {} }
    });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("denied");
  });

  it("returns JSON-RPC -32602 for unknown tool", async () => {
    const server = buildServer();
    const res = await server.handleMessage({
      jsonrpc: "2.0", id: 6, method: "tools/call",
      params: { name: "nonexistent", arguments: {} }
    });
    expect(res.error.code).toBe(-32602);
    expect(res.error.message).toContain("nonexistent");
  });

  it("returns -32601 for unknown method", async () => {
    const server = buildServer();
    const res = await server.handleMessage({ jsonrpc: "2.0", id: 7, method: "foo/bar" });
    expect(res.error.code).toBe(-32601);
  });

  it("returns empty resources/list and prompts/list rather than -32601", async () => {
    const server = buildServer();
    const r = await server.handleMessage({ jsonrpc: "2.0", id: 8, method: "resources/list" });
    expect(r.result).toEqual({ resources: [] });
    const p = await server.handleMessage({ jsonrpc: "2.0", id: 9, method: "prompts/list" });
    expect(p.result).toEqual({ prompts: [] });
  });
});
