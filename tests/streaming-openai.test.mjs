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
});
