import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { viewImage } from "../src/tools/view-image.mjs";
import { executeToolCall, getToolDefinitions } from "../src/tools/registry.mjs";
import { isToolResult } from "../src/core/types/tool-result.mjs";
import { AgentSession } from "../src/agent/conversation.mjs";
import { EventBus } from "../src/core/events/bus.mjs";
import { executeToolsRound } from "../src/agent/turn-orchestrator.mjs";

async function withTmp(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "procway-viewimg-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("view_image tool", () => {
  it("is advertised in the tool definitions", () => {
    const names = getToolDefinitions().map((t) => t.function.name);
    expect(names).toContain("view_image");
  });

  it("returns a view_image ToolResult + image attachment for a real image file", async () => {
    await withTmp(async (dir) => {
      await writeFile(path.join(dir, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const result = await viewImage({ cwd: dir, filePath: "shot.png" });
      expect(isToolResult(result)).toBe(true);
      expect(result.kind).toBe("view_image");
      expect(result.data.mime).toBe("image/png");
      expect(result.data.bytes).toBe(4);
      expect(result.attachments).toEqual([{ path: path.join(dir, "shot.png"), mime: "image/png" }]);
    });
  });

  it("rejects non-image files", async () => {
    await withTmp(async (dir) => {
      await writeFile(path.join(dir, "notes.txt"), "hello");
      await expect(viewImage({ cwd: dir, filePath: "notes.txt" })).rejects.toThrow(/Unsupported image type/);
    });
  });

  it("rejects a missing file", async () => {
    await withTmp(async (dir) => {
      await expect(viewImage({ cwd: dir, filePath: "ghost.png" })).rejects.toThrow();
    });
  });

  it("routes view_image through executeToolCall with attachments", async () => {
    await withTmp(async (dir) => {
      await writeFile(path.join(dir, "a.webp"), Buffer.from([1, 2, 3]));
      const result = await executeToolCall({
        name: "view_image",
        args: { path: "a.webp" },
        cwd: dir,
        settings: { approvalMode: "auto-readonly", tools: {} },
        approvalRequester: async () => true
      });
      expect(result.kind).toBe("view_image");
      expect(result.attachments[0].mime).toBe("image/webp");
    });
  });

  it("appends a file_ref block to the tool message and strips the attachments hint", async () => {
    await withTmp(async (dir) => {
      const events = new EventBus();
      const session = new AgentSession({
        settings: { tools: { maxParallelTools: 1 }, session: { enabled: false }, agents: {} },
        cwd: dir,
        sessionId: "s-1",
        events
      });
      await session.initialize();
      session.messages = [];
      session.executeSingleToolCall = async () => ({
        kind: "view_image",
        summary: "Loaded image a.png (4 B)",
        data: { path: "/ws/a.png", mime: "image/png", bytes: 4 },
        attachments: [{ path: "/ws/a.png", mime: "image/png" }]
      });

      await executeToolsRound({
        session,
        round: 0,
        messageId: "m1",
        toolCalls: [{ id: "call1", name: "view_image", args: { path: "a.png" } }]
      });

      const toolMsg = session.messages.find((m) => m.role === "tool");
      expect(toolMsg).toBeTruthy();
      expect(toolMsg.content[0].kind).toBe("tool_result");
      expect(toolMsg.content[0].result.attachments).toBeUndefined();
      expect(toolMsg.content[0].result.kind).toBe("view_image");
      expect(toolMsg.content[1]).toEqual({ kind: "file_ref", path: "/ws/a.png", mime: "image/png" });

      await rm(dir, { recursive: true, force: true });
    });
  });
});
