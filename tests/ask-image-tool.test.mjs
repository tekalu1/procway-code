import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { askImage } from "../src/tools/ask-image.mjs";
import { executeToolCall, getToolDefinitions, filterToolDefinitionsForSettings } from "../src/tools/registry.mjs";
import { isToolResult } from "../src/core/types/tool-result.mjs";

async function withTmp(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "procway-askimg-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function settingsFixture(overrides = {}) {
  return {
    defaultProvider: "deepseek-main",
    visionProvider: "vision-model",
    providers: {
      "deepseek-main": {
        type: "openai-compatible",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        baseUrl: "https://api.example.com/v1",
        defaultModel: "deepseek-v4",
        supportsVision: false
      },
      "vision-model": {
        type: "openai-compatible",
        apiKeyEnv: "VISION_API_KEY",
        baseUrl: "https://vision.example.com/v1",
        defaultModel: "qwen-vl"
      }
    },
    ...overrides
  };
}

function visionAnswer(text) {
  return vi.fn(async () => ({
    message: { role: "assistant", content: [{ kind: "text", text }] },
    toolCalls: [],
    usage: {}
  }));
}

describe("ask_image tool", () => {
  it("is advertised in the tool definitions", () => {
    const names = getToolDefinitions().map((t) => t.function.name);
    expect(names).toContain("ask_image");
    expect(names).toContain("view_image");
  });

  it("returns the vision provider's answer for a real image file", async () => {
    await withTmp(async (dir) => {
      await writeFile(path.join(dir, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const runProviderImpl = visionAnswer("the dialog shows an EACCES error");
      const result = await askImage({
        cwd: dir,
        filePath: "shot.png",
        prompt: "read the error message",
        settings: settingsFixture(),
        runProviderImpl
      });
      expect(isToolResult(result)).toBe(true);
      expect(result.kind).toBe("ask_image");
      expect(result.data.answer).toBe("the dialog shows an EACCES error");
      expect(result.data.prompt).toBe("read the error message");
      expect(result.data.mime).toBe("image/png");
      // The one-shot ran against the vision provider, with the image inline.
      const call = runProviderImpl.mock.calls[0][0];
      expect(call.settings.defaultProvider).toBe("vision-model");
      expect(call.messages[0].content.some((b) => b.kind === "image")).toBe(true);
    });
  });

  it("degrades to an informative result (not a throw) when no vision provider is configured", async () => {
    await withTmp(async (dir) => {
      await writeFile(path.join(dir, "shot.png"), Buffer.from([1]));
      const runProviderImpl = vi.fn();
      const result = await askImage({
        cwd: dir,
        filePath: "shot.png",
        prompt: "what is this?",
        settings: settingsFixture({ visionProvider: undefined }),
        runProviderImpl
      });
      expect(isToolResult(result)).toBe(true);
      expect(result.data.skipped).toBe(true);
      expect(result.data.error).toMatch(/No vision provider/);
      expect(runProviderImpl).not.toHaveBeenCalled();
    });
  });

  it("validates path, prompt, mime, and size", async () => {
    await withTmp(async (dir) => {
      await writeFile(path.join(dir, "big.png"), Buffer.alloc(10));
      await writeFile(path.join(dir, "notes.txt"), "hello");
      const settings = settingsFixture();
      await expect(askImage({ cwd: dir, filePath: "", prompt: "q", settings })).rejects.toThrow(/non-empty 'path'/);
      await expect(askImage({ cwd: dir, filePath: "big.png", prompt: " ", settings })).rejects.toThrow(/non-empty 'prompt'/);
      await expect(askImage({ cwd: dir, filePath: "notes.txt", prompt: "q", settings })).rejects.toThrow(/Unsupported image type/);
      await expect(askImage({ cwd: dir, filePath: "ghost.png", prompt: "q", settings })).rejects.toThrow();
      const small = settingsFixture({ attachments: { maxImageBytes: 4 } });
      await expect(askImage({ cwd: dir, filePath: "big.png", prompt: "q", settings: small })).rejects.toThrow(/exceeding/);
    });
  });

  it("routes through executeToolCall", async () => {
    await withTmp(async (dir) => {
      await writeFile(path.join(dir, "a.webp"), Buffer.from([1, 2, 3]));
      // No vision provider configured → askImage returns its informative
      // result without ever dialing a real provider (keeps the test offline).
      const result = await executeToolCall({
        name: "ask_image",
        args: { path: "a.webp", prompt: "describe" },
        cwd: dir,
        settings: { ...settingsFixture({ visionProvider: undefined }), approvalMode: "auto-readonly", tools: {} }
      });
      expect(isToolResult(result)).toBe(true);
      expect(result.kind).toBe("ask_image");
      expect(result.data.skipped).toBe(true);
    });
  });
});

describe("filterToolDefinitionsForSettings", () => {
  // ADR 0030 D5: web_browser is availability-gated at registration; inject
  // "available" so the guidance-rewrite assertion is host-independent.
  const defs = getToolDefinitions({ availability: { web_browser: { available: true }, desktop_action: { available: true } } });
  const names = (settings) => filterToolDefinitionsForSettings(defs, settings).map((t) => t.function.name);

  it("keeps view_image and drops ask_image for a vision-capable main without a delegate", () => {
    const settings = settingsFixture({ visionProvider: undefined });
    settings.providers["deepseek-main"].supportsVision = undefined;
    const out = names(settings);
    expect(out).toContain("view_image");
    expect(out).not.toContain("ask_image");
  });

  it("drops view_image and keeps ask_image for a text-only main with a delegate", () => {
    const out = names(settingsFixture());
    expect(out).not.toContain("view_image");
    expect(out).toContain("ask_image");
  });

  it("drops both image tools for a text-only main without a delegate", () => {
    const out = names(settingsFixture({ visionProvider: undefined }));
    expect(out).not.toContain("view_image");
    expect(out).not.toContain("ask_image");
  });

  it("keeps both tools when main is vision-capable AND a delegate is configured", () => {
    const settings = settingsFixture();
    settings.providers["deepseek-main"].supportsVision = true;
    const out = names(settings);
    expect(out).toContain("view_image");
    expect(out).toContain("ask_image");
  });

  it("rewrites web_browser's view_image guidance when view_image is hidden", () => {
    const filtered = filterToolDefinitionsForSettings(defs, settingsFixture());
    const webBrowser = filtered.find((t) => t.function.name === "web_browser");
    expect(webBrowser.function.description).not.toContain("view_image them");
    expect(webBrowser.function.description).toContain("ask_image");
    // The original definitions are untouched (map copies).
    const original = defs.find((t) => t.function.name === "web_browser");
    expect(original.function.description).toContain("view_image them");
  });
});
