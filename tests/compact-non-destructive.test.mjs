import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "../src/agent/conversation.mjs";
import { readEventLog } from "../src/session/event-log.mjs";

describe("compact non-destructive (Phase 3)", () => {
  it("preserves the original messages in events.jsonl after compact, indexed by removedMessageIds", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "procway-compact-"));
    try {
      const session = await new AgentSession({
        settings: {
          defaultProvider: "test",
          defaultModel: "test-model",
          session: { enabled: true, autoCompact: { keepLastMessages: 2 } },
          tools: {},
          agents: {}
        },
        cwd,
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "old request", id: "u-1", sessionId: "irrelevant" },
          { role: "assistant", content: "old answer", id: "a-1", sessionId: "irrelevant" },
          { role: "user", content: "recent request", id: "u-2", sessionId: "irrelevant" },
          { role: "assistant", content: "recent answer", id: "a-2", sessionId: "irrelevant" }
        ]
      }).initialize();

      // Replay surrogate events for the older messages so events.jsonl has the
      // pre-compaction history we expect to recover.
      const { createEvent } = await import("../src/core/events/types.mjs");
      session.events.emit(createEvent("user.prompt.submitted", {
        sessionId: session.sessionId,
        messageId: session.messages[1].id,
        content: session.messages[1].content
      }));
      session.events.emit(createEvent("assistant.message.completed", {
        sessionId: session.sessionId,
        messageId: session.messages[2].id,
        content: session.messages[2].content
      }));

      const result = await session.compact();
      expect(result.compacted).toBe(true);

      const events = await readEventLog({ sessionId: session.sessionId });
      const compactEvent = events.find((event) => event.type === "compact.applied");
      expect(compactEvent).toBeDefined();
      expect(compactEvent.removedMessageIds).toHaveLength(2);
      expect(typeof compactEvent.snapshotId).toBe("string");
      expect(compactEvent.snapshotId.length).toBeGreaterThan(0);

      // The original messages must still be reachable from events.jsonl.
      const recovered = new Map();
      for (const event of events) {
        if (event.type === "user.prompt.submitted") {
          recovered.set(event.messageId, { role: "user", content: event.content });
        } else if (event.type === "assistant.message.completed") {
          recovered.set(event.messageId, { role: "assistant", content: event.content });
        }
      }
      for (const removedId of compactEvent.removedMessageIds) {
        expect(recovered.has(removedId)).toBe(true);
      }

      const oldUser = recovered.get(compactEvent.removedMessageIds.find(
        (id) => recovered.get(id)?.role === "user"
      ));
      expect(oldUser.content).toEqual([{ kind: "text", text: "old request" }]);
    } finally {
      await rm(cwd, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
