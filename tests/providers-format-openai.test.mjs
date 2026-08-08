import { describe, expect, it } from "vitest";
import {
  fromOpenAiToolCall,
  normalizeOpenAiContent,
  normalizeOpenAiToolCalls,
  toOpenAiMessages
} from "../src/providers/format/openai.mjs";
import { createMessage } from "../src/core/types/message.mjs";
import { makeInvalidToolArgs } from "../src/providers/format/tool-args.mjs";

describe("providers/format/openai", () => {
  it("item B: never re-sends an invalid-args marker as tool_calls.arguments (strips it to {})", () => {
    const sessionId = "s-marker";
    const out = toOpenAiMessages([
      createMessage({
        role: "assistant",
        sessionId,
        content: [{ kind: "tool_use", toolCallId: "call-m", name: "write_file", args: makeInvalidToolArgs({ truncated: true }) }]
      }),
      createMessage({ role: "user", sessionId, content: [{ kind: "text", text: "continue" }] })
    ]);
    const assistant = out.find((m) => m.role === "assistant");
    expect(assistant.tool_calls[0].function.arguments).toBe("{}");
    expect(JSON.stringify(out)).not.toContain("__procwayInvalidToolArgs");
  });
  it("converts internal Message[] into OpenAI request shape", () => {
    const sessionId = "s-1";
    const messages = [
      createMessage({ role: "system", sessionId, content: [{ kind: "text", text: "system prompt" }] }),
      createMessage({ role: "user", sessionId, content: [{ kind: "text", text: "hello" }] }),
      createMessage({
        role: "assistant",
        sessionId,
        content: [{ kind: "tool_use", toolCallId: "call-1", name: "read_file", args: { filePath: "x" } }]
      }),
      createMessage({
        role: "tool",
        sessionId,
        toolCallId: "call-1",
        content: [{
          kind: "tool_result",
          toolCallId: "call-1",
          ok: true,
          result: { kind: "read_file", summary: "Read x", data: { path: "x", content: "abc" } }
        }]
      })
    ];

    const out = toOpenAiMessages(messages);
    expect(out).toHaveLength(4);
    expect(out[0]).toEqual({ role: "system", content: "system prompt" });
    expect(out[1]).toEqual({ role: "user", content: "hello" });
    expect(out[2]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call-1",
        type: "function",
        function: { name: "read_file", arguments: JSON.stringify({ filePath: "x" }) }
      }]
    });
    expect(out[3]).toEqual({
      role: "tool",
      tool_call_id: "call-1",
      content: JSON.stringify({ kind: "read_file", summary: "Read x", data: { path: "x", content: "abc" } })
    });
  });

  it("drops an orphan tool message whose tool_call_id has no assistant tool_call", () => {
    // Compaction-failure salvage: the assistant tool_use for call-orphan was
    // folded into the summary while its tool_result survived. The Chat
    // Completions API rejects a tool message with no preceding tool_calls, so
    // the orphan must be filtered out while the intact call-real pair stays.
    const sessionId = "s-orphan";
    const out = toOpenAiMessages([
      createMessage({ role: "system", sessionId, content: [{ kind: "text", text: "summary" }] }),
      createMessage({
        role: "tool",
        sessionId,
        toolCallId: "call-orphan",
        content: [{ kind: "tool_result", toolCallId: "call-orphan", ok: true, result: "stale" }]
      }),
      createMessage({
        role: "assistant",
        sessionId,
        content: [{ kind: "tool_use", toolCallId: "call-real", name: "read_file", args: {} }]
      }),
      createMessage({
        role: "tool",
        sessionId,
        toolCallId: "call-real",
        content: [{ kind: "tool_result", toolCallId: "call-real", ok: true, result: "hit" }]
      })
    ]);
    expect(out.map((m) => m.role)).toEqual(["system", "assistant", "tool"]);
    expect(out.some((m) => m.tool_call_id === "call-orphan")).toBe(false);
    expect(out.at(-1).tool_call_id).toBe("call-real");
  });

  it("synthesizes a placeholder reply for an unanswered assistant tool_call", () => {
    // Mid-tool crash salvage: the session died between
    // assistant.message.completed (tool_use durably event-logged) and
    // tool.call.completed, so resume rebuilt the history with the call
    // unanswered. Without the repair the upstream rejects every subsequent
    // request with 400 "An assistant message with 'tool_calls' must be
    // followed by tool messages responding to each 'tool_call_id'".
    const sessionId = "s-unanswered";
    const out = toOpenAiMessages([
      createMessage({ role: "system", sessionId, content: [{ kind: "text", text: "system prompt" }] }),
      createMessage({
        role: "assistant",
        sessionId,
        content: [{ kind: "tool_use", toolCallId: "call-lost", name: "shell_job", args: { action: "wait" } }]
      }),
      createMessage({ role: "user", sessionId, content: [{ kind: "text", text: "続きをお願いします" }] })
    ]);
    expect(out.map((m) => m.role)).toEqual(["system", "assistant", "tool", "user"]);
    expect(out[2].tool_call_id).toBe("call-lost");
    const payload = JSON.parse(out[2].content);
    expect(payload.synthesized).toBe(true);
    expect(payload.tool).toBe("shell_job");
    expect(payload.error).toMatch(/interrupted/);
  });

  it("drops a degenerate empty assistant turn (no content, no tool_calls) so DeepSeek doesn't 400", () => {
    // A weak model on a read-only turn can return an empty round — no text and
    // no tool_calls. Serialized that becomes { role: 'assistant', content: null },
    // which DeepSeek-direct rejects with 400 "Invalid assistant message:
    // content or tool_calls must be set". It carries zero info, so drop it.
    const sessionId = "s-empty";
    const out = toOpenAiMessages([
      createMessage({ role: "system", sessionId, content: [{ kind: "text", text: "system prompt" }] }),
      createMessage({ role: "user", sessionId, content: [{ kind: "text", text: "設計して" }] }),
      createMessage({ role: "assistant", sessionId, content: [] }),
      createMessage({ role: "user", sessionId, content: [{ kind: "text", text: "もう一度" }] })
    ]);
    expect(out.map((m) => m.role)).toEqual(["system", "user", "user"]);
  });

  it("keeps an assistant turn that still has visible text", () => {
    const sessionId = "s-text";
    const out = toOpenAiMessages([
      createMessage({ role: "assistant", sessionId, content: [{ kind: "text", text: "了解しました" }] })
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("了解しました");
  });

  it("fills only the unanswered calls of a partially answered round", () => {
    // 3-call round where only call-a completed before the crash: the
    // placeholder must cover call-b/call-c and all tool replies must stay
    // contiguous right after the assistant message.
    const sessionId = "s-partial";
    const out = toOpenAiMessages([
      createMessage({
        role: "assistant",
        sessionId,
        content: [
          { kind: "tool_use", toolCallId: "call-a", name: "read_file", args: {} },
          { kind: "tool_use", toolCallId: "call-b", name: "read_file", args: {} },
          { kind: "tool_use", toolCallId: "call-c", name: "run_shell", args: {} }
        ]
      }),
      createMessage({
        role: "tool",
        sessionId,
        toolCallId: "call-a",
        content: [{ kind: "tool_result", toolCallId: "call-a", ok: true, result: "done" }]
      })
    ]);
    expect(out.map((m) => m.role)).toEqual(["assistant", "tool", "tool", "tool"]);
    expect(out.slice(1).map((m) => m.tool_call_id).sort()).toEqual(["call-a", "call-b", "call-c"]);
    // The real reply must survive untouched.
    const real = out.find((m) => m.tool_call_id === "call-a");
    expect(real.content).toBe(JSON.stringify("done"));
    const synthesized = out.find((m) => m.tool_call_id === "call-b");
    expect(JSON.parse(synthesized.content).synthesized).toBe(true);
  });

  it("treats a reply that precedes its call as an orphan and re-fills the call", () => {
    // Event-log appends used to be unserialized: near-simultaneous events
    // could land on disk reversed, and resume projects file order — putting
    // the tool reply BEFORE its tool_calls message. The API rejects that
    // ordering, so the early reply must be dropped and the call re-filled
    // with a synthesized placeholder right after it.
    const sessionId = "s-early-reply";
    const out = toOpenAiMessages([
      createMessage({
        role: "tool",
        sessionId,
        toolCallId: "call-early",
        content: [{ kind: "tool_result", toolCallId: "call-early", ok: true, result: "real" }]
      }),
      createMessage({
        role: "assistant",
        sessionId,
        content: [{ kind: "tool_use", toolCallId: "call-early", name: "shell_job", args: {} }]
      })
    ]);
    expect(out.map((m) => m.role)).toEqual(["assistant", "tool"]);
    expect(out[1].tool_call_id).toBe("call-early");
    expect(JSON.parse(out[1].content).synthesized).toBe(true);
  });

  it("accepts legacy raw messages with string content", () => {
    const out = toOpenAiMessages([
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" }
    ]);
    expect(out).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" }
    ]);
  });

  it("normalizes a single OpenAI tool call", () => {
    expect(fromOpenAiToolCall({
      id: "call-1",
      type: "function",
      function: { name: "list_files", arguments: "{\"dirPath\":\".\"}" }
    })).toEqual({ id: "call-1", name: "list_files", args: { dirPath: "." } });
  });

  it("rejects malformed tool calls", () => {
    expect(fromOpenAiToolCall(null)).toBeNull();
    expect(fromOpenAiToolCall({ id: "x" })).toBeNull();
  });

  it("treats empty-string / missing arguments as {} (no-arg call), not invalid", () => {
    // Regression: "" fell through `?? \"{}\"` and JSON.parse(\"\") threw, so a
    // no-arg tool call was wrongly flagged invalid.
    expect(fromOpenAiToolCall({ id: "e", function: { name: "list_files", arguments: "" } }))
      .toEqual({ id: "e", name: "list_files", args: {} });
    expect(fromOpenAiToolCall({ id: "m", function: { name: "list_files" } }))
      .toEqual({ id: "m", name: "list_files", args: {} });
  });

  it("normalizes a list of tool calls, marking unparseable args instead of swallowing them", () => {
    const list = normalizeOpenAiToolCalls([
      { id: "a", function: { name: "list_files", arguments: "{}" } },
      { id: "b", function: { name: "read_file", arguments: "not-json" } },
      null
    ]);
    expect(list).toEqual([
      { id: "a", name: "list_files", args: {} },
      { id: "b", name: "read_file", args: { __procwayInvalidToolArgs: { reason: "parse_error", truncated: false } } }
    ]);
  });

  it("flags unparseable args as truncated when the response finished on length", () => {
    const call = fromOpenAiToolCall(
      { id: "c", function: { name: "write_file", arguments: "{\"filePath\":\"a.txt\",\"conte" } },
      { truncated: true }
    );
    expect(call).toEqual({
      id: "c",
      name: "write_file",
      args: { __procwayInvalidToolArgs: { reason: "parse_error", truncated: true } }
    });
  });

  it("normalizes assorted assistant content shapes into text", () => {
    expect(normalizeOpenAiContent("plain")).toBe("plain");
    expect(normalizeOpenAiContent([{ text: "a" }, { content: "b" }])).toBe("ab");
    expect(normalizeOpenAiContent(null, { reasoning: "r" })).toBe("r");
    expect(normalizeOpenAiContent(null, { refusal: "no" })).toBe("no");
    expect(normalizeOpenAiContent(null, {})).toBe("");
  });

  describe("reasoning_content echo", () => {
    const reasoningAssistant = createMessage({
      role: "assistant",
      sessionId: "s",
      content: [{ kind: "text", text: "answer" }],
      meta: { reasoningContent: "let me think..." }
    });

    it("omits reasoning_content by default (Cerebras-compatible)", () => {
      const out = toOpenAiMessages([reasoningAssistant]);
      expect(out[0]).toEqual({ role: "assistant", content: "answer" });
      expect(out[0]).not.toHaveProperty("reasoning_content");
    });

    it("omits reasoning_content when echoReasoning is false", () => {
      const out = toOpenAiMessages([reasoningAssistant], { echoReasoning: false });
      expect(out[0]).not.toHaveProperty("reasoning_content");
    });

    it("includes reasoning_content when echoReasoning is true (DeepSeek thinking mode)", () => {
      const out = toOpenAiMessages([reasoningAssistant], { echoReasoning: true });
      expect(out[0]).toEqual({
        role: "assistant",
        content: "answer",
        reasoning_content: "let me think..."
      });
    });

    it("includes reasoning_content on tool-call assistant turns when opted in", () => {
      const toolCallAssistant = createMessage({
        role: "assistant",
        sessionId: "s",
        content: [{ kind: "tool_use", toolCallId: "c1", name: "list_files", args: {} }],
        meta: { reasoningContent: "planning..." }
      });
      const out = toOpenAiMessages([toolCallAssistant], { echoReasoning: true });
      expect(out[0].reasoning_content).toBe("planning...");
    });

    it("serializes a reasoning-only assistant turn (no visible text) as content:null, not empty string", () => {
      // deepseek-v4-pro and similar reasoning models can emit a turn whose
      // visible text is empty (all output went to reasoning). The previous
      // serialization produced content:"" which some OpenAI-compatible
      // upstreams (OpenRouter routings) reject/mishandle in the NEXT turn's
      // history, stalling the follow-up request. It must be content:null,
      // mirroring the tool-call branch.
      const reasoningOnly = createMessage({
        role: "assistant",
        sessionId: "s",
        content: [],
        meta: { reasoningContent: "the user wants 2" }
      });
      const plain = toOpenAiMessages([reasoningOnly]);
      expect(plain[0]).toMatchObject({ role: "assistant", content: null });
      const echoed = toOpenAiMessages([reasoningOnly], { echoReasoning: true });
      expect(echoed[0]).toEqual({ role: "assistant", content: null, reasoning_content: "the user wants 2" });
    });
  });
});
