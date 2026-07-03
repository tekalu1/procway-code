import { describe, expect, it } from "vitest";
import { compactMessagesLlm } from "../src/compactor/llm-summary.mjs";

const goldenInput = [
  { role: "system", content: "You are procway-code." },
  { role: "user", content: "Investigate auth-token rotation in src/auth/token.mjs" },
  { role: "assistant", content: null, tool_calls: [{ function: { name: "read_file", arguments: JSON.stringify({ filePath: "src/auth/token.mjs" }) } }] },
  { role: "tool", content: JSON.stringify({ path: "src/auth/token.mjs", content: "function rotateToken() { /* TODO */ }" }) },
  { role: "assistant", content: "Token rotation has a TODO at src/auth/token.mjs. Suggest writing tests first." },
  { role: "user", content: "Yes — write tests" },
  { role: "assistant", content: "Will add Vitest cases for rotation edge cases." },
  { role: "user", content: "Continue" }
];

const expectedKeywords = ["src/auth/token.mjs", "rotation", "tests"];

describe("compactMessagesLlm", () => {
  it("uses the provider response when available and keeps the latest tail", async () => {
    const summaryText = "Summary: investigated src/auth/token.mjs token rotation, agreed to add Vitest tests.";
    const runProviderImpl = async () => ({ message: { role: "assistant", content: summaryText }, usage: { inputTokens: 200, outputTokens: 30 } });
    const result = await compactMessagesLlm({
      messages: goldenInput,
      keepLastMessages: 2,
      runProviderImpl,
      now: new Date("2026-05-06T00:00:00.000Z")
    });
    expect(result.compacted).toBe(true);
    expect(result.llmFallback).toBe(false);
    const summaryEntry = result.messages.find((message) => message.compacted === true);
    expect(summaryEntry?.content).toBe(summaryText);
    for (const keyword of expectedKeywords) {
      expect(summaryEntry.content + " " + summaryText).toContain(keyword);
    }
    expect(result.messages.at(-1)).toEqual(goldenInput.at(-1));
  });

  it("falls back to summarize-context when the provider throws", async () => {
    const runProviderImpl = async () => { throw new Error("offline"); };
    const result = await compactMessagesLlm({
      messages: goldenInput,
      keepLastMessages: 2,
      runProviderImpl,
      now: new Date("2026-05-06T00:00:00.000Z")
    });
    expect(result.compacted).toBe(true);
    expect(result.llmFallback).toBe(true);
    expect(result.fallbackReason).toBe("offline");
    const summaryEntry = result.messages.find((message) => message.compacted === true);
    expect(summaryEntry?.content).toContain("【コンパクトサマリー】");
  });

  it("falls back when the provider returns empty text", async () => {
    const runProviderImpl = async () => ({ message: { role: "assistant", content: "" } });
    const result = await compactMessagesLlm({
      messages: goldenInput,
      keepLastMessages: 2,
      runProviderImpl
    });
    expect(result.llmFallback).toBe(true);
    expect(result.fallbackReason).toBe("empty-summary");
  });

  it("omits tool-result bodies from the summarizer input when dropToolResults is set", async () => {
    let captured = null;
    const runProviderImpl = async ({ messages }) => {
      captured = messages;
      return { message: { role: "assistant", content: "ok" } };
    };
    await compactMessagesLlm({
      messages: goldenInput,
      keepLastMessages: 2,
      dropToolResults: true,
      runProviderImpl,
      now: new Date("2026-05-06T00:00:00.000Z")
    });
    const userPrompt = captured.find((m) => m.role === "user")?.content ?? "";
    // The tool result body (rotateToken TODO dump) must not reach the summarizer…
    expect(userPrompt).not.toContain("function rotateToken");
    // …while the surrounding user/assistant turns still do.
    expect(userPrompt).toContain("src/auth/token.mjs");
  });

  it("returns compacted=false when there is nothing to compact", async () => {
    const result = await compactMessagesLlm({
      messages: [{ role: "user", content: "hi" }],
      keepLastMessages: 5,
      runProviderImpl: async () => ({ message: { role: "assistant", content: "x" } })
    });
    expect(result.compacted).toBe(false);
  });
});
