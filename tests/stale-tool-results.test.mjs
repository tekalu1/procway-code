import { describe, expect, it } from "vitest";
import {
  condenseStaleToolResults,
  resolveStaleToolResultSettings
} from "../src/providers/stale-tool-results.mjs";

function toolMessage(content, { ok = true } = {}) {
  return {
    role: "tool",
    content: [
      {
        kind: "tool_result",
        toolCallId: "call-1",
        ok,
        result: { kind: "read_file", summary: "Read big file", data: { content } }
      }
    ]
  };
}

function assistantMessage() {
  return { role: "assistant", content: [{ kind: "text", text: "ok" }] };
}

const OPTS = { enabled: true, keepRecent: 2, maxChars: 100, headChars: 30, tailChars: 10 };

describe("condenseStaleToolResults", () => {
  it("keeps the most recent tool results intact and condenses old oversized ones", () => {
    const big = "x".repeat(500);
    const messages = [
      toolMessage(big), // stale → condensed
      assistantMessage(),
      toolMessage(big), // recent (last 2 tool messages)
      assistantMessage(),
      toolMessage("small")
    ];
    const out = condenseStaleToolResults(messages, OPTS);
    expect(out).not.toBe(messages);
    expect(out[0].content[0].result.data.condensed).toBe(true);
    expect(out[0].content[0].result.data.head.length).toBe(30);
    expect(out[0].content[0].result.data.tail.length).toBe(10);
    expect(out[0].content[0].result.data.note).toContain("re-run the tool");
    // recent ones untouched (same references)
    expect(out[2]).toBe(messages[2]);
    expect(out[4]).toBe(messages[4]);
  });

  it("never mutates the stored history", () => {
    const big = "y".repeat(500);
    const messages = [toolMessage(big), assistantMessage(), toolMessage(big), toolMessage(big)];
    condenseStaleToolResults(messages, OPTS);
    expect(messages[0].content[0].result.data.content).toBe(big);
  });

  it("passes through small stale results and error results", () => {
    const messages = [
      toolMessage("tiny"),
      { ...toolMessage("z".repeat(500), { ok: false }) },
      toolMessage("a"),
      toolMessage("b"),
      toolMessage("c")
    ];
    messages[1].content[0].ok = false;
    const out = condenseStaleToolResults(messages, OPTS);
    expect(out[0]).toBe(messages[0]); // small → untouched
    expect(out[1]).toBe(messages[1]); // error → untouched even though big
  });

  it("returns the same array when nothing is stale", () => {
    const messages = [toolMessage("x".repeat(500)), toolMessage("y".repeat(500))];
    expect(condenseStaleToolResults(messages, OPTS)).toBe(messages);
  });

  it("is deterministic and idempotent (cache-prefix stability)", () => {
    const big = "w".repeat(500);
    const messages = [toolMessage(big), assistantMessage(), toolMessage(big), toolMessage(big)];
    const once = condenseStaleToolResults(messages, OPTS);
    const twice = condenseStaleToolResults(once, OPTS);
    expect(JSON.stringify(twice[0])).toBe(JSON.stringify(once[0]));
    // already-condensed results are not re-condensed into a different shape
    expect(twice[0].content[0].result.data.condensed).toBe(true);
  });

  it("resolveStaleToolResultSettings: defaults on, false disables, object merges", () => {
    expect(resolveStaleToolResultSettings({}).enabled).toBe(true);
    expect(resolveStaleToolResultSettings({ tools: { staleToolResults: false } }).enabled).toBe(false);
    const merged = resolveStaleToolResultSettings({ tools: { staleToolResults: { keepRecent: 3 } } });
    expect(merged.keepRecent).toBe(3);
    expect(merged.maxChars).toBe(6000);
  });

  it("disabled mode is a pass-through", () => {
    const messages = [toolMessage("x".repeat(500)), assistantMessage(), toolMessage("x"), toolMessage("x")];
    expect(condenseStaleToolResults(messages, { ...OPTS, enabled: false })).toBe(messages);
  });
});
