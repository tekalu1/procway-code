import { describe, expect, it } from "vitest";
import { runAnthropicProvider } from "../src/providers/anthropic.mjs";

function buildSseStream(events) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        const lines = [];
        if (event.event) lines.push(`event: ${event.event}`);
        lines.push(`data: ${JSON.stringify(event.data)}`);
        controller.enqueue(encoder.encode(`${lines.join("\n")}\n\n`));
      }
      controller.close();
    }
  });
}

describe("Anthropic SSE streaming", () => {
  it("emits deltaText chunks in order and finalizes with full content", async () => {
    process.env.TEST_ANTHROPIC_KEY = "key";
    const sseEvents = [
      { event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 10 } } } },
      { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
      { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello " } } },
      { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world" } } },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
      { event: "message_delta", data: { type: "message_delta", usage: { output_tokens: 4 } } }
    ];
    const fetchImpl = async () => ({ ok: true, status: 200, body: buildSseStream(sseEvents) });
    const response = await runAnthropicProvider({
      provider: { baseUrl: "https://api.anthropic.com", apiKeyEnv: "TEST_ANTHROPIC_KEY" },
      model: "claude-sonnet-test",
      prompt: "hi",
      fetchImpl
    });

    const chunks = [];
    for await (const chunk of response.deltaStream) {
      chunks.push(chunk.deltaText);
    }
    expect(chunks).toEqual(["Hello ", "world"]);
    const final = await response.finalize();
    expect(final.message.content).toBe("Hello world");
    expect(final.toolCalls).toEqual([]);
    expect(final.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
  });

  it("streams thinking_delta as kind:'reasoning' and finalizes with reasoningContent + signature", async () => {
    process.env.TEST_ANTHROPIC_KEY = "key";
    const sseEvents = [
      { event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 3 } } } },
      { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } },
      { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "let me " } } },
      { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "think" } } },
      { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-abc" } } },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
      { event: "content_block_start", data: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } } },
      { event: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Answer" } } },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
      { event: "message_delta", data: { type: "message_delta", usage: { output_tokens: 5 } } }
    ];
    const fetchImpl = async () => ({ ok: true, status: 200, body: buildSseStream(sseEvents) });
    const response = await runAnthropicProvider({
      provider: { baseUrl: "https://api.anthropic.com", apiKeyEnv: "TEST_ANTHROPIC_KEY", reasoningEffort: "medium" },
      model: "claude-sonnet-test",
      prompt: "hi",
      fetchImpl
    });

    const reasoning = [];
    const visible = [];
    for await (const chunk of response.deltaStream) {
      if (chunk.kind === "reasoning") reasoning.push(chunk.deltaText);
      else visible.push(chunk.deltaText);
    }
    expect(reasoning).toEqual(["let me ", "think"]);
    expect(visible).toEqual(["Answer"]);
    const final = await response.finalize();
    expect(final.message.content).toBe("Answer");
    expect(final.reasoningContent).toBe("let me think");
    expect(final.reasoningSignature).toBe("sig-abc");
  });

  it("enables extended thinking + grows max_tokens above the budget when reasoningEffort is set", async () => {
    process.env.TEST_ANTHROPIC_KEY = "key";
    let capturedBody = null;
    const fetchImpl = async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return { ok: true, status: 200, body: buildSseStream([
        { event: "message_start", data: { type: "message_start", message: { usage: {} } } },
        { event: "message_delta", data: { type: "message_delta", usage: {} } }
      ]) };
    };
    await runAnthropicProvider({
      provider: { baseUrl: "https://api.anthropic.com", apiKeyEnv: "TEST_ANTHROPIC_KEY", reasoningEffort: "medium", maxTokens: 2048 },
      model: "claude-sonnet-test",
      prompt: "hi",
      fetchImpl
    });
    // medium → budget 8192; max_tokens must exceed it.
    expect(capturedBody.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
    expect(capturedBody.max_tokens).toBeGreaterThan(8192);
  });

  it("omits thinking when reasoningEffort is unset", async () => {
    process.env.TEST_ANTHROPIC_KEY = "key";
    let capturedBody = null;
    const fetchImpl = async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return { ok: true, status: 200, body: buildSseStream([
        { event: "message_start", data: { type: "message_start", message: { usage: {} } } },
        { event: "message_delta", data: { type: "message_delta", usage: {} } }
      ]) };
    };
    await runAnthropicProvider({
      provider: { baseUrl: "https://api.anthropic.com", apiKeyEnv: "TEST_ANTHROPIC_KEY" },
      model: "claude-sonnet-test",
      prompt: "hi",
      fetchImpl
    });
    expect(capturedBody.thinking).toBeUndefined();
    expect(capturedBody.max_tokens).toBe(2048);
  });

  it("aggregates streamed tool_use blocks back into toolCalls", async () => {
    process.env.TEST_ANTHROPIC_KEY = "key";
    const sseEvents = [
      { event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 1 } } } },
      { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "read_file", input: {} } } },
      { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"filePath\":" } } },
      { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "\"README.md\"}" } } },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
      { event: "message_delta", data: { type: "message_delta", usage: { output_tokens: 1 } } }
    ];
    const fetchImpl = async () => ({ ok: true, status: 200, body: buildSseStream(sseEvents) });
    const response = await runAnthropicProvider({
      provider: { baseUrl: "https://api.anthropic.com", apiKeyEnv: "TEST_ANTHROPIC_KEY" },
      model: "claude-sonnet-test",
      prompt: "inspect",
      fetchImpl
    });
    for await (const _chunk of response.deltaStream) { void _chunk; }
    const final = await response.finalize();
    expect(final.toolCalls).toEqual([{ id: "toolu_1", name: "read_file", args: { filePath: "README.md" } }]);
    expect(final.usage).toEqual({ inputTokens: 1, outputTokens: 1 });
  });
});
