import { describe, expect, it } from "vitest";
import {
  compactMessages,
  estimateTokens,
  getCompactStatus,
  resolveTailStart,
  shouldAutoCompact
} from "../src/session/compactor.mjs";

describe("session compactor", () => {
  it("summarizes old messages while preserving the first system message and recent tail", () => {
    const messages = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "Please edit ai-agent/src/cli.mjs" },
      { role: "assistant", content: null, tool_calls: [{ function: { name: "read_file" } }] },
      { role: "tool", content: JSON.stringify({ path: "ai-agent/src/cli.mjs", content: "..." }) },
      { role: "assistant", content: "I inspected it." },
      { role: "user", content: "Continue" }
    ];

    const result = compactMessages({
      messages,
      keepLastMessages: 2,
      now: new Date("2026-05-03T00:00:00.000Z")
    });

    expect(result.compacted).toBe(true);
    expect(result.messages).toHaveLength(4);
    expect(result.messages[0]).toEqual(messages[0]);
    expect(result.messages[1]).toEqual(expect.objectContaining({
      role: "system",
      compacted: true
    }));
    expect(result.messages[1].content).toContain("ai-agent/src/cli.mjs");
    expect(result.messages.at(-1)).toEqual(messages.at(-1));
  });

  it("rejects the removed drop-tool-results strategy (now the dropToolResults toggle)", () => {
    expect(() => compactMessages({
      strategy: "drop-tool-results",
      keepLastMessages: 1,
      messages: [{ role: "user", content: "x" }, { role: "assistant", content: "y" }]
    })).toThrow(/Unknown compact strategy/);
  });

  it("keeps verbose tool output out of the summary when dropToolResults is set", () => {
    const messages = [
      { role: "user", content: "inspect token.mjs" },
      { role: "assistant", content: null, tool_calls: [{ function: { name: "read_file" } }] },
      { role: "tool", content: "TOOLBODYNEEDLE huge dump of file contents" },
      { role: "assistant", content: "done" }
    ];

    const withDrop = compactMessages({
      strategy: "summarize-context",
      keepLastMessages: 1,
      dropToolResults: true,
      messages,
      now: new Date("2026-05-03T00:00:00.000Z")
    });
    const summary = withDrop.messages.find((m) => m.compacted === true);
    expect(withDrop.compacted).toBe(true);
    expect(summary.content).not.toContain("TOOLBODYNEEDLE");
    // The tool *call name* is still recoverable from the assistant message.
    expect(summary.content).toContain("read_file");

    // Without the toggle, the tool body feeds the summary as before.
    const without = compactMessages({
      strategy: "summarize-context",
      keepLastMessages: 1,
      messages,
      now: new Date("2026-05-03T00:00:00.000Z")
    });
    const summary2 = without.messages.find((m) => m.compacted === true);
    expect(summary2.content).toContain("TOOLBODYNEEDLE");
  });

  it("collapses a tool-only region to nothing when dropToolResults is set", () => {
    const result = compactMessages({
      strategy: "summarize-context",
      keepLastMessages: 1,
      dropToolResults: true,
      messages: [
        { role: "system", content: "system" },
        { role: "tool", content: "tool a" },
        { role: "tool", content: "tool b" },
        { role: "assistant", content: "done" }
      ],
      now: new Date("2026-05-03T00:00:00.000Z")
    });
    // The compactable region is two tool messages; with tools dropped there is
    // nothing to summarize, so the region is removed without minting a summary.
    expect(result.compacted).toBe(true);
    expect(result.messages.some((m) => m.compacted === true)).toBe(false);
    expect(result.messages).toEqual([
      { role: "system", content: "system" },
      { role: "assistant", content: "done" }
    ]);
  });

  it("accepts the llm-summary strategy as a valid identifier (Phase 7)", () => {
    const result = compactMessages({
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
        { role: "user", content: "Continue" }
      ],
      strategy: "llm-summary",
      keepLastMessages: 1,
      now: new Date("2026-05-06T00:00:00.000Z")
    });
    expect(result.compacted).toBe(true);
  });

  // Regression: a keep-last boundary that fell between an assistant tool_use
  // and its tool_result left the orphaned result in the kept tail. On the next
  // turn the provider sent a function_call_output with no preceding
  // function_call and the Responses API rejected it with 400 "No tool call
  // found for function call output with call_id <id>".
  describe("keeps tool_use/tool_result pairs across the keep-last boundary", () => {
    const convo = [
      { role: "system", content: "system" },
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_a", function: { name: "read_file" } }] },
      { role: "tool", tool_call_id: "call_a", content: "A" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_b", function: { name: "Grep" } }] },
      { role: "tool", tool_call_id: "call_b", content: "B" },
      { role: "assistant", content: "done" }
    ];

    it("resolveTailStart walks the boundary back off a leading tool result", () => {
      // length - keepLast = 7 - 4 = 3 points at the tool result for call_a,
      // whose assistant tool_use is at index 2 — back up to keep the pair.
      expect(resolveTailStart(convo, 4, 1)).toBe(2);
      // Boundaries already on a non-tool message are left untouched.
      expect(resolveTailStart(convo, 3, 1)).toBe(4);
      expect(resolveTailStart(convo, 5, 1)).toBe(2);
      // The leading system message (bodyStart) is the floor.
      expect(resolveTailStart(convo, 99, 1)).toBe(1);
    });

    it("compactMessages never leaves a tool result without its tool_use", () => {
      const result = compactMessages({
        messages: convo,
        strategy: "summarize-context",
        keepLastMessages: 4,
        now: new Date("2026-05-24T00:00:00.000Z")
      });
      expect(result.compacted).toBe(true);
      const callIds = new Set();
      for (const message of result.messages) {
        for (const toolCall of message.tool_calls ?? []) {
          if (toolCall.id) callIds.add(toolCall.id);
        }
      }
      for (const message of result.messages) {
        if (message.role === "tool") {
          expect(callIds.has(message.tool_call_id)).toBe(true);
        }
      }
    });
  });

  it("reports auto compact status using message and token thresholds", () => {
    const messages = [
      { role: "user", content: "a".repeat(100) },
      { role: "assistant", content: "b".repeat(100) }
    ];
    const settings = {
      session: {
        autoCompact: {
          enabled: true,
          messageCount: 99,
          estimatedTokens: 10,
          keepLastMessages: 1,
          strategy: "summarize-context"
        }
      }
    };

    expect(estimateTokens(messages)).toBeGreaterThan(10);
    expect(shouldAutoCompact({ messages, settings })).toBe(true);
    expect(getCompactStatus({ messages, settings })).toEqual(expect.objectContaining({
      enabled: true,
      shouldCompact: true,
      keepLastMessages: 1
    }));
  });
});
