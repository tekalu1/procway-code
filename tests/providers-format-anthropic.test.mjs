import { describe, expect, it } from "vitest";
import {
  applyPromptCacheBreakpoints,
  fromAnthropicContent,
  toAnthropicMessages,
  toAnthropicTools
} from "../src/providers/format/anthropic.mjs";
import { createMessage } from "../src/core/types/message.mjs";

describe("providers/format/anthropic", () => {
  it("splits the system prompt and translates Message[] into Anthropic messages", () => {
    const sessionId = "s-1";
    const messages = [
      createMessage({ role: "system", sessionId, content: [{ kind: "text", text: "system rules" }] }),
      createMessage({ role: "user", sessionId, content: [{ kind: "text", text: "hi" }] }),
      createMessage({
        role: "assistant",
        sessionId,
        content: [{ kind: "tool_use", toolCallId: "tu-1", name: "read_file", args: { filePath: "x" } }]
      }),
      createMessage({
        role: "tool",
        sessionId,
        toolCallId: "tu-1",
        content: [{
          kind: "tool_result",
          toolCallId: "tu-1",
          ok: true,
          result: { kind: "read_file", summary: "Read x", data: { path: "x" } }
        }]
      })
    ];

    const { system, anthropicMessages } = toAnthropicMessages(messages);
    expect(system).toBe("system rules");
    expect(anthropicMessages).toHaveLength(3);
    expect(anthropicMessages[0]).toEqual({ role: "user", content: "hi" });
    expect(anthropicMessages[1]).toEqual({
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "tu-1",
        name: "read_file",
        input: { filePath: "x" }
      }]
    });
    expect(anthropicMessages[2]).toEqual({
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "tu-1",
        content: JSON.stringify({ kind: "read_file", summary: "Read x", data: { path: "x" } })
      }]
    });
  });

  it("accepts legacy raw messages with string content", () => {
    const { system, anthropicMessages } = toAnthropicMessages([
      { role: "system", content: "system" },
      { role: "user", content: "hi" }
    ]);
    expect(system).toBe("system");
    expect(anthropicMessages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("synthesizes a placeholder tool_result for an unanswered tool_use", () => {
    // Mid-tool crash salvage (same as format/openai.mjs): the session died
    // between assistant.message.completed and tool.call.completed, so resume
    // rebuilt the history with the tool_use unanswered. The Messages API
    // rejects that with 400 "tool_use ids were found without tool_result
    // blocks immediately after".
    const sessionId = "s-unanswered";
    const { anthropicMessages } = toAnthropicMessages([
      createMessage({
        role: "assistant",
        sessionId,
        content: [{ kind: "tool_use", toolCallId: "tu-lost", name: "run_shell", args: { command: "x" } }]
      }),
      createMessage({ role: "user", sessionId, content: [{ kind: "text", text: "続きをお願いします" }] })
    ]);
    expect(anthropicMessages.map((m) => m.role)).toEqual(["assistant", "user", "user"]);
    const placeholder = anthropicMessages[1].content[0];
    expect(placeholder.type).toBe("tool_result");
    expect(placeholder.tool_use_id).toBe("tu-lost");
    expect(placeholder.is_error).toBe(true);
    const payload = JSON.parse(placeholder.content);
    expect(payload.synthesized).toBe(true);
    expect(payload.tool).toBe("run_shell");
  });

  it("fills only the unanswered tool_use of a partially answered round", () => {
    const sessionId = "s-partial";
    const { anthropicMessages } = toAnthropicMessages([
      createMessage({
        role: "assistant",
        sessionId,
        content: [
          { kind: "tool_use", toolCallId: "tu-a", name: "read_file", args: {} },
          { kind: "tool_use", toolCallId: "tu-b", name: "read_file", args: {} }
        ]
      }),
      createMessage({
        role: "tool",
        sessionId,
        toolCallId: "tu-a",
        content: [{ kind: "tool_result", toolCallId: "tu-a", ok: true, result: "done" }]
      })
    ]);
    expect(anthropicMessages.map((m) => m.role)).toEqual(["assistant", "user", "user"]);
    const resultIds = anthropicMessages.slice(1).map((m) => m.content[0].tool_use_id).sort();
    expect(resultIds).toEqual(["tu-a", "tu-b"]);
    // The real result must survive untouched.
    const real = anthropicMessages.slice(1).find((m) => m.content[0].tool_use_id === "tu-a");
    expect(real.content[0].content).toBe(JSON.stringify("done"));
    expect(real.content[0].is_error).toBeUndefined();
  });

  it("treats a tool_result that precedes its tool_use as an orphan and re-fills the call", () => {
    // Same disorder salvage as format/openai.mjs: resume projects event-log
    // file order, which (before append serialization) could put the result
    // before its call. The early result is dropped; the call gets a
    // synthesized placeholder right after it.
    const sessionId = "s-early-result";
    const { anthropicMessages } = toAnthropicMessages([
      createMessage({
        role: "tool",
        sessionId,
        toolCallId: "tu-early",
        content: [{ kind: "tool_result", toolCallId: "tu-early", ok: true, result: "real" }]
      }),
      createMessage({
        role: "assistant",
        sessionId,
        content: [{ kind: "tool_use", toolCallId: "tu-early", name: "shell_job", args: {} }]
      })
    ]);
    expect(anthropicMessages.map((m) => m.role)).toEqual(["assistant", "user"]);
    const placeholder = anthropicMessages[1].content[0];
    expect(placeholder.tool_use_id).toBe("tu-early");
    expect(placeholder.is_error).toBe(true);
    expect(JSON.parse(placeholder.content).synthesized).toBe(true);
  });

  it("drops an orphan tool_result whose tool_use_id has no assistant tool_use", () => {
    // Compaction-failure salvage: the assistant tool_use was folded into the
    // summary while its tool_result survived. The Messages API rejects an
    // unexpected tool_use_id, so the orphan message must be filtered out.
    const sessionId = "s-orphan";
    const { anthropicMessages } = toAnthropicMessages([
      createMessage({ role: "system", sessionId, content: [{ kind: "text", text: "summary" }] }),
      createMessage({
        role: "tool",
        sessionId,
        toolCallId: "tu-orphan",
        content: [{ kind: "tool_result", toolCallId: "tu-orphan", ok: true, result: "stale" }]
      }),
      createMessage({ role: "user", sessionId, content: [{ kind: "text", text: "hi" }] })
    ]);
    expect(anthropicMessages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("parses Anthropic content blocks into text + tool calls", () => {
    expect(fromAnthropicContent([{ type: "text", text: "hello" }])).toEqual({
      text: "hello",
      toolCalls: []
    });

    expect(fromAnthropicContent([{
      type: "tool_use",
      id: "toolu_1",
      name: "read_file",
      input: { filePath: "README.md" }
    }])).toEqual({
      text: "",
      toolCalls: [{ id: "toolu_1", name: "read_file", args: { filePath: "README.md" } }]
    });
  });

  it("re-attaches the thinking block (with signature) ahead of tool_use when persisted on meta", () => {
    const sessionId = "s-think";
    const messages = [
      createMessage({
        role: "assistant",
        sessionId,
        content: [{ kind: "tool_use", toolCallId: "tu-9", name: "read_file", args: { filePath: "y" } }],
        meta: { reasoningContent: "I should read y first.", reasoningSignature: "sig-xyz" }
      })
    ];
    const { anthropicMessages } = toAnthropicMessages(messages);
    expect(anthropicMessages[0]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "I should read y first.", signature: "sig-xyz" },
        { type: "tool_use", id: "tu-9", name: "read_file", input: { filePath: "y" } }
      ]
    });
  });

  it("omits the thinking block when the signature is missing (would be rejected by the API)", () => {
    const sessionId = "s-think2";
    const messages = [
      createMessage({
        role: "assistant",
        sessionId,
        content: [{ kind: "tool_use", toolCallId: "tu-10", name: "read_file", args: {} }],
        meta: { reasoningContent: "thinking without signature" }
      })
    ];
    const { anthropicMessages } = toAnthropicMessages(messages);
    expect(anthropicMessages[0].content).toEqual([
      { type: "tool_use", id: "tu-10", name: "read_file", input: {} }
    ]);
  });

  it("converts internal tool definitions to Anthropic schema with a cache breakpoint on the last tool", () => {
    const defs = [
      { type: "function", function: { name: "list_files", description: "list", parameters: { type: "object" } } },
      { type: "function", function: { name: "read_file", description: "read", parameters: { type: "object" } } }
    ];
    expect(toAnthropicTools(defs)).toEqual([
      { name: "list_files", description: "list", input_schema: { type: "object" } },
      { name: "read_file", description: "read", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } }
    ]);
    // opt-out keeps the legacy shape
    expect(toAnthropicTools(defs, { cacheControl: false })).toEqual([
      { name: "list_files", description: "list", input_schema: { type: "object" } },
      { name: "read_file", description: "read", input_schema: { type: "object" } }
    ]);
  });

  it("applyPromptCacheBreakpoints marks the first user message and the last message", () => {
    const anthropicMessages = [
      { role: "user", content: "big stable worker prompt" },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "result" }] }
    ];
    const out = applyPromptCacheBreakpoints(anthropicMessages);
    // string content converted to blocks so cache_control can attach
    expect(out[0].content).toEqual([
      { type: "text", text: "big stable worker prompt", cache_control: { type: "ephemeral" } }
    ]);
    // middle message untouched
    expect(out[1].content[0].cache_control).toBeUndefined();
    // rolling breakpoint on the last message's last block
    expect(out[2].content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("applyPromptCacheBreakpoints never attaches to thinking blocks", () => {
    const anthropicMessages = [
      { role: "user", content: "prompt" },
      { role: "assistant", content: [{ type: "thinking", thinking: "...", signature: "sig" }] }
    ];
    const out = applyPromptCacheBreakpoints(anthropicMessages);
    expect(out[1].content[0].cache_control).toBeUndefined();
  });
});
