import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/agent/conversation.mjs";
import { EventBus } from "../src/core/events/bus.mjs";
import { messagesFromEvents } from "../src/core/projections/messages.mjs";
import { createEvent } from "../src/core/events/types.mjs";

const tempDirs = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

async function makeWorkspace() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "procway-isomorphism-"));
  tempDirs.push(dir);
  return dir;
}

function dropEnvelope(message) {
  const { id: _ignored, ...rest } = message;
  return rest;
}

describe("event-stream <-> messages projection isomorphism", () => {
  it("recovers session.messages (id-aside) by replaying emitted events through messagesFromEvents", async () => {
    const cwd = await makeWorkspace();
    const events = new EventBus();
    const collected = [];
    events.on("*", (event) => collected.push(event));

    // Use the cli-agent provider with the running Node binary to produce a
    // deterministic stdout response without ever calling a real LLM API.
    const settings = {
      defaultProvider: "test-cli",
      defaultModel: "test-model",
      providers: {
        "test-cli": {
          type: "cli-agent",
          command: process.execPath,
          args: ["-e", "process.stdout.write('hello world')"],
          stdinMode: "none"
        }
      },
      session: { enabled: false },
      tools: { maxToolRounds: 1 },
      agents: { defaultTimeoutMs: 30000 }
    };

    const session = await new AgentSession({ settings, cwd, events }).initialize();
    await session.runTurn("ping");

    expect(collected.find((event) => event.type === "user.prompt.submitted")).toBeDefined();
    expect(collected.find((event) => event.type === "assistant.message.completed")).toBeDefined();
    expect(collected.find((event) => event.type === "turn.completed")).toBeDefined();

    const projected = messagesFromEvents(collected);
    // session.messages[0] is the system message (no event emitted for it).
    const turnMessages = session.messages.slice(1);
    expect(projected).toHaveLength(turnMessages.length);

    for (let index = 0; index < turnMessages.length; index += 1) {
      const expected = dropEnvelope(turnMessages[index]);
      const actual = dropEnvelope(projected[index]);
      expect(actual.role).toBe(expected.role);
      expect(actual.content).toEqual(expected.content);
      if (expected.toolCallId) expect(actual.toolCallId).toBe(expected.toolCallId);
      expect(actual.sessionId).toBe(session.sessionId);
    }
  });

  it("phase2_C-1: a tool-call turn fixture replays into Message[] with tool_use + tool_result content blocks", () => {
    const sessionId = "s-tool-fixture";
    const events = [
      createEvent("session.created", {
        sessionId,
        cwd: "/tmp",
        provider: "anthropic-main",
        model: "claude-opus-4-7"
      }),
      createEvent("user.prompt.submitted", {
        sessionId,
        messageId: "u-1",
        content: [{ kind: "text", text: "read README.md" }]
      }),
      createEvent("assistant.message.completed", {
        sessionId,
        messageId: "a-1",
        content: [
          { kind: "tool_use", toolCallId: "tc-1", name: "read_file", args: { path: "README.md" } }
        ]
      }),
      createEvent("tool.call.completed", {
        sessionId,
        toolCallId: "tc-1",
        ok: true,
        result: {
          kind: "read_file",
          summary: "Read 12 B from README.md",
          data: { path: "README.md", bytes: 12, content: "hello world\n" }
        }
      }),
      createEvent("assistant.message.completed", {
        sessionId,
        messageId: "a-2",
        content: [{ kind: "text", text: "the readme says hello world." }]
      })
    ];
    const messages = messagesFromEvents(events);
    expect(messages).toHaveLength(4);
    expect(messages[0]).toEqual(expect.objectContaining({ id: "u-1", role: "user", sessionId }));
    expect(messages[1]).toEqual(expect.objectContaining({ id: "a-1", role: "assistant", sessionId }));
    expect(messages[1].content).toEqual([
      { kind: "tool_use", toolCallId: "tc-1", name: "read_file", args: { path: "README.md" } }
    ]);
    expect(messages[2]).toEqual(expect.objectContaining({ role: "tool", toolCallId: "tc-1", sessionId }));
    expect(messages[2].content[0]).toEqual(expect.objectContaining({
      kind: "tool_result",
      toolCallId: "tc-1",
      ok: true
    }));
    expect(messages[2].content[0].result).toEqual({
      kind: "read_file",
      summary: "Read 12 B from README.md",
      data: { path: "README.md", bytes: 12, content: "hello world\n" }
    });
    expect(messages[3]).toEqual(expect.objectContaining({ id: "a-2", role: "assistant", sessionId }));
  });

  it("phase2_E-1: missing sessionId triggers onWarning and skips the affected message", () => {
    const events = [
      // No session.created → no sessionId carried forward.
      createEvent("user.prompt.submitted", {
        messageId: "u-orphan",
        content: [{ kind: "text", text: "orphaned" }]
      }),
      createEvent("session.created", {
        sessionId: "s-recovered",
        cwd: "/tmp",
        provider: "p",
        model: "m"
      }),
      createEvent("user.prompt.submitted", {
        sessionId: "s-recovered",
        messageId: "u-ok",
        content: [{ kind: "text", text: "after recovery" }]
      })
    ];
    const warnings = [];
    const messages = messagesFromEvents(events, { onWarning: (warning) => warnings.push(warning) });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(expect.objectContaining({ id: "u-ok", sessionId: "s-recovered" }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0].reason).toBe("missing sessionId");
    expect(warnings[0].event.messageId).toBe("u-orphan");
  });
});
