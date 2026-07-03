import { describe, expect, it, vi } from "vitest";

vi.mock("../src/auth/refresh-guard.mjs", () => ({
  getValidCredentials: vi.fn(async () => ({
    access: "stub", refresh: "stub", expires: Date.now() + 3_600_000, accountId: "acct"
  }))
}));

const { toAnthropicMessages } = await import("../src/providers/format/anthropic.mjs");
const { toOpenAiMessages } = await import("../src/providers/format/openai.mjs");
const { runOpenAiCodexProvider } = await import("../src/providers/openai-codex.mjs");
const { createMessage } = await import("../src/core/types/message.mjs");

const IMG = { kind: "image", mime: "image/png", dataBase64: "AAA" };
const DATA_URL = "data:image/png;base64,AAA";

function userWithImage(sessionId = "s") {
  return createMessage({ role: "user", sessionId, content: [{ kind: "text", text: "look" }, IMG] });
}

function toolWithImage(sessionId = "s") {
  return createMessage({
    role: "tool",
    sessionId,
    toolCallId: "t1",
    content: [
      { kind: "tool_result", toolCallId: "t1", ok: true, result: { kind: "view_image", summary: "shown", data: { path: "/ws/a.png" } } },
      IMG
    ]
  });
}

// The assistant turn that issued the t1 tool call. Real transcripts always
// pair a tool_result with its originating tool_use; the OpenAI and Anthropic
// adapters drop orphan tool outputs (a corrupted-compaction guard), so
// fixtures that exercise tool messages must include the call that produced
// them.
function assistantCallingT1(sessionId = "s") {
  return createMessage({
    role: "assistant",
    sessionId,
    content: [{ kind: "tool_use", toolCallId: "t1", name: "view_image", args: {} }]
  });
}

describe("anthropic image input", () => {
  it("emits a content-block array with an image source on a user turn", () => {
    const { anthropicMessages } = toAnthropicMessages([userWithImage()]);
    expect(anthropicMessages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }
      ]
    });
  });

  it("inlines tool images inside tool_result.content", () => {
    const { anthropicMessages } = toAnthropicMessages([assistantCallingT1(), toolWithImage()]);
    const block = anthropicMessages[1].content[0];
    expect(block.type).toBe("tool_result");
    expect(block.tool_use_id).toBe("t1");
    expect(Array.isArray(block.content)).toBe(true);
    expect(block.content[0].type).toBe("text");
    expect(block.content[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } });
  });

  it("keeps a plain string for text-only user turns (back-compat)", () => {
    const { anthropicMessages } = toAnthropicMessages([
      createMessage({ role: "user", sessionId: "s", content: [{ kind: "text", text: "hi" }] })
    ]);
    expect(anthropicMessages[0]).toEqual({ role: "user", content: "hi" });
  });
});

describe("openai (chat completions) image input", () => {
  it("emits image_url parts on a user turn", () => {
    const out = toOpenAiMessages([userWithImage()]);
    expect(out[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: DATA_URL } }
      ]
    });
  });

  it("expands a tool message with images into tool + follow-up user message", () => {
    const out = toOpenAiMessages([assistantCallingT1(), toolWithImage()]);
    expect(out).toHaveLength(3);
    expect(out[0].role).toBe("assistant");
    expect(out[1].role).toBe("tool");
    expect(out[1].tool_call_id).toBe("t1");
    expect(out[2].role).toBe("user");
    expect(out[2].content).toContainEqual({ type: "image_url", image_url: { url: DATA_URL } });
  });
});

describe("openai-codex (responses api) image input", () => {
  async function captureBody({ messages }) {
    const fetchImpl = vi.fn(async () => ({
      ok: true, status: 200, statusText: "OK",
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{"usage":{}}}\n\n'));
          c.close();
        }
      })
    }));
    await runOpenAiCodexProvider({
      provider: { type: "openai-codex", authProfile: "codex", defaultModel: "gpt-test" },
      messages,
      fetchImpl,
      stream: false
    });
    return JSON.parse(fetchImpl.mock.calls[0][1].body);
  }

  it("emits an input_image part on a user turn", async () => {
    const body = await captureBody({ messages: [userWithImage()] });
    const userItem = body.input.find((i) => i.role === "user");
    expect(userItem.content).toContainEqual({ type: "input_text", text: "look" });
    expect(userItem.content).toContainEqual({ type: "input_image", image_url: DATA_URL });
  });

  it("delivers tool images as a follow-up user item after function_call_output", async () => {
    const body = await captureBody({ messages: [assistantCallingT1(), toolWithImage()] });
    const outIdx = body.input.findIndex((i) => i.type === "function_call_output");
    expect(outIdx).toBeGreaterThanOrEqual(0);
    const follow = body.input[outIdx + 1];
    expect(follow.role).toBe("user");
    expect(follow.content).toContainEqual({ type: "input_image", image_url: DATA_URL });
  });
});
