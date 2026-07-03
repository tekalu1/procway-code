import { describe, expect, it } from "vitest";
import { formatAssistantText, getAssistantText } from "../src/agent/assistant-output.mjs";

describe("assistant output", () => {
  it("prefers assistant message content", () => {
    expect(getAssistantText({
      stdout: "stdout",
      message: { role: "assistant", content: "message" }
    })).toBe("message");
  });

  it("falls back to stdout", () => {
    expect(getAssistantText({ stdout: "stdout" })).toBe("stdout");
  });

  it("formats with trailing newline", () => {
    expect(formatAssistantText("hello")).toBe("hello\n");
    expect(formatAssistantText("hello\n")).toBe("hello\n");
  });
});
