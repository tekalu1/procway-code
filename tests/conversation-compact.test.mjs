import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "../src/agent/conversation.mjs";

describe("AgentSession compact (non-destructive)", () => {
  it("compacts existing messages and emits compact.applied with removedMessageIds + snapshotId", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "procway-code-"));
    try {
      const session = await new AgentSession({
        settings: {
          defaultProvider: "test",
          defaultModel: "test-model",
          session: { enabled: true, autoCompact: { keepLastMessages: 2, strategy: "summarize-context" } },
          tools: {},
          agents: {}
        },
        cwd,
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "old request" },
          { role: "assistant", content: "old answer" },
          { role: "user", content: "recent request" },
          { role: "assistant", content: "recent answer" }
        ]
      }).initialize();

      const beforeIds = session.messages.map((message) => message.id);
      const expectedRemovedIds = [beforeIds[1], beforeIds[2]];
      const compactEvents = [];
      session.events.on("compact.applied", (event) => compactEvents.push(event));

      const result = await session.compact();

      expect(result.compacted).toBe(true);
      expect(session.messages).toHaveLength(4);
      expect(session.messages[0].role).toBe("system");
      expect(session.messages[1].role).toBe("system");
      expect(session.messages[1].compacted).toBe(true);
      expect(session.messages[1].content[0]).toEqual(expect.objectContaining({ kind: "text" }));
      expect(session.messages.at(-1).role).toBe("assistant");
      expect(session.messages.at(-1).content).toEqual([{ kind: "text", text: "recent answer" }]);
      expect(session.compactStatus()).toEqual(expect.objectContaining({ messageCount: 4 }));

      expect(compactEvents).toHaveLength(1);
      const event = compactEvents[0];
      expect(event).toEqual(expect.objectContaining({
        type: "compact.applied",
        sessionId: session.sessionId,
        strategy: "summarize-context"
      }));
      expect(event.removedMessageIds).toEqual(expect.arrayContaining(expectedRemovedIds));
      expect(event.removedMessageIds).toHaveLength(expectedRemovedIds.length);
      expect(typeof event.snapshotId).toBe("string");
      expect(event.snapshotId.length).toBeGreaterThan(0);
      expect(typeof event.summaryMessageId).toBe("string");
      expect(event.summaryMessageId).toBe(session.messages[1].id);
      // 方針A: the summary text rides on the event for the chat panel.
      expect(typeof event.summary).toBe("string");
      expect(event.summary).toContain("【コンパクトサマリー】");
      expect(event.removedMessages).toBe(1);
      // No fallback on the deterministic path.
      expect(event.llmFallback).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("default-wires the real provider for llm-summary, falling back with the provider error (not 'no-provider')", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "procway-code-"));
    try {
      const session = await new AgentSession({
        settings: {
          // No `providers` map, so the default-wired runProvider throws
          // "Provider not found: test". Regression guard: before the fix the
          // compact path defaulted runProviderImpl to null and the reason was
          // the bogus "no-provider" — i.e. the model was never even reached.
          defaultProvider: "test",
          defaultModel: "test-model",
          session: { enabled: true, autoCompact: { keepLastMessages: 2, strategy: "llm-summary" } },
          tools: {},
          agents: {}
        },
        cwd,
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "old request" },
          { role: "assistant", content: "old answer" },
          { role: "user", content: "recent request" },
          { role: "assistant", content: "recent answer" }
        ]
      }).initialize();

      const compactEvents = [];
      session.events.on("compact.applied", (event) => compactEvents.push(event));

      const result = await session.compact();

      expect(result.compacted).toBe(true);
      expect(result.llmFallback).toBe(true);
      expect(compactEvents).toHaveLength(1);
      expect(compactEvents[0]).toEqual(expect.objectContaining({
        strategy: "llm-summary",
        llmFallback: true,
        fallbackStrategy: "summarize-context"
      }));
      // The fallback reason is now the *provider* error, proving runProvider was
      // actually invoked rather than short-circuited as "no-provider".
      expect(compactEvents[0].fallbackReason).toMatch(/Provider not found/);
      expect(compactEvents[0].fallbackReason).not.toBe("no-provider");
      expect(typeof compactEvents[0].summary).toBe("string");

      // The fallback provenance is persisted on the summary message itself so
      // the resumed transcript (projected from messages) can label it.
      const summaryMessage = session.messages.find((m) => m.role === "system" && m.compacted === true);
      expect(summaryMessage.llmFallback).toBe(true);
      expect(summaryMessage.fallbackStrategy).toBe("summarize-context");
      expect(summaryMessage.fallbackReason).toMatch(/Provider not found/);
    } finally {
      await rm(cwd, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("produces a real llm-summary (no fallback) when the provider returns text", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "procway-code-"));
    try {
      const session = await new AgentSession({
        settings: {
          defaultProvider: "test",
          defaultModel: "test-model",
          session: { enabled: true, autoCompact: { keepLastMessages: 2, strategy: "llm-summary" } },
          tools: {},
          agents: {}
        },
        cwd,
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "old request" },
          { role: "assistant", content: "old answer" },
          { role: "user", content: "recent request" },
          { role: "assistant", content: "recent answer" }
        ]
      }).initialize();

      let providerCalls = 0;
      const runProviderImpl = async ({ messages }) => {
        providerCalls += 1;
        // The summarizer is handed a system prompt + the rendered transcript.
        expect(messages[0].role).toBe("system");
        return { message: { role: "assistant", content: "MODEL SUMMARY" } };
      };

      const compactEvents = [];
      session.events.on("compact.applied", (event) => compactEvents.push(event));

      const result = await session.compact({ runProviderImpl });

      expect(providerCalls).toBe(1);
      expect(result.compacted).toBe(true);
      expect(result.llmFallback).toBe(false);
      expect(result.summary).toBe("MODEL SUMMARY");
      expect(compactEvents).toHaveLength(1);
      expect(compactEvents[0]).toEqual(expect.objectContaining({
        strategy: "llm-summary",
        summary: "MODEL SUMMARY"
      }));
      expect(compactEvents[0].llmFallback).toBeUndefined();

      const summaryMessage = session.messages.find((m) => m.role === "system" && m.compacted === true);
      expect(summaryMessage.compactStrategy).toBe("llm-summary");
      expect(summaryMessage.llmFallback).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("emits compact.started before compact.applied so the TUI can show a spinner", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "procway-code-"));
    try {
      const session = await new AgentSession({
        settings: {
          defaultProvider: "test",
          defaultModel: "test-model",
          session: { enabled: true, autoCompact: { keepLastMessages: 2, strategy: "summarize-context" } },
          tools: {},
          agents: {}
        },
        cwd,
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "old request" },
          { role: "assistant", content: "old answer" },
          { role: "user", content: "recent request" },
          { role: "assistant", content: "recent answer" }
        ]
      }).initialize();

      const seq = [];
      session.events.on("compact.started", (event) => seq.push({ type: event.type, ...event }));
      session.events.on("compact.applied", (event) => seq.push({ type: event.type, ...event }));

      const result = await session.compact();
      expect(result.compacted).toBe(true);
      expect(seq.map((e) => e.type)).toEqual(["compact.started", "compact.applied"]);
      expect(seq[0]).toEqual(expect.objectContaining({
        type: "compact.started",
        strategy: "summarize-context",
        keepLastMessages: 2
      }));
    } finally {
      await rm(cwd, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("emits a compacted:false no-op so the TUI spinner always closes", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "procway-code-"));
    try {
      const session = await new AgentSession({
        settings: {
          defaultProvider: "test",
          defaultModel: "test-model",
          session: { enabled: true, autoCompact: { keepLastMessages: 100, strategy: "summarize-context" } },
          tools: {},
          agents: {}
        },
        cwd,
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "recent request" },
          { role: "assistant", content: "recent answer" }
        ]
      }).initialize();

      const applied = [];
      session.events.on("compact.applied", (event) => applied.push(event));

      const result = await session.compact();
      expect(result.compacted).toBe(false);
      expect(applied).toHaveLength(1);
      expect(applied[0]).toEqual(expect.objectContaining({
        type: "compact.applied",
        compacted: false,
        strategy: "summarize-context"
      }));
    } finally {
      await rm(cwd, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
