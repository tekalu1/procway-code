import { describe, expect, it, vi } from "vitest";
import { isToolResult } from "../src/core/types/tool-result.mjs";
import { parseDuckDuckGoHtml, runWebFetch, runWebSearch } from "../src/tools/web-search.mjs";
import { executeToolCall, getToolDefinitions, isMutationTool } from "../src/tools/registry.mjs";

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "ERR",
    headers: { get: () => "application/json" },
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer
  };
}

function htmlResponse(html, status = 200) {
  const bytes = new TextEncoder().encode(html).buffer;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "ERR",
    headers: { get: () => "text/html; charset=utf-8" },
    text: async () => html,
    arrayBuffer: async () => bytes
  };
}

describe("web search backends", () => {
  it("queries Tavily and normalizes results", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      results: [
        { title: "T1", url: "https://example.com/1", content: "snip1" },
        { title: "T2", url: "https://example.com/2", content: "snip2" }
      ]
    }));
    const result = await runWebSearch({
      query: "claude code",
      maxResults: 2,
      settings: { tools: { webSearch: { backend: "tavily" } } },
      fetchImpl,
      env: { TAVILY_API_KEY: "key-123" }
    });
    expect(isToolResult(result)).toBe(true);
    expect(result.kind).toBe("web_search");
    expect(result.data.backend).toBe("tavily");
    expect(result.data.results).toHaveLength(2);
    expect(result.data.results[0]).toEqual({ title: "T1", url: "https://example.com/1", snippet: "snip1" });
    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(init.body)).toMatchObject({ api_key: "key-123", query: "claude code", max_results: 2 });
  });

  it("queries Brave and normalizes results", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      web: { results: [{ title: "B1", url: "https://b.example/1", description: "snip" }] }
    }));
    const result = await runWebSearch({
      query: "procway",
      settings: { tools: { webSearch: { backend: "brave" } } },
      fetchImpl,
      env: { BRAVE_SEARCH_API_KEY: "brave-key" }
    });
    expect(result.data.results).toEqual([{ title: "B1", url: "https://b.example/1", snippet: "snip" }]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain("q=procway");
    expect(init.headers["X-Subscription-Token"]).toBe("brave-key");
  });

  it("queries Serper and normalizes organic results", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      organic: [{ title: "S1", link: "https://s.example/1", snippet: "snip" }]
    }));
    const result = await runWebSearch({
      query: "x",
      settings: { tools: { webSearch: { backend: "serper" } } },
      fetchImpl,
      env: { SERPER_API_KEY: "serper-key" }
    });
    expect(result.data.results[0].url).toBe("https://s.example/1");
  });

  it("queries Google CSE with the configured cx id", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      items: [{ title: "G1", link: "https://g.example/1", snippet: "snip" }]
    }));
    const result = await runWebSearch({
      query: "anthropic",
      settings: { tools: { webSearch: { backend: "google-cse", googleCseId: "cx-id" } } },
      fetchImpl,
      env: { GOOGLE_CSE_API_KEY: "google-key" }
    });
    expect(result.data.results).toHaveLength(1);
    const [url] = fetchImpl.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.searchParams.get("cx")).toBe("cx-id");
    expect(parsed.searchParams.get("key")).toBe("google-key");
  });

  it("falls back to DuckDuckGo HTML scrape when no API key is required", async () => {
    const html = `
      <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fa">Example A</a>
      <a class="result__snippet">snippet A</a>
      <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fb">Example B</a>
      <a class="result__snippet">snippet B</a>
    `;
    const fetchImpl = vi.fn(async () => htmlResponse(html));
    const result = await runWebSearch({
      query: "duck",
      settings: {},
      fetchImpl,
      env: {}
    });
    expect(result.data.backend).toBe("duckduckgo");
    expect(result.data.results).toHaveLength(2);
    expect(result.data.results[0]).toEqual({
      title: "Example A",
      url: "https://example.com/a",
      snippet: "snippet A"
    });
  });

  it("rejects when an API-key backend is selected but the key is missing", async () => {
    await expect(runWebSearch({
      query: "x",
      settings: { tools: { webSearch: { backend: "tavily" } } },
      fetchImpl: vi.fn(),
      env: {}
    })).rejects.toThrow(/Tavily backend requires an API key/);
  });

  it("rejects empty queries", async () => {
    await expect(runWebSearch({ query: "   ", settings: {}, fetchImpl: vi.fn() }))
      .rejects.toThrow(/query is required/);
  });

  it("clamps maxResults to the supported range", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ results: [] }));
    await runWebSearch({
      query: "x",
      maxResults: 99,
      settings: { tools: { webSearch: { backend: "tavily" } } },
      fetchImpl,
      env: { TAVILY_API_KEY: "k" }
    });
    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(init.body).max_results).toBe(20);
  });
});

describe("parseDuckDuckGoHtml", () => {
  it("decodes uddg redirect targets", () => {
    const html = '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ffoo">F</a>';
    expect(parseDuckDuckGoHtml(html, 5)).toEqual([{ title: "F", url: "https://foo", snippet: "" }]);
  });

  it("returns an empty list for empty input", () => {
    expect(parseDuckDuckGoHtml("", 5)).toEqual([]);
  });
});

describe("web fetch", () => {
  it("returns truncated text body and headers", async () => {
    const fetchImpl = vi.fn(async () => htmlResponse("<html>hello world</html>"));
    const result = await runWebFetch({
      url: "https://example.com",
      maxBytes: 10,
      fetchImpl
    });
    expect(isToolResult(result)).toBe(true);
    expect(result.kind).toBe("web_fetch");
    expect(result.data.truncated).toBe(true);
    expect(result.data.body.length).toBeLessThanOrEqual(10);
    expect(result.data.contentType).toContain("text/html");
  });

  it("propagates HTTP error status", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 404,
      statusText: "Not Found",
      headers: { get: () => "text/plain" },
      text: async () => "missing",
      arrayBuffer: async () => new ArrayBuffer(0)
    }));
    await expect(runWebFetch({ url: "https://example.com/missing", fetchImpl }))
      .rejects.toThrow(/HTTP 404/);
  });

  it("rejects when url is missing", async () => {
    await expect(runWebFetch({ url: "", fetchImpl: vi.fn() })).rejects.toThrow(/url is required/);
  });
});

describe("registry integration for WebSearch / WebFetch", () => {
  it("registers WebSearch and WebFetch as read-only tools", () => {
    const names = getToolDefinitions().map((tool) => tool.function.name);
    expect(names).toEqual(expect.arrayContaining(["WebSearch", "WebFetch"]));
    expect(isMutationTool("WebSearch")).toBe(false);
    expect(isMutationTool("WebFetch")).toBe(false);
  });

  it("invokes the injected web search runner with the approval gate", async () => {
    const approvalRequester = vi.fn(async () => true);
    const webSearchRunner = vi.fn(async () => ({
      kind: "web_search",
      summary: "ok",
      data: { backend: "tavily", query: "q", maxResults: 5, results: [] }
    }));

    const result = await executeToolCall({
      name: "WebSearch",
      args: { query: "claude code", maxResults: 3 },
      cwd: process.cwd(),
      settings: { approvalMode: "full-auto" },
      approvalRequester,
      webSearchRunner
    });

    expect(approvalRequester).toHaveBeenCalledWith(expect.objectContaining({
      kind: "web_search",
      mutation: false
    }));
    expect(webSearchRunner).toHaveBeenCalledWith(expect.objectContaining({
      query: "claude code",
      maxResults: 3
    }));
    expect(isToolResult(result)).toBe(true);
    expect(result.kind).toBe("web_search");
  });

  it("skips WebSearch when approval is denied", async () => {
    const approvalRequester = vi.fn(async () => false);
    const webSearchRunner = vi.fn();
    const result = await executeToolCall({
      name: "WebSearch",
      args: { query: "x" },
      cwd: process.cwd(),
      settings: { approvalMode: "always-ask" },
      approvalRequester,
      webSearchRunner
    });
    expect(webSearchRunner).not.toHaveBeenCalled();
    expect(isToolResult(result)).toBe(true);
    expect(result.kind).toBe("web_search");
    expect(result.data.skipped).toBe(true);
  });

  it("invokes web fetch through the registry", async () => {
    const webFetchRunner = vi.fn(async () => ({
      kind: "web_fetch",
      summary: "ok",
      data: { url: "https://example.com", status: 200, contentType: "text/html", bytes: 4, truncated: false, encoding: "utf-8", body: "ok" }
    }));
    const result = await executeToolCall({
      name: "WebFetch",
      args: { url: "https://example.com" },
      cwd: process.cwd(),
      settings: { approvalMode: "full-auto" },
      approvalRequester: vi.fn(async () => true),
      webFetchRunner
    });
    expect(webFetchRunner).toHaveBeenCalledWith(expect.objectContaining({ url: "https://example.com" }));
    expect(isToolResult(result)).toBe(true);
    expect(result.kind).toBe("web_fetch");
  });
});
