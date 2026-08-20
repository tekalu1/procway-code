import { describe, expect, it } from "vitest";
import { transcriptFromMessages } from "../src/core/projections/transcript.mjs";
import { stripSystemReminders } from "../src/core/projections/transcript.mjs";
import { createMessage } from "../src/core/types/message.mjs";

describe("transcriptFromMessages projection", () => {
  it("returns pure structured nodes — no strings, no I/O", () => {
    const messages = [
      createMessage({ sessionId: "s", role: "user", content: [{ kind: "text", text: "hello" }] }),
      createMessage({
        sessionId: "s",
        role: "assistant",
        content: [
          { kind: "tool_use", toolCallId: "tc-1", name: "read_file", args: { path: "README.md" } }
        ]
      }),
      createMessage({
        sessionId: "s",
        role: "tool",
        toolCallId: "tc-1",
        content: [{
          kind: "tool_result",
          toolCallId: "tc-1",
          ok: true,
          result: { kind: "read_file", summary: "Read 0 B from README.md", data: { path: "README.md", bytes: 0 } }
        }]
      })
    ];
    const nodes = transcriptFromMessages(messages);
    expect(nodes).toHaveLength(3);
    expect(nodes[0]).toEqual({ kind: "user", role: "user", text: "hello" });
    expect(nodes[1].kind).toBe("assistant-tool-calls");
    expect(nodes[1].toolCalls).toEqual([
      { toolCallId: "tc-1", name: "read_file", args: { path: "README.md" } }
    ]);
    expect(nodes[2]).toEqual(expect.objectContaining({ kind: "tool", role: "tool", toolCallId: "tc-1" }));
  });

  it("hides the system prompt but projects compacted system messages as compact-summary", () => {
    const messages = [
      { role: "system", content: [{ kind: "text", text: "you are an agent (system prompt)" }] },
      {
        role: "system",
        compacted: true,
        compactStrategy: "llm-summary",
        llmFallback: true,
        fallbackStrategy: "summarize-context",
        fallbackReason: "no-provider",
        content: [{ kind: "text", text: "SUMMARY BODY" }]
      },
      createMessage({ sessionId: "s", role: "user", content: [{ kind: "text", text: "next" }] })
    ];
    const nodes = transcriptFromMessages(messages);
    // Plain system prompt is filtered; compacted summary + user survive.
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toEqual({
      kind: "compact-summary",
      role: "system",
      text: "SUMMARY BODY",
      strategy: "llm-summary",
      llmFallback: true,
      fallbackStrategy: "summarize-context",
      fallbackReason: "no-provider"
    });
    expect(nodes[1]).toEqual({ kind: "user", role: "user", text: "next" });
  });

  it("omits fallback fields on a non-fallback compacted summary", () => {
    const nodes = transcriptFromMessages([
      { role: "system", compacted: true, compactStrategy: "summarize-context", content: [{ kind: "text", text: "S" }] }
    ]);
    expect(nodes[0]).toEqual({ kind: "compact-summary", role: "system", text: "S", strategy: "summarize-context" });
  });

  it("projects a user message with attachments: drops the model-only note, surfaces inbound attachment metadata", () => {
    const messages = [
      createMessage({
        sessionId: "s",
        role: "user",
        content: [
          { kind: "text", text: "この件を調べて" },
          { kind: "attachment_ref", id: "att-img", mime: "image/png", name: "shot.png" },
          { kind: "attachment_ref", id: "att-file", mime: "text/plain", name: "log.txt" },
          // The model-only note buildAttachmentNote appends after the refs.
          { kind: "text", text: "[このメッセージには添付ファイルが 2 件あります: …]" }
        ]
      })
    ];
    const nodes = transcriptFromMessages(messages);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toEqual({
      kind: "user",
      role: "user",
      // note excluded — only the text BEFORE the first attachment_ref survives.
      text: "この件を調べて",
      attachments: [
        { id: "att-img", mime: "image/png", name: "shot.png" },
        { id: "att-file", mime: "text/plain", name: "log.txt" }
      ]
    });
  });

  it("ignores outbound attachment_refs when extracting inbound user attachments", () => {
    const nodes = transcriptFromMessages([
      createMessage({
        sessionId: "s",
        role: "user",
        content: [
          { kind: "text", text: "hi" },
          { kind: "attachment_ref", id: "out", mime: "image/png", direction: "outbound" }
        ]
      })
    ]);
    // The outbound ref is not the user's own upload — no attachments field.
    expect(nodes[0]).toEqual({ kind: "user", role: "user", text: "hi" });
  });

  it("strips a leading <system-reminder> preamble from the visible user text (R2a)", () => {
    // The Phase-2 AI-sidepanel injects the ticket/project context as a hidden
    // <system-reminder> prefix to the runtime prompt; it is persisted verbatim
    // on the user message but must NEVER render as a visible bubble.
    const hidden = "This conversation is scoped to project acme / ticket TK-9.\nFull ticket facts here.";
    const messages = [
      createMessage({
        sessionId: "s",
        role: "user",
        content: [{ kind: "text", text: `<system-reminder>\n${hidden}\n</system-reminder>\n\nfix the bug` }]
      })
    ];
    const nodes = transcriptFromMessages(messages);
    expect(nodes[0]).toEqual({ kind: "user", role: "user", text: "fix the bug" });
  });

  it("strips stacked reminders (task-completion retry + sidepanel context)", () => {
    const text = "<system-reminder>\nprevious turn ended without task complete.\n</system-reminder>\n\n"
      + "<system-reminder>\nticket context\n</system-reminder>\n\nactual question";
    const nodes = transcriptFromMessages([
      createMessage({ sessionId: "s", role: "user", content: [{ kind: "text", text }] })
    ]);
    expect(nodes[0].text).toBe("actual question");
  });

  it("stripSystemReminders is a no-op for ordinary prompts and handles non-strings", () => {
    expect(stripSystemReminders("just a normal message")).toBe("just a normal message");
    expect(stripSystemReminders("")).toBe("");
    expect(stripSystemReminders(undefined)).toBe("");
    // A reminder NOT at the start is left intact (only leading preambles are runtime prefixes).
    expect(stripSystemReminders("hi <system-reminder>x</system-reminder>")).toBe("hi <system-reminder>x</system-reminder>");
  });

  it("projects a wake-marked user message as a `wake` node, not an empty user bubble", () => {
    // event-wake (issue #143): the whole body is a <system-reminder>, so the
    // user projection would strip it to "" and every surface would render a
    // blank message nobody sent.
    const body = "<system-reminder>\nAUTOMATIC RESUME — this is NOT a message from the user.\n</system-reminder>";
    const wakeMessage = createMessage({ sessionId: "s", role: "user", content: [{ kind: "text", text: body }] });
    wakeMessage.wake = true;
    const nodes = transcriptFromMessages([
      createMessage({ sessionId: "s", role: "user", content: [{ kind: "text", text: "typed" }] }),
      wakeMessage
    ]);
    expect(nodes[0]).toEqual({ kind: "user", role: "user", text: "typed" });
    // Node kind of its own, system role, and the FULL body kept for the
    // transcript reader (the dashboard renders its own localized line).
    expect(nodes[1]).toEqual({ kind: "wake", role: "system", text: body });
    expect(nodes.some((node) => node.kind === "user" && node.text === "")).toBe(false);
  });

  it("leaves an unmarked user message on the normal user path", () => {
    const nodes = transcriptFromMessages([
      createMessage({ sessionId: "s", role: "user", content: [{ kind: "text", text: "still me" }] })
    ]);
    expect(nodes[0].kind).toBe("user");
  });

  it("returns [] for empty input and ignores non-object entries", () => {
    expect(transcriptFromMessages([])).toEqual([]);
    expect(transcriptFromMessages([null, undefined, 42])).toEqual([]);
  });

  it("respects the maxMessages window without mutating the input", () => {
    const messages = Array.from({ length: 30 }, (_, index) =>
      createMessage({ sessionId: "s", role: "user", content: [{ kind: "text", text: `m-${index}` }] })
    );
    const before = messages.slice();
    const nodes = transcriptFromMessages(messages, { maxMessages: 5 });
    expect(nodes).toHaveLength(5);
    expect(nodes[0].text).toBe("m-25");
    expect(nodes[4].text).toBe("m-29");
    expect(messages).toEqual(before);
  });
});
