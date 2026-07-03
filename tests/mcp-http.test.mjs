import { describe, expect, it } from "vitest";
import { HttpMcpTransport } from "../src/mcp/transports/http.mjs";
import { McpClient } from "../src/mcp/client.mjs";
import { McpToolRegistry, expandEnvReferences } from "../src/mcp/registry.mjs";

function memoryStream(events = []) {
  let pending = events.slice();
  let resolveNext = null;
  const stream = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (pending.length === 0) {
            await new Promise((resolve) => { resolveNext = resolve; });
          }
          if (pending.length === 0) return { value: undefined, done: true };
          const value = pending.shift();
          return { value, done: false };
        }
      };
    },
    push(value) {
      pending.push(value);
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r();
      }
    },
    close() {
      pending = [];
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r();
      }
    }
  };
  return stream;
}

function makeFetch({ tokens = [], responses = new Map() } = {}) {
  const calls = [];
  const tokenQueue = tokens.slice();
  return {
    calls,
    async fetch(url, options = {}) {
      calls.push({ url, method: options.method ?? "GET", headers: options.headers ?? {}, body: options.body });
      if (typeof url === "string" && url.endsWith("/oauth/token")) {
        const token = tokenQueue.shift() ?? "default-token";
        return new Response(JSON.stringify({ access_token: token, refresh_token: "refresh-2" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (typeof url === "string" && url.endsWith("/messages")) {
        const handler = responses.get("messages");
        const body = JSON.parse(options.body ?? "{}");
        const result = handler ? handler(body, options) : { jsonrpc: "2.0", id: body.id, result: {} };
        return new Response(JSON.stringify(result), {
          status: result?.__status ?? 200,
          headers: { "content-type": "application/json" }
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }
  };
}

describe("HttpMcpTransport", () => {
  it("delivers SSE-pushed messages through onmessage", async () => {
    const stream = memoryStream();
    const transport = new HttpMcpTransport({
      baseUrl: "https://mcp.example.com",
      sseStreamFactory: async () => stream,
      fetchImpl: async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    });
    const received = [];
    transport.onmessage = (msg) => received.push(msg);

    await transport.start();
    stream.push(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 99, result: { hi: 1 } })}\n\n`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    stream.close();

    expect(received.find((msg) => msg.id === 99)).toBeTruthy();
  });

  it("performs JSON-RPC requests over POST /messages with Bearer header", async () => {
    const stream = memoryStream();
    const fetcher = makeFetch({
      responses: new Map([
        ["messages", (body) => ({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "ping" }] } })]
      ])
    });
    const transport = new HttpMcpTransport({
      baseUrl: "https://mcp.example.com",
      headers: { Authorization: "Bearer token-1" },
      fetchImpl: fetcher.fetch,
      sseStreamFactory: async () => stream
    });
    const client = new McpClient({ transport, timeoutMs: 1000 });
    await transport.start();

    const result = await client.request("tools/list");
    expect(result.tools[0].name).toBe("ping");
    const messageCall = fetcher.calls.find((entry) => entry.url.endsWith("/messages"));
    expect(messageCall.headers.Authorization).toBe("Bearer token-1");
  });

  it("acquires an OAuth token at start and refreshes on 401", async () => {
    const stream = memoryStream();
    let counter = 0;
    const fetcher = makeFetch({
      tokens: ["initial-token", "refreshed-token"],
      responses: new Map([
        ["messages", (body) => {
          counter += 1;
          if (counter === 1) return { __status: 401, jsonrpc: "2.0", id: body.id, error: { message: "unauthorized" } };
          return { jsonrpc: "2.0", id: body.id, result: { tools: [] } };
        }]
      ])
    });
    const transport = new HttpMcpTransport({
      baseUrl: "https://mcp.example.com",
      oauth: {
        tokenEndpoint: "https://auth.example.com/oauth/token",
        clientId: "abc",
        refreshToken: "refresh-1"
      },
      fetchImpl: fetcher.fetch,
      sseStreamFactory: async () => stream
    });
    const client = new McpClient({ transport, timeoutMs: 2000 });
    await transport.start();

    await client.request("tools/list");

    const tokenCalls = fetcher.calls.filter((c) => c.url.endsWith("/oauth/token"));
    expect(tokenCalls.length).toBe(2);
    const lastMessage = fetcher.calls.filter((c) => c.url.endsWith("/messages")).pop();
    expect(lastMessage.headers.Authorization).toBe("Bearer refreshed-token");
  });
});

describe("McpToolRegistry HTTP integration", () => {
  it("expands ${env:VAR} references inside string fields", () => {
    const expanded = expandEnvReferences({
      transport: "http",
      baseUrl: "https://mcp.example.com",
      headers: { Authorization: "Bearer ${env:NOTION_TOKEN}" },
      args: ["${env:HOME}"]
    }, { NOTION_TOKEN: "secret-token", HOME: "/home/user" });
    expect(expanded.headers.Authorization).toBe("Bearer secret-token");
    expect(expanded.args[0]).toBe("/home/user");
  });

  it("registers HTTP-transport servers and surfaces their tools", async () => {
    const stream = memoryStream();
    const fetcher = makeFetch({
      responses: new Map([
        ["messages", (body) => {
          if (body.method === "initialize") {
            return { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } };
          }
          if (body.method === "tools/list") {
            return { jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "echo", description: "Echo" }] } };
          }
          if (body.method === "resources/list" || body.method === "prompts/list") {
            return { jsonrpc: "2.0", id: body.id, result: { resources: [], prompts: [] } };
          }
          return { jsonrpc: "2.0", id: body.id, result: {} };
        }]
      ])
    });
    const registry = new McpToolRegistry({
      settings: {
        mcpServers: {
          notion: {
            transport: "http",
            baseUrl: "https://mcp.example.com",
            headers: { Authorization: "Bearer ${env:NOTION_TOKEN}" }
          }
        }
      },
      env: { NOTION_TOKEN: "tok-abc" },
      fetchImpl: fetcher.fetch,
      transportFactory: (server) => new HttpMcpTransport({
        baseUrl: server.baseUrl,
        headers: server.headers,
        fetchImpl: fetcher.fetch,
        sseStreamFactory: async () => stream
      })
    });

    await registry.start();
    expect(registry.getToolDefinitions().map((tool) => tool.function.name)).toContain("mcp__notion__echo");
    await registry.close();
    stream.close();
  });
});
