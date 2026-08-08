import { describe, expect, it } from "vitest";
import { runOpenAiCompatibleProvider } from "../src/providers/openai-compatible.mjs";

function buildSseStream(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    }
  });
}

describe("OpenAI streaming", () => {
  it("yields delta text chunks in order and finalizes with full content + usage", async () => {
    process.env.TEST_OPENAI_STREAM_KEY = "key";
    const chunks = [
      { choices: [{ delta: { role: "assistant", content: "Hello " } }] },
      { choices: [{ delta: { content: "world" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 2 } }
    ];
    const fetchImpl = async () => ({ ok: true, status: 200, body: buildSseStream(chunks) });
    const response = await runOpenAiCompatibleProvider({
      provider: { baseUrl: "https://api.openai.com/v1", apiKeyEnv: "TEST_OPENAI_STREAM_KEY" },
      model: "gpt-test",
      prompt: "hi",
      fetchImpl
    });
    const deltas = [];
    for await (const chunk of response.deltaStream) deltas.push(chunk.deltaText);
    const final = await response.finalize();
    expect(deltas).toEqual(["Hello ", "world"]);
    expect(final.message.content).toBe("Hello world");
    expect(final.toolCalls).toEqual([]);
    expect(final.usage).toEqual({ inputTokens: 7, outputTokens: 2 });
  });

  it("reassembles streamed tool_call deltas into a normalized toolCalls array", async () => {
    process.env.TEST_OPENAI_STREAM_KEY = "key";
    const chunks = [
      { choices: [{ delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "list_files", arguments: "" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"dir" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "Path\":\".\"}" } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 3, completion_tokens: 4 } }
    ];
    const fetchImpl = async () => ({ ok: true, status: 200, body: buildSseStream(chunks) });
    const response = await runOpenAiCompatibleProvider({
      provider: { baseUrl: "https://api.openai.com/v1", apiKeyEnv: "TEST_OPENAI_STREAM_KEY" },
      model: "gpt-test",
      prompt: "inspect",
      tools: [{ type: "function", function: { name: "list_files", parameters: { type: "object" } } }],
      fetchImpl
    });
    for await (const _chunk of response.deltaStream) { void _chunk; }
    const final = await response.finalize();
    expect(final.toolCalls).toEqual([{ id: "call_1", name: "list_files", args: { dirPath: "." } }]);
    expect(final.usage).toEqual({ inputTokens: 3, outputTokens: 4 });
  });

  it("treats a no-arg streamed tool call (arguments stays \"\") as {}, not invalid", async () => {
    process.env.TEST_OPENAI_STREAM_KEY = "key";
    // Regression: the aggregator seeds arguments to "" and a no-arg call never
    // appends — JSON.parse("") throws, so the pre-fix path flagged it invalid.
    const chunks = [
      { choices: [{ delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_noargs", type: "function", function: { name: "list_files", arguments: "" } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
    ];
    const response = await runOpenAiCompatibleProvider({
      provider: { baseUrl: "https://api.openai.com/v1", apiKeyEnv: "TEST_OPENAI_STREAM_KEY" },
      model: "gpt-test",
      prompt: "list",
      fetchImpl: async () => ({ ok: true, status: 200, body: buildSseStream(chunks) })
    });
    for await (const _chunk of response.deltaStream) { void _chunk; }
    const final = await response.finalize();
    expect(final.toolCalls).toEqual([{ id: "call_noargs", name: "list_files", args: {} }]);
  });

  it("flags a truncated streamed tool call (finish_reason \"length\") as invalid+truncated", async () => {
    process.env.TEST_OPENAI_STREAM_KEY = "key";
    // Fix 1 + Fix 2: the streaming aggregator must carry finish_reason through so
    // the cut-off tool arguments are marked truncated (not silently {}).
    const chunks = [
      { choices: [{ delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_cut", type: "function", function: { name: "write_file", arguments: "{\"filePath\":\"a.txt\",\"conte" } }] } }] },
      { choices: [{ delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 2, completion_tokens: 9 } }
    ];
    const response = await runOpenAiCompatibleProvider({
      provider: { baseUrl: "https://api.openai.com/v1", apiKeyEnv: "TEST_OPENAI_STREAM_KEY" },
      model: "gpt-test",
      prompt: "write",
      fetchImpl: async () => ({ ok: true, status: 200, body: buildSseStream(chunks) })
    });
    for await (const _chunk of response.deltaStream) { void _chunk; }
    const final = await response.finalize();
    expect(final.toolCalls).toEqual([
      { id: "call_cut", name: "write_file", args: { __procwayInvalidToolArgs: { reason: "parse_error", truncated: true } } }
    ]);
  });
});
