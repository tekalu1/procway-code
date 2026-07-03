import { describe, expect, it } from "vitest";
import { transcriptFromMessages } from "../src/tui/transcript.mjs";

describe("transcript projection", () => {
  it("returns structured nodes and drops system messages", () => {
    const nodes = transcriptFromMessages([
      { role: "system", content: "hidden" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "tool", content: "{\"path\":\"README.md\"}" }
    ]);

    expect(nodes).toEqual([
      { kind: "user", role: "user", text: "hello" },
      { kind: "assistant", role: "assistant", text: "hi" },
      { kind: "tool", role: "tool", text: "{\"path\":\"README.md\"}" }
    ]);
  });

  it("projects assistant tool-call messages with toolCalls payload", () => {
    const nodes = transcriptFromMessages([
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "tc-1", function: { name: "read_file" } }]
      }
    ]);

    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toEqual(expect.objectContaining({
      kind: "assistant-tool-calls",
      role: "assistant",
      text: "[tool calls: read_file]"
    }));
    expect(nodes[0].toolCalls).toEqual([
      { toolCallId: "tc-1", name: "read_file", args: {} }
    ]);
  });

  it("projects ContentBlock-shaped tool_use messages", () => {
    const nodes = transcriptFromMessages([
      {
        role: "assistant",
        content: [
          { kind: "tool_use", toolCallId: "tc-2", name: "write_file", args: { path: "a.md" } }
        ]
      }
    ]);
    expect(nodes[0]).toEqual({
      kind: "assistant-tool-calls",
      role: "assistant",
      text: "[tool calls: write_file]",
      toolCalls: [{ toolCallId: "tc-2", name: "write_file", args: { path: "a.md" } }]
    });
  });

  it("projects tool_result content into a JSON-serialized text payload", () => {
    const nodes = transcriptFromMessages([
      {
        role: "tool",
        toolCallId: "tc-1",
        content: [{
          kind: "tool_result",
          toolCallId: "tc-1",
          ok: true,
          result: { kind: "read_file", summary: "", data: { path: "README.md" } }
        }]
      }
    ]);
    expect(nodes[0].kind).toBe("tool");
    expect(nodes[0].toolCallId).toBe("tc-1");
    expect(JSON.parse(nodes[0].text)).toEqual({
      kind: "read_file",
      summary: "",
      data: { path: "README.md" }
    });
  });

  it("keeps a larger recent history by default", () => {
    const messages = Array.from({ length: 30 }, (_, index) => ({
      role: "user",
      content: `message-${index}`
    }));
    const nodes = transcriptFromMessages(messages);
    expect(nodes).toHaveLength(30);
    expect(nodes[0].text).toBe("message-0");
    expect(nodes[29].text).toBe("message-29");
  });
});
