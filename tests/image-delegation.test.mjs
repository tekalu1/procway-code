import { describe, expect, it, vi } from "vitest";
import { delegateImageRefsForTextOnly } from "../src/providers/image-delegation.mjs";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

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

function fakeAttachmentFetch() {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: (k) => (k.toLowerCase() === "content-type" ? "image/png" : null) },
    arrayBuffer: async () => PNG_BYTES.buffer.slice(PNG_BYTES.byteOffset, PNG_BYTES.byteOffset + PNG_BYTES.byteLength)
  }));
}

function visionAnswer(text) {
  return vi.fn(async () => ({
    message: { role: "assistant", content: [{ kind: "text", text }] },
    toolCalls: [],
    usage: {}
  }));
}

const baseOpts = (overrides = {}) => ({
  settings: settingsFixture(),
  runProviderImpl: visionAnswer("unused"),
  dashboardUrl: "http://dash.local",
  proxyToken: "tok",
  fetchImpl: fakeAttachmentFetch(),
  ...overrides
});

describe("delegateImageRefsForTextOnly", () => {
  it("returns the same array when no image parts exist", async () => {
    const messages = [{ role: "user", content: [{ kind: "text", text: "hi" }] }];
    expect(await delegateImageRefsForTextOnly(messages, baseOpts())).toBe(messages);
  });

  it("degrades a file_ref to an ask_image pointer note when a delegate is configured", async () => {
    const messages = [{
      role: "tool",
      content: [
        { kind: "tool_result", toolCallId: "t1", ok: true, result: {} },
        { kind: "file_ref", path: "/ws/shot.png", mime: "image/png" }
      ]
    }];
    const out = await delegateImageRefsForTextOnly(messages, baseOpts());
    const note = out[0].content[1];
    expect(note.kind).toBe("text");
    expect(note.text).toContain("/ws/shot.png");
    expect(note.text).toContain("ask_image");
  });

  it("degrades a file_ref to a not-configured note without a delegate", async () => {
    const messages = [{ role: "user", content: [{ kind: "file_ref", path: "/ws/shot.png", mime: "image/png" }] }];
    const out = await delegateImageRefsForTextOnly(messages, baseOpts({ settings: settingsFixture({ visionProvider: undefined }) }));
    expect(out[0].content[0].text).toContain("no vision provider is configured");
    expect(out[0].content[0].text).not.toContain("ask_image");
  });

  it("auto-describes an attachment_ref through the vision provider and caches in place", async () => {
    const runProviderImpl = visionAnswer("screenshot of a login form");
    const fetchImpl = fakeAttachmentFetch();
    const refBlock = { kind: "attachment_ref", id: "att-1", mime: "image/png" };
    const messages = [{ role: "user", content: [{ kind: "text", text: "look" }, refBlock] }];

    const out = await delegateImageRefsForTextOnly(messages, baseOpts({ runProviderImpl, fetchImpl }));
    expect(out[0].content[0]).toEqual({ kind: "text", text: "look" });
    expect(out[0].content[1].kind).toBe("text");
    expect(out[0].content[1].text).toContain("att-1");
    expect(out[0].content[1].text).toContain("screenshot of a login form");
    // The original ref block survives (so a later vision-capable provider can
    // still hydrate it) and now carries the cached description.
    expect(messages[0].content[1].kind).toBe("attachment_ref");
    expect(refBlock.visionDescription).toBe("screenshot of a login form");

    // Second round: cache hit — no fetch, no provider call.
    const out2 = await delegateImageRefsForTextOnly(messages, baseOpts({ runProviderImpl, fetchImpl }));
    expect(out2[0].content[1].text).toContain("screenshot of a login form");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(runProviderImpl).toHaveBeenCalledTimes(1);
  });

  it("degrades an attachment_ref to a note when no delegate is configured", async () => {
    const messages = [{ role: "user", content: [{ kind: "attachment_ref", id: "att-2" }] }];
    const out = await delegateImageRefsForTextOnly(messages, baseOpts({ settings: settingsFixture({ visionProvider: undefined }) }));
    expect(out[0].content[0].text).toContain("att-2");
    expect(out[0].content[0].text).toContain("no vision provider is configured");
  });

  it("degrades to an error note when the vision call fails (turn still proceeds)", async () => {
    const runProviderImpl = vi.fn(async () => { throw new Error("vision 500"); });
    const messages = [{ role: "user", content: [{ kind: "attachment_ref", id: "att-3" }] }];
    const out = await delegateImageRefsForTextOnly(messages, baseOpts({ runProviderImpl }));
    expect(out[0].content[0].text).toContain("could not be described");
    expect(out[0].content[0].text).toContain("vision 500");
    expect(messages[0].content[0].visionDescription).toBeUndefined();
  });

  it("drops a transient inline image block with a note", async () => {
    const messages = [{ role: "user", content: [{ kind: "image", mime: "image/png", dataBase64: "AAA" }] }];
    const out = await delegateImageRefsForTextOnly(messages, baseOpts());
    expect(out[0].content[0]).toEqual({ kind: "text", text: "[inline image omitted: the current model cannot view images]" });
  });
});

describe("runProvider: text-only main never receives image parts", () => {
  it("delegates refs before dispatching to the wire adapter", async () => {
    vi.resetModules();
    const seen = { messages: null };
    vi.doMock("../src/providers/openai-compatible.mjs", () => ({
      runOpenAiCompatibleProvider: vi.fn(async ({ messages }) => {
        seen.messages = messages;
        return { message: { role: "assistant", content: [{ kind: "text", text: "ok" }] }, toolCalls: [], usage: {} };
      })
    }));
    const { runProvider } = await import("../src/providers/index.mjs");
    const messages = [{
      role: "user",
      content: [
        { kind: "text", text: "see the screenshot" },
        { kind: "file_ref", path: "/ws/shot.png", mime: "image/png" }
      ]
    }];
    await runProvider({ settings: settingsFixture(), messages, tools: [], stream: false });
    expect(seen.messages).not.toBeNull();
    const blocks = seen.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
    expect(blocks.some((b) => b.kind === "image" || b.kind === "file_ref" || b.kind === "attachment_ref")).toBe(false);
    expect(blocks.some((b) => b.kind === "text" && b.text.includes("ask_image"))).toBe(true);
    vi.doUnmock("../src/providers/openai-compatible.mjs");
    vi.resetModules();
  });
});
