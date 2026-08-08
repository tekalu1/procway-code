import { describe, expect, it, vi } from "vitest";
import { StreamableHttpMcpTransport } from "../src/mcp/transports/streamable-http.mjs";
import { McpClient } from "../src/mcp/client.mjs";

async function* sseChunks(chunks) {
  for (const chunk of chunks) yield chunk;
}

function fakeResponse({ status = 200, headers = {}, jsonBody = null, sse = null } = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  if (jsonBody && !map.has("content-type")) map.set("content-type", "application/json");
  if (sse) map.set("content-type", "text/event-stream");
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => map.get(String(k).toLowerCase()) ?? null },
    body: sse ? sseChunks(sse) : null,
    json: async () => jsonBody,
    text: async () => JSON.stringify(jsonBody ?? "")
  };
}

function recordingFetch(handler) {
  const calls = [];
  return {
    calls,
    async fetch(url, options = {}) {
      const call = { url, method: options.method ?? "GET", headers: options.headers ?? {}, body: options.body };
      calls.push(call);
      return handler(call);
    }
  };
}

const BASE = "https://mcp.example.com/mcp";

describe("StreamableHttpMcpTransport", () => {
  it("POSTs every message to the single endpoint and captures the session id", async () => {
    const fetcher = recordingFetch((call) => {
      const body = JSON.parse(call.body);
      if (body.method === "initialize") {
        return fakeResponse({
          headers: { "Mcp-Session-Id": "sess-1" },
          jsonBody: { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "s" } } }
        });
      }
      return fakeResponse({ jsonBody: { jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "ping" }] } } });
    });
    const transport = new StreamableHttpMcpTransport({ baseUrl: BASE, headers: { Authorization: "Bearer t1" }, fetchImpl: fetcher.fetch });
    const client = new McpClient({ transport, timeoutMs: 1000 });

    const init = await client.start();
    expect(init.protocolVersion).toBe("2025-06-18");
    const tools = await client.listTools();
    expect(tools[0].name).toBe("ping");

    expect(fetcher.calls.every((c) => c.url === BASE && c.method === "POST")).toBe(true);
    const second = fetcher.calls[1];
    // Session id + negotiated protocol version echo on subsequent requests.
    expect(second.headers["Mcp-Session-Id"]).toBe("sess-1");
    expect(second.headers["MCP-Protocol-Version"]).toBe("2025-06-18");
    expect(second.headers.Authorization).toBe("Bearer t1");
  });

  it("delivers responses streamed back as text/event-stream", async () => {
    const fetcher = recordingFetch((call) => {
      const body = JSON.parse(call.body);
      return fakeResponse({
        sse: [`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { streamed: true } })}\n\n`]
      });
    });
    const transport = new StreamableHttpMcpTransport({ baseUrl: BASE, fetchImpl: fetcher.fetch });
    const client = new McpClient({ transport, timeoutMs: 1000 });

    const result = await client.request("tools/list");
    expect(result.streamed).toBe(true);
  });

  it("treats 202 as an accepted notification (no response body)", async () => {
    const fetcher = recordingFetch(() => fakeResponse({ status: 202 }));
    const transport = new StreamableHttpMcpTransport({ baseUrl: BASE, fetchImpl: fetcher.fetch });
    await expect(transport.send({ jsonrpc: "2.0", method: "notifications/initialized" })).resolves.toBeUndefined();
  });

  it("re-reads headers through authProvider on 401 and retries once", async () => {
    let attempt = 0;
    const fetcher = recordingFetch((call) => {
      const body = JSON.parse(call.body);
      attempt += 1;
      if (attempt === 1) return fakeResponse({ status: 401 });
      return fakeResponse({ jsonBody: { jsonrpc: "2.0", id: body.id, result: {} } });
    });
    const tokens = ["stale", "fresh"];
    const authProvider = vi.fn(async () => ({ Authorization: `Bearer ${tokens.shift()}` }));
    const transport = new StreamableHttpMcpTransport({ baseUrl: BASE, authProvider, fetchImpl: fetcher.fetch });
    const client = new McpClient({ transport, timeoutMs: 1000 });

    await transport.start(); // first authProvider read
    await client.request("tools/list");

    expect(authProvider).toHaveBeenCalledTimes(2);
    expect(fetcher.calls[0].headers.Authorization).toBe("Bearer stale");
    expect(fetcher.calls[1].headers.Authorization).toBe("Bearer fresh");
  });

  it("falls back to the legacy HTTP+SSE transport when initialize gets 405", async () => {
    const fetcher = recordingFetch((call) => {
      if (call.method === "POST" && call.url === BASE) {
        return fakeResponse({ status: 405 });
      }
      if (call.method === "GET" && call.url === `${BASE}/sse`) {
        // Keep the legacy handshake stream open but empty.
        return fakeResponse({ sse: [] });
      }
      if (call.method === "POST" && call.url === `${BASE}/messages`) {
        const body = JSON.parse(call.body);
        return fakeResponse({ jsonBody: { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2024-11-05" } } });
      }
      throw new Error(`unexpected fetch: ${call.method} ${call.url}`);
    });
    const transport = new StreamableHttpMcpTransport({ baseUrl: BASE, headers: { Authorization: "Bearer t1" }, fetchImpl: fetcher.fetch });
    const client = new McpClient({ transport, timeoutMs: 1000 });

    const init = await client.start();
    expect(init.protocolVersion).toBe("2024-11-05");

    const legacyPost = fetcher.calls.find((c) => c.url === `${BASE}/messages`);
    expect(legacyPost).toBeTruthy();
    expect(legacyPost.headers.Authorization).toBe("Bearer t1");
  });

  it("does NOT fall back on 4xx after a successful initialize", async () => {
    let n = 0;
    const fetcher = recordingFetch((call) => {
      const body = JSON.parse(call.body);
      n += 1;
      if (n === 1) return fakeResponse({ jsonBody: { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } } });
      return fakeResponse({ status: 404 });
    });
    const transport = new StreamableHttpMcpTransport({ baseUrl: BASE, fetchImpl: fetcher.fetch });
    const client = new McpClient({ transport, timeoutMs: 1000 });
    await client.start();
    await expect(transport.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }))
      .rejects.toThrow(/POST failed \(404\)/);
  });
});
