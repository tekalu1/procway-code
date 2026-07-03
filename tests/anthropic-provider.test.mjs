import { describe, expect, it, vi } from "vitest";
import { runAnthropicProvider } from "../src/providers/anthropic.mjs";

describe("runAnthropicProvider", () => {
  it("posts a Messages API request and returns text (non-streaming)", async () => {
    process.env.TEST_ANTHROPIC_KEY = "test-key";
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({
        content: [{ type: "text", text: "hello" }],
        usage: { input_tokens: 4, output_tokens: 2 }
      })
    }));

    const result = await runAnthropicProvider({
      provider: {
        baseUrl: "https://api.anthropic.com",
        apiKeyEnv: "TEST_ANTHROPIC_KEY"
      },
      model: "claude-sonnet-test",
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "hi" }
      ],
      tools: [{ type: "function", function: { name: "list_files", description: "list", parameters: { type: "object" } } }],
      fetchImpl,
      stream: false
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-api-key": "test-key",
          "anthropic-version": "2023-06-01"
        })
      })
    );
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.system).toBe("system prompt");
    // Prompt caching (audit ④): the first user message (here also the last)
    // carries a cache breakpoint, which requires block-shaped content.
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }
    ]);
    expect(body.tools).toEqual([
      { name: "list_files", description: "list", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } }
    ]);
    expect(body.stream).toBeUndefined();
    expect(result.message.content).toBe("hello");
    expect(result.toolCalls).toEqual([]);
    expect(result.usage).toEqual({ inputTokens: 4, outputTokens: 2 });
    expect(result).not.toHaveProperty("stdout");
    expect(result).not.toHaveProperty("stderr");
    expect(result).not.toHaveProperty("exitCode");
  });

  it("normalizes tool_use blocks", async () => {
    process.env.TEST_ANTHROPIC_KEY = "test-key";
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({
        content: [{ type: "tool_use", id: "toolu_1", name: "read_file", input: { filePath: "README.md" } }]
      })
    }));

    const result = await runAnthropicProvider({
      provider: {
        baseUrl: "https://api.anthropic.com",
        apiKeyEnv: "TEST_ANTHROPIC_KEY"
      },
      model: "claude-sonnet-test",
      prompt: "inspect",
      fetchImpl,
      stream: false
    });

    expect(result.toolCalls).toEqual([{
      id: "toolu_1",
      name: "read_file",
      args: { filePath: "README.md" }
    }]);
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("anthropic-via-proxy sends no x-api-key (broker injects the credential)", async () => {
    // ADR 0008 §F7c: the session holds no API key. The provider must reach the
    // proxy baseUrl with no credential header — the dashboard adds the real one.
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ content: [{ type: "text", text: "ok" }] })
    }));

    const result = await runAnthropicProvider({
      provider: {
        type: "anthropic-via-proxy",
        baseUrl: "http://procway-dashboard:3333/api/agent-llm-proxy/anthropic"
      },
      model: "claude-sonnet-4-6",
      prompt: "hi",
      fetchImpl,
      stream: false
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://procway-dashboard:3333/api/agent-llm-proxy/anthropic/v1/messages",
      expect.objectContaining({ method: "POST" })
    );
    const headers = fetchImpl.mock.calls[0][1].headers;
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(result.message.content).toBe("ok");
  });
});

describe("runAnthropicProvider — broker session token (T1-17)", () => {
  function okFetch() {
    return vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }),
    }));
  }

  it("sends Authorization: Bearer from PROCWAY_PROXY_TOKEN when via proxy", async () => {
    process.env.PROCWAY_PROXY_TOKEN = "sess-secret";
    const fetchImpl = okFetch();
    await runAnthropicProvider({
      provider: { type: "anthropic-via-proxy", baseUrl: "http://dash:3333/api/agent-llm-proxy/anthropic" },
      model: "claude-x",
      messages: [{ role: "user", content: "hi" }],
      fetchImpl,
      stream: false,
    });
    const headers = fetchImpl.mock.calls[0][1].headers;
    expect(headers.authorization).toBe("Bearer sess-secret");
    // The proxy strips/attaches the upstream credential, so no x-api-key.
    expect(headers["x-api-key"]).toBeUndefined();
    delete process.env.PROCWAY_PROXY_TOKEN;
  });

  it("omits Authorization when via proxy but no token (local/single-tenant)", async () => {
    delete process.env.PROCWAY_PROXY_TOKEN;
    const fetchImpl = okFetch();
    await runAnthropicProvider({
      provider: { type: "anthropic-via-proxy", baseUrl: "http://dash:3333/api/agent-llm-proxy/anthropic" },
      model: "claude-x",
      messages: [{ role: "user", content: "hi" }],
      fetchImpl,
      stream: false,
    });
    expect(fetchImpl.mock.calls[0][1].headers.authorization).toBeUndefined();
  });

  it("does NOT send the proxy token for a direct (non-proxy) provider", async () => {
    process.env.PROCWAY_PROXY_TOKEN = "sess-secret";
    process.env.TEST_KEY = "direct-key";
    const fetchImpl = okFetch();
    await runAnthropicProvider({
      provider: { baseUrl: "https://api.anthropic.com", apiKeyEnv: "TEST_KEY" },
      model: "claude-x",
      messages: [{ role: "user", content: "hi" }],
      fetchImpl,
      stream: false,
    });
    const headers = fetchImpl.mock.calls[0][1].headers;
    expect(headers.authorization).toBeUndefined();
    expect(headers["x-api-key"]).toBe("direct-key");
    delete process.env.PROCWAY_PROXY_TOKEN;
    delete process.env.TEST_KEY;
  });
});
