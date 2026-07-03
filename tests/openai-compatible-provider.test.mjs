import { describe, expect, it, vi } from "vitest";
import { ProviderRequestError, isRetryableNetworkError, runOpenAiCompatibleProvider } from "../src/providers/openai-compatible.mjs";

describe("runOpenAiCompatibleProvider", () => {
  it("posts chat completions request and returns message content (non-streaming)", async () => {
    process.env.TEST_OPENROUTER_KEY = "test-key";
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({
        choices: [{ message: { content: "hello" } }],
        usage: { prompt_tokens: 5, completion_tokens: 3 }
      })
    }));

    const result = await runOpenAiCompatibleProvider({
      provider: {
        baseUrl: "https://openrouter.ai/api/v1",
        apiKeyEnv: "TEST_OPENROUTER_KEY"
      },
      model: "deepseek/deepseek-v4-flash",
      prompt: "hi",
      fetchImpl,
      stream: false
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-key",
          "Content-Type": "application/json"
        })
      })
    );
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).toEqual({
      model: "deepseek/deepseek-v4-flash",
      messages: [{ role: "user", content: "hi" }]
    });
    expect(result.message.content).toBe("hello");
    expect(result.toolCalls).toEqual([]);
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 3 });
    expect(result).not.toHaveProperty("stdout");
    expect(result).not.toHaveProperty("stderr");
    expect(result).not.toHaveProperty("exitCode");
  });

  it("returns normalized tool calls", async () => {
    process.env.TEST_OPENROUTER_KEY = "test-key";
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: {
                name: "list_files",
                arguments: "{\"dirPath\":\".\"}"
              }
            }]
          }
        }]
      })
    }));

    const result = await runOpenAiCompatibleProvider({
      provider: {
        baseUrl: "https://openrouter.ai/api/v1",
        apiKeyEnv: "TEST_OPENROUTER_KEY"
      },
      model: "deepseek/deepseek-v4-flash",
      messages: [{ role: "user", content: "inspect" }],
      tools: [{ type: "function", function: { name: "list_files", parameters: { type: "object" } } }],
      fetchImpl,
      stream: false
    });

    expect(result.toolCalls).toEqual([{
      id: "call_1",
      name: "list_files",
      args: { dirPath: "." }
    }]);
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.tools).toHaveLength(1);
    expect(body.tool_choice).toBe("auto");
  });

  it("does not throw on empty assistant messages", async () => {
    process.env.TEST_OPENROUTER_KEY = "test-key";
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({
        choices: [{ message: { role: "assistant", content: null } }]
      })
    }));

    const result = await runOpenAiCompatibleProvider({
      provider: {
        baseUrl: "https://openrouter.ai/api/v1",
        apiKeyEnv: "TEST_OPENROUTER_KEY"
      },
      model: "deepseek/deepseek-v4-flash",
      prompt: "hi",
      fetchImpl,
      stream: false
    });

    expect(result.message.content).toBe("");
  });

  it("retries retryable provider errors (non-streaming)", async () => {
    process.env.TEST_OPENROUTER_KEY = "test-key";
    const sleepImpl = vi.fn(async () => {});
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        headers: { get: () => null },
        text: async () => "rate limited"
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify({
          choices: [{ message: { role: "assistant", content: "retry ok" } }]
        })
      });

    const result = await runOpenAiCompatibleProvider({
      provider: {
        baseUrl: "https://openrouter.ai/api/v1",
        apiKeyEnv: "TEST_OPENROUTER_KEY",
        maxRetries: 1,
        retryBaseDelayMs: 5
      },
      model: "deepseek/deepseek-v4-flash",
      prompt: "hi",
      fetchImpl,
      sleepImpl,
      stream: false
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledWith(5);
    expect(result.message.content).toBe("retry ok");
  });

  it("throws ProviderRequestError after retryable errors are exhausted", async () => {
    process.env.TEST_OPENROUTER_KEY = "test-key";
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      headers: { get: () => "0" },
      text: async () => "temporarily unavailable"
    }));

    await expect(runOpenAiCompatibleProvider({
      provider: {
        baseUrl: "https://openrouter.ai/api/v1",
        apiKeyEnv: "TEST_OPENROUTER_KEY",
        maxRetries: 1
      },
      model: "deepseek/deepseek-v4-flash",
      prompt: "hi",
      fetchImpl,
      sleepImpl: vi.fn(async () => {}),
      stream: false
    })).rejects.toMatchObject({
      name: "ProviderRequestError",
      status: 503,
      retryable: true
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-retryable provider errors", async () => {
    process.env.TEST_OPENROUTER_KEY = "test-key";
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: async () => "bad request"
    }));

    await expect(runOpenAiCompatibleProvider({
      provider: {
        baseUrl: "https://openrouter.ai/api/v1",
        apiKeyEnv: "TEST_OPENROUTER_KEY",
        maxRetries: 3
      },
      model: "deepseek/deepseek-v4-flash",
      prompt: "hi",
      fetchImpl,
      sleepImpl: vi.fn(async () => {}),
      stream: false
    })).rejects.toBeInstanceOf(ProviderRequestError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries transient network errors (TypeError: fetch failed)", async () => {
    process.env.TEST_OPENROUTER_KEY = "test-key";
    const sleepImpl = vi.fn(async () => {});
    const networkErr = new TypeError("fetch failed");
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(networkErr)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify({
          choices: [{ message: { role: "assistant", content: "recovered" } }]
        })
      });

    const result = await runOpenAiCompatibleProvider({
      provider: {
        baseUrl: "https://openrouter.ai/api/v1",
        apiKeyEnv: "TEST_OPENROUTER_KEY",
        maxRetries: 2,
        retryBaseDelayMs: 5
      },
      model: "x",
      prompt: "hi",
      fetchImpl,
      sleepImpl,
      stream: false
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledWith(5);
    expect(result.message.content).toBe("recovered");
  });

  it("retries known errno codes (ECONNRESET)", async () => {
    process.env.TEST_OPENROUTER_KEY = "test-key";
    const sleepImpl = vi.fn(async () => {});
    const errnoErr = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(errnoErr)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify({ choices: [{ message: { role: "assistant", content: "x" } }] })
      });

    const result = await runOpenAiCompatibleProvider({
      provider: { baseUrl: "https://x", apiKeyEnv: "TEST_OPENROUTER_KEY", maxRetries: 1, retryBaseDelayMs: 5 },
      model: "x",
      prompt: "hi",
      fetchImpl,
      sleepImpl,
      stream: false
    });
    expect(result.message.content).toBe("x");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry AbortError", async () => {
    process.env.TEST_OPENROUTER_KEY = "test-key";
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    const fetchImpl = vi.fn().mockRejectedValue(abortErr);

    await expect(runOpenAiCompatibleProvider({
      provider: { baseUrl: "https://x", apiKeyEnv: "TEST_OPENROUTER_KEY", maxRetries: 3 },
      model: "x",
      prompt: "hi",
      fetchImpl,
      sleepImpl: vi.fn(async () => {}),
      stream: false
    })).rejects.toBe(abortErr);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throws the last network error after retries are exhausted", async () => {
    process.env.TEST_OPENROUTER_KEY = "test-key";
    const networkErr = new TypeError("fetch failed");
    const fetchImpl = vi.fn().mockRejectedValue(networkErr);

    await expect(runOpenAiCompatibleProvider({
      provider: { baseUrl: "https://x", apiKeyEnv: "TEST_OPENROUTER_KEY", maxRetries: 1, retryBaseDelayMs: 5 },
      model: "x",
      prompt: "hi",
      fetchImpl,
      sleepImpl: vi.fn(async () => {}),
      stream: false
    })).rejects.toBe(networkErr);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("sends reasoning_effort when configured, omits it when unset or invalid", async () => {
    process.env.TEST_OPENROUTER_KEY = "test-key";
    const base = { baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "TEST_OPENROUTER_KEY" };
    const make = () => vi.fn(async () => ({
      ok: true, status: 200, statusText: "OK",
      text: async () => JSON.stringify({ choices: [{ message: { content: "x" } }] })
    }));

    const f1 = make();
    await runOpenAiCompatibleProvider({ provider: { ...base, reasoningEffort: "low" }, model: "m", prompt: "hi", fetchImpl: f1, stream: false });
    expect(JSON.parse(f1.mock.calls[0][1].body).reasoning_effort).toBe("low");

    const f2 = make();
    await runOpenAiCompatibleProvider({ provider: { ...base, reasoningEffort: "ultra" }, model: "m", prompt: "hi", fetchImpl: f2, stream: false });
    expect(JSON.parse(f2.mock.calls[0][1].body).reasoning_effort).toBeUndefined();

    const f3 = make();
    await runOpenAiCompatibleProvider({ provider: base, model: "m", prompt: "hi", fetchImpl: f3, stream: false });
    expect(JSON.parse(f3.mock.calls[0][1].body).reasoning_effort).toBeUndefined();
  });

  it("streams reasoning_content / reasoning deltas tagged kind:'reasoning' ahead of visible content", async () => {
    process.env.TEST_OPENROUTER_KEY = "test-key";
    const encoder = new TextEncoder();
    const buildSseStream = (events) => new ReadableStream({
      start(controller) {
        for (const data of events) {
          const payload = data === "[DONE]" ? "[DONE]" : JSON.stringify(data);
          controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        }
        controller.close();
      }
    });
    const events = [
      { choices: [{ delta: { reasoning_content: "think " } }] },
      { choices: [{ delta: { reasoning: "more" } }] },
      { choices: [{ delta: { content: "Answer" } }] },
      "[DONE]"
    ];
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, body: buildSseStream(events) }));
    const response = await runOpenAiCompatibleProvider({
      provider: { baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "TEST_OPENROUTER_KEY" },
      model: "m",
      prompt: "hi",
      fetchImpl
    });

    const reasoning = [];
    const visible = [];
    for await (const chunk of response.deltaStream) {
      if (chunk.kind === "reasoning") reasoning.push(chunk.deltaText);
      else visible.push(chunk.deltaText);
    }
    expect(reasoning).toEqual(["think ", "more"]);
    expect(visible).toEqual(["Answer"]);
    const final = await response.finalize();
    expect(final.message.content).toBe("Answer");
  });
});

describe("isRetryableNetworkError", () => {
  it("returns true for TypeError('fetch failed')", () => {
    expect(isRetryableNetworkError(new TypeError("fetch failed"))).toBe(true);
  });
  it("returns true for known errno codes", () => {
    expect(isRetryableNetworkError(Object.assign(new Error(), { code: "ECONNRESET" }))).toBe(true);
    expect(isRetryableNetworkError(Object.assign(new Error(), { code: "ENOTFOUND" }))).toBe(true);
    expect(isRetryableNetworkError(Object.assign(new Error(), { code: "ETIMEDOUT" }))).toBe(true);
  });
  it("returns true when cause carries a known code", () => {
    const err = new TypeError("fetch failed");
    err.cause = Object.assign(new Error("under"), { code: "UND_ERR_SOCKET" });
    expect(isRetryableNetworkError(err)).toBe(true);
  });
  it("returns false for AbortError and ProviderRequestError", () => {
    expect(isRetryableNetworkError(Object.assign(new Error(), { name: "AbortError" }))).toBe(false);
    expect(isRetryableNetworkError(new ProviderRequestError({ status: 400, statusText: "bad", body: "", retryable: false }))).toBe(false);
  });
  it("returns false for arbitrary errors", () => {
    expect(isRetryableNetworkError(new Error("boom"))).toBe(false);
    expect(isRetryableNetworkError(null)).toBe(false);
  });
});

describe("runOpenAiCompatibleProvider (openai-via-proxy)", () => {
  it("omits Authorization when no api key — the broker injects it (ADR 0008 §F7c)", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] })
    }));
    const result = await runOpenAiCompatibleProvider({
      provider: { type: "openai-via-proxy", baseUrl: "http://procway-dashboard:3333/api/agent-llm-proxy/openai" },
      model: "x-ai/grok",
      prompt: "hi",
      fetchImpl,
      stream: false
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://procway-dashboard:3333/api/agent-llm-proxy/openai/chat/completions",
      expect.objectContaining({ method: "POST" })
    );
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBeUndefined();
    expect(result.message.content).toBe("ok");
  });

  it("sends Authorization: Bearer from PROCWAY_PROXY_TOKEN when via proxy (T1-17)", async () => {
    process.env.PROCWAY_PROXY_TOKEN = "sess-secret";
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] })
    }));
    await runOpenAiCompatibleProvider({
      provider: { type: "openai-via-proxy", baseUrl: "http://procway-dashboard:3333/api/agent-llm-proxy/openai" },
      model: "x-ai/grok",
      prompt: "hi",
      fetchImpl,
      stream: false
    });
    // The broker strips this inbound token and attaches the real Bearer upstream.
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe("Bearer sess-secret");
    delete process.env.PROCWAY_PROXY_TOKEN;
  });
});
