import { describe, expect, it } from "vitest";
import {
  renderTranscriptNode,
  renderTranscriptNodes,
  renderTranscript,
  printTranscript,
  collectToolCalls,
  renderAssistantContent,
  RECAP_MAX_MESSAGES,
  NO_HISTORY
} from "../src/adapters/tui/transcript-node-render.mjs";
import { transcriptFromMessages } from "../src/core/projections/transcript.mjs";
import { stripAnsi } from "../src/adapters/tui/ansi.mjs";
import { TOOL_PREVIEW_LINES } from "../src/adapters/tui/tool-render.mjs";

function toolMessage({ id, kind, summary, data }) {
  return {
    role: "tool",
    toolCallId: id,
    content: [{ kind: "tool_result", toolCallId: id, ok: true, result: { kind, summary, data } }]
  };
}

function assistantToolUse(calls) {
  return {
    role: "assistant",
    content: calls.map((call) => ({ kind: "tool_use", toolCallId: call.id, name: call.name, args: call.args }))
  };
}

describe("renderTranscriptNode — per node kind", () => {
  it("renders a user node with a label", () => {
    const out = renderTranscriptNode({ kind: "user", role: "user", text: "hello" });
    expect(out).toBe("You: hello");
  });

  it("renders user attachments as chips", () => {
    const out = renderTranscriptNode({
      kind: "user",
      role: "user",
      text: "look",
      attachments: [{ id: "a-1", name: "shot.png" }]
    });
    expect(out).toContain("shot.png");
  });

  it("renders an assistant node through the Markdown renderer", () => {
    const out = renderTranscriptNode({ kind: "assistant", role: "assistant", text: "# Title\n\n- one\n- two\n" });
    expect(out.startsWith("Assistant:\n")).toBe(true);
    expect(out).toContain("# Title");
    expect(out).toContain("• one");
  });

  it("colorizes only when asked", () => {
    const node = { kind: "assistant", role: "assistant", text: "hi" };
    expect(renderTranscriptNode(node, { colorize: false })).not.toContain("\x1b[");
    expect(renderTranscriptNode(node, { colorize: true })).toContain("\x1b[");
  });

  it("renders a tool node as a tool call line, not raw JSON", () => {
    const node = {
      kind: "tool",
      role: "tool",
      toolCallId: "tc-1",
      text: JSON.stringify({ kind: "list_files", summary: "Listed 3 entries in .", data: [{ name: "a", type: "file" }] })
    };
    const out = renderTranscriptNode(node, {
      toolCalls: new Map([["tc-1", { name: "list_files", args: { dirPath: "src" } }]])
    });
    expect(out).toContain("✓ list_files(dir=src)");
    expect(out).toContain("Listed 3 entries in .");
    expect(out).not.toContain('{"kind"');
  });

  it("falls back to the result kind when the call is not in the pairing map", () => {
    const node = {
      kind: "tool",
      role: "tool",
      toolCallId: "orphan",
      text: JSON.stringify({ kind: "run_shell", summary: "Ran: ls (exit 0)", data: { stdout: "a\n" } })
    };
    expect(renderTranscriptNode(node)).toContain("✓ run_shell");
  });

  it("marks a failed tool node with ✗", () => {
    const node = { kind: "tool", role: "tool", toolCallId: "tc-e", text: JSON.stringify({ error: "boom" }) };
    const out = renderTranscriptNode(node, { toolCalls: new Map([["tc-e", { name: "Edit", args: { filePath: "x" } }]]) });
    expect(out).toContain("✗ Edit(path=x)");
    expect(out).toContain("boom");
  });

  it("renders a non-JSON tool payload as its own summary", () => {
    const node = { kind: "tool", role: "tool", toolCallId: "tc-p", text: "plain text result" };
    expect(renderTranscriptNode(node)).toContain("plain text result");
  });

  it("dims compact-summary and system nodes", () => {
    const compact = renderTranscriptNode(
      { kind: "compact-summary", role: "system", text: "summary body", strategy: "summarize-context" },
      { colorize: false }
    );
    expect(compact).toContain("— compacted (summarize-context) —");
    expect(compact).toContain("summary body");
    expect(renderTranscriptNode({ kind: "system", role: "system", text: "note" })).toBe("note");
  });

  it("renders pending tool calls (no result yet) as start lines", () => {
    const node = {
      kind: "assistant-tool-calls",
      role: "assistant",
      text: "[tool calls: run_shell]",
      toolCalls: [{ toolCallId: "tc-9", name: "run_shell", args: { command: "pnpm test" } }]
    };
    expect(renderTranscriptNode(node)).toBe('● run_shell(command="pnpm test")');
  });

  it("suppresses an assistant-tool-calls node whose calls all have results", () => {
    const node = {
      kind: "assistant-tool-calls",
      role: "assistant",
      text: "[tool calls: run_shell]",
      toolCalls: [{ toolCallId: "tc-9", name: "run_shell", args: {} }]
    };
    expect(renderTranscriptNode(node, { resolvedToolCallIds: new Set(["tc-9"]) })).toBe("");
  });
});

describe("renderTranscriptNode — tool call / result pairing (P1-2)", () => {
  const messages = [
    { role: "user", content: "run the tests" },
    assistantToolUse([{ id: "call-1", name: "run_shell", args: { command: "pnpm test" } }]),
    toolMessage({ id: "call-1", kind: "run_shell", summary: "Ran: pnpm test (exit 0)", data: { stdout: "137 passed\n", stderr: "" } })
  ];

  it("collectToolCalls maps toolCallId → { name, args }", () => {
    const map = collectToolCalls(messages);
    expect(map.get("call-1")).toEqual({ name: "run_shell", args: { command: "pnpm test" } });
  });

  it("recovers arguments from an assistant message that also has text", () => {
    const map = collectToolCalls([
      {
        role: "assistant",
        content: [
          { kind: "text", text: "let me check" },
          { kind: "tool_use", toolCallId: "mixed", name: "read_file", args: { filePath: "a.mjs" } }
        ]
      }
    ]);
    expect(map.get("mixed").name).toBe("read_file");
  });

  it("collectToolCalls understands legacy tool_calls with JSON string arguments", () => {
    const map = collectToolCalls([
      { role: "assistant", content: null, tool_calls: [{ id: "legacy", function: { name: "run_shell", arguments: '{"command":"ls"}' } }] }
    ]);
    expect(map.get("legacy")).toEqual({ name: "run_shell", args: { command: "ls" } });
  });

  it("shows what command was run when the transcript is replayed", () => {
    const plain = stripAnsi(renderTranscript(messages));
    expect(plain).toContain('✓ run_shell(command="pnpm test")');
    expect(plain).toContain("Ran: pnpm test (exit 0)");
    expect(plain).toContain("137 passed");
    // The [tool calls: …] placeholder is replaced by the paired line.
    expect(plain).not.toContain("[tool calls:");
  });

  it("keeps a call whose result fell outside the window visible as pending", () => {
    const nodes = transcriptFromMessages(messages.slice(0, 2));
    expect(stripAnsi(renderTranscriptNodes(nodes))).toContain('● run_shell(command="pnpm test")');
  });
});

describe("renderTranscriptNode — clipping (P1-4)", () => {
  const bigFile = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join("\n");
  const messages = [
    assistantToolUse([{ id: "big", name: "read_file", args: { filePath: "huge.txt" } }]),
    toolMessage({ id: "big", kind: "read_file", summary: "Read 4 KB from huge.txt", data: { content: bigFile } })
  ];

  it("clips a huge tool result to previewLines and reports the remainder", () => {
    const plain = stripAnsi(renderTranscript(messages));
    expect(plain).toContain("✓ read_file(path=huge.txt)");
    expect(plain).toContain("line 1");
    expect(plain).not.toContain("line 300");
    expect(plain).toMatch(/… \(\d+ more lines\)/);
    // No ":show" — that command does not exist.
    expect(plain).not.toContain(":show");
    const bodyLines = plain.split("\n").filter((line) => line.startsWith("  "));
    expect(bodyLines.length).toBeLessThanOrEqual(TOOL_PREVIEW_LINES + 1);
  });

  it("caps a single pathological line with maxChars", () => {
    const oneLine = "x".repeat(50_000);
    const plain = stripAnsi(renderTranscript([
      assistantToolUse([{ id: "min", name: "read_file", args: { filePath: "min.json" } }]),
      toolMessage({ id: "min", kind: "read_file", summary: "Read 50 KB", data: { content: oneLine } })
    ]));
    expect(plain.length).toBeLessThan(3000);
  });

  it("expanded:true keeps the whole body", () => {
    const plain = stripAnsi(renderTranscript(messages, { expanded: true, toolMaxChars: null }));
    expect(plain).toContain("line 400");
  });

  it("truncates user/assistant text when maxChars is given", () => {
    const plain = stripAnsi(renderTranscript([{ role: "assistant", content: "abcdef" }], { maxChars: 3 }));
    expect(plain).toContain("abc");
    expect(plain).toContain("[truncated]");
    expect(plain).not.toContain("abcdef");
  });

  it("does not truncate conversation text by default", () => {
    // Markdown-rendered assistant text is wrapped, so compare character
    // counts rather than the raw run.
    const long = "x".repeat(2000);
    const plain = stripAnsi(renderTranscript([{ role: "assistant", content: long }]));
    expect(plain.replace(/[^x]/g, "").length).toBe(2000);
    expect(plain).not.toContain("[truncated]");
  });
});

describe("renderTranscript — whole transcript", () => {
  it("returns the no-history sentinel when the projection is empty", () => {
    expect(renderTranscript([])).toBe(NO_HISTORY);
    expect(renderTranscript([{ role: "system", content: "hidden prompt" }])).toBe(NO_HISTORY);
  });

  it("hides the system prompt but keeps user and assistant turns", () => {
    const plain = stripAnsi(renderTranscript([
      { role: "system", content: "ignored" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" }
    ]));
    expect(plain).not.toContain("ignored");
    expect(plain).toContain("You: hello");
    expect(plain).toContain("Assistant:\nhi");
  });

  it("defaults maxMessages to the shared recap value", () => {
    expect(RECAP_MAX_MESSAGES).toBe(100);
    const many = Array.from({ length: 250 }, (_, i) => ({ role: "user", content: `m${i}` }));
    const plain = stripAnsi(renderTranscript(many));
    expect(plain).toContain("m249");
    expect(plain).not.toContain("m149");
  });

  it("printTranscript writes to the given stream and picks up its width", () => {
    let written = "";
    const stream = { columns: 100, write: (value) => { written += value; } };
    printTranscript({ messages: [{ role: "user", content: "hi" }], output: stream });
    expect(written).toContain("You: hi");
  });
});

describe("renderAssistantContent", () => {
  it("renders content blocks without a role label", () => {
    const out = renderAssistantContent([{ kind: "text", text: "# hi" }], { colorize: false });
    // Same shape as the streaming path: rendered body, then the one blank
    // line that separates the message from the next prompt.
    expect(out).toBe("# hi\n\n");
    expect(out).not.toContain("Assistant");
  });

  it("renders Markdown even without colour (live/replay parity on a pipe)", () => {
    // It used to pass the raw text through when colorize was false, so a
    // piped run showed `- a` live and `• a` on replay.
    const out = renderAssistantContent([{ kind: "text", text: "- a\n- b\n" }], { colorize: false });
    expect(out).toBe("• a\n• b\n\n");
  });

  it("returns an empty string for content with no text", () => {
    expect(renderAssistantContent(null)).toBe("");
    expect(renderAssistantContent([{ kind: "tool_use", name: "x" }])).toBe("");
  });
});
