import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSession } from "../src/agent/conversation.mjs";
import { EventBus } from "../src/core/events/bus.mjs";
import {
  normalizeRunTurnAttachments,
  MAX_RUNTURN_ATTACHMENTS
} from "../src/adapters/serve/protocol.mjs";

const echoBin = fileURLToPath(new URL("./fixtures/cli-agent-echo.mjs", import.meta.url));

describe("protocol: normalizeRunTurnAttachments", () => {
  it("returns [] for nullish input", () => {
    expect(normalizeRunTurnAttachments(undefined)).toEqual([]);
    expect(normalizeRunTurnAttachments(null)).toEqual([]);
  });

  it("normalizes id + optional mime + optional name", () => {
    expect(normalizeRunTurnAttachments([
      { id: "att-1", mime: "image/png", name: "shot.png" },
      { id: "att-2" },
      { id: "att-3", name: "   " }
    ])).toEqual([
      { id: "att-1", mime: "image/png", name: "shot.png" },
      { id: "att-2" },
      { id: "att-3" }
    ]);
  });

  it("rejects non-array, missing id, bad mime, and bad name", () => {
    expect(() => normalizeRunTurnAttachments({})).toThrow(/must be an array/);
    expect(() => normalizeRunTurnAttachments([{}])).toThrow(/id is required/);
    // The pre-single-transport shape (path, no id) is rejected too: bytes are
    // fetched by id over HTTP, never read off a shared volume.
    expect(() => normalizeRunTurnAttachments([{ path: "/ws/a.png" }])).toThrow(/id is required/);
    expect(() => normalizeRunTurnAttachments([{ id: "x", mime: 5 }])).toThrow(/mime must be a string/);
    expect(() => normalizeRunTurnAttachments([{ id: "x", name: 5 }])).toThrow(/name must be a string/);
  });

  it("caps the attachment count", () => {
    const many = Array.from({ length: MAX_RUNTURN_ATTACHMENTS + 1 }, (_, i) => ({ id: `att-${i}` }));
    expect(() => normalizeRunTurnAttachments(many)).toThrow(/too many attachments/);
  });
});

describe("AgentSession.runTurn attachments", () => {
  it("adds attachment_ref blocks to the user message alongside the prompt text", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "procway-runturn-"));
    const session = new AgentSession({
      settings: {
        defaultProvider: "echo-agent",
        approvalMode: "auto-readonly",
        agents: { defaultTimeoutMs: 5000 },
        tools: { maxToolRounds: 1, maxParallelTools: 1 },
        providers: { "echo-agent": { type: "cli-agent", command: process.execPath, args: [echoBin], stdinMode: "json" } },
        session: { enabled: false }
      },
      cwd,
      sessionId: "s-1",
      events: new EventBus()
    });
    await session.initialize();
    session.messages = [];

    await session.runTurn("describe this", {
      attachments: [{ id: "att-x", mime: "image/png", name: "shot.png" }]
    });

    const userMsg = session.messages.find((m) => m.role === "user");
    expect(userMsg).toBeTruthy();
    expect(userMsg.content[0]).toEqual({ kind: "text", text: "describe this" });
    expect(userMsg.content).toContainEqual({
      kind: "attachment_ref",
      id: "att-x",
      mime: "image/png",
      name: "shot.png"
    });
    // The model-visible note: hydration shows the image but strips any
    // handle, so the note carries the id save_attachment needs.
    const note = userMsg.content.find((b) => b.kind === "text" && b.text.includes("attachment id"));
    expect(note).toBeTruthy();
    expect(note.text).toContain("shot.png");
    expect(note.text).toContain("attachment id: att-x");
    expect(note.text).toContain("save_attachment");

    await rm(cwd, { recursive: true, force: true });
  });
});
