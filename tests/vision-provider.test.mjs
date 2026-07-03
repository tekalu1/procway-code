import { describe, expect, it, vi } from "vitest";
import {
  providerSupportsVision,
  resolveVisionProviderId,
  runVisionOneShot
} from "../src/providers/vision.mjs";
import { validateSettings } from "../src/config/schema.mjs";

const IMG = { mime: "image/png", dataBase64: "AAA" };

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

describe("providerSupportsVision", () => {
  it("defaults to true when the flag is omitted (status quo)", () => {
    expect(providerSupportsVision({ type: "openai" })).toBe(true);
    expect(providerSupportsVision({ type: "anthropic", supportsVision: true })).toBe(true);
  });

  it("is false for supportsVision: false, cli-agent, and missing providers", () => {
    expect(providerSupportsVision({ type: "openai-compatible", supportsVision: false })).toBe(false);
    expect(providerSupportsVision({ type: "cli-agent" })).toBe(false);
    expect(providerSupportsVision(null)).toBe(false);
    expect(providerSupportsVision(undefined)).toBe(false);
  });
});

describe("resolveVisionProviderId", () => {
  it("returns the configured vision provider id", () => {
    expect(resolveVisionProviderId(settingsFixture())).toBe("vision-model");
  });

  it("returns null when unset, unknown, cli-agent, or itself text-only", () => {
    expect(resolveVisionProviderId(settingsFixture({ visionProvider: undefined }))).toBeNull();
    expect(resolveVisionProviderId(settingsFixture({ visionProvider: "" }))).toBeNull();
    expect(resolveVisionProviderId(settingsFixture({ visionProvider: "ghost" }))).toBeNull();
    const cli = settingsFixture();
    cli.providers["vision-model"] = { type: "cli-agent", command: "x" };
    expect(resolveVisionProviderId(cli)).toBeNull();
    const textOnly = settingsFixture();
    textOnly.providers["vision-model"].supportsVision = false;
    expect(resolveVisionProviderId(textOnly)).toBeNull();
  });
});

describe("runVisionOneShot", () => {
  it("switches defaultProvider to the vision provider for a tool-less non-streaming call", async () => {
    const runProviderImpl = vi.fn(async () => ({
      message: { role: "assistant", content: [{ kind: "text", text: "a red button" }] },
      toolCalls: [],
      usage: {}
    }));
    const answer = await runVisionOneShot({
      settings: settingsFixture(),
      prompt: "what is highlighted?",
      images: [IMG],
      runProviderImpl
    });
    expect(answer).toBe("a red button");
    expect(runProviderImpl).toHaveBeenCalledTimes(1);
    const call = runProviderImpl.mock.calls[0][0];
    expect(call.settings.defaultProvider).toBe("vision-model");
    expect(call.stream).toBe(false);
    expect(call.tools).toEqual([]);
    const content = call.messages[0].content;
    expect(content[0]).toEqual({ kind: "text", text: "what is highlighted?" });
    expect(content[1]).toEqual({ kind: "image", mime: "image/png", dataBase64: "AAA" });
  });

  it("accepts a plain-string message content in the response", async () => {
    const runProviderImpl = vi.fn(async () => ({ message: { role: "assistant", content: "plain" } }));
    await expect(runVisionOneShot({
      settings: settingsFixture(), prompt: "q", images: [IMG], runProviderImpl
    })).resolves.toBe("plain");
  });

  it("throws when no vision provider is configured", async () => {
    await expect(runVisionOneShot({
      settings: settingsFixture({ visionProvider: undefined }),
      prompt: "q",
      images: [IMG],
      runProviderImpl: vi.fn()
    })).rejects.toThrow(/No vision provider configured/);
  });

  it("throws on an empty answer and on missing images", async () => {
    const empty = vi.fn(async () => ({ message: { role: "assistant", content: [] } }));
    await expect(runVisionOneShot({
      settings: settingsFixture(), prompt: "q", images: [IMG], runProviderImpl: empty
    })).rejects.toThrow(/empty answer/);
    await expect(runVisionOneShot({
      settings: settingsFixture(), prompt: "q", images: [], runProviderImpl: vi.fn()
    })).rejects.toThrow(/at least one inline image/);
  });
});

describe("settings schema: supportsVision / visionProvider", () => {
  it("accepts the main+vision split fixture", () => {
    const errors = validateSettings(settingsFixture());
    expect(errors).toEqual([]);
  });

  it("rejects a non-boolean supportsVision", () => {
    const settings = settingsFixture();
    settings.providers["deepseek-main"].supportsVision = "no";
    expect(validateSettings(settings)).toContainEqual(expect.stringContaining("supportsVision must be a boolean"));
  });

  it("rejects an unknown visionProvider", () => {
    const errors = validateSettings(settingsFixture({ visionProvider: "ghost" }));
    expect(errors).toContainEqual(expect.stringContaining("visionProvider not found"));
  });

  it("rejects a cli-agent visionProvider", () => {
    const settings = settingsFixture();
    settings.providers["vision-model"] = { type: "cli-agent", command: "x" };
    expect(validateSettings(settings)).toContainEqual(expect.stringContaining("must not be a cli-agent"));
  });

  it("rejects a visionProvider that is itself marked text-only", () => {
    const settings = settingsFixture();
    settings.providers["vision-model"].supportsVision = false;
    expect(validateSettings(settings)).toContainEqual(expect.stringContaining("supportsVision: false"));
  });
});
