import { describe, expect, it } from "vitest";
import { LineEditor, layout } from "../src/adapters/tui/line-editor.mjs";
import { visibleWidth } from "../src/adapters/tui/ansi.mjs";

function makeEditor(overrides = {}) {
  let written = "";
  const editor = new LineEditor({
    write: (text) => { written += text; },
    prompt: "❯ ",
    continuation: "  ",
    width: () => 40,
    tty: true,
    ...overrides
  });
  return { editor, get output() { return written; }, reset() { written = ""; } };
}

describe("multi-line editor buffer", () => {
  it("inserts, splits and joins logical lines", () => {
    const { editor } = makeEditor();
    editor.insertText("one");
    editor.newline();
    editor.insertText("two");
    expect(editor.value).toBe("one\ntwo");
    expect(editor.lines).toEqual(["one", "two"]);

    editor.moveHome();
    editor.backspace(); // joins with the previous line
    expect(editor.value).toBe("onetwo");
    expect(editor.col).toBe(3);
  });

  it("detects and consumes a trailing backslash continuation", () => {
    const { editor } = makeEditor();
    editor.insertText("first\\");
    expect(editor.endsWithContinuation()).toBe(true);
    editor.applyContinuation();
    editor.insertText("second");
    expect(editor.value).toBe("first\nsecond");

    editor.clear();
    editor.insertText("escaped\\\\");
    expect(editor.endsWithContinuation()).toBe(false);
  });

  it("moves by grapheme, not by UTF-16 unit, for Japanese and emoji", () => {
    const { editor } = makeEditor();
    editor.insertText("日本語👨‍👩‍👧です");
    expect(editor.col).toBe(6); // 日+本+語 + 1 ZWJ family cluster + で+す
    editor.moveLeft();
    editor.moveLeft();
    editor.backspace(); // deletes the whole ZWJ family cluster
    expect(editor.value).toBe("日本語です");
  });

  it("word motions and kills operate on words", () => {
    const { editor } = makeEditor();
    editor.insertText("alpha beta gamma");
    editor.deleteWordBefore();
    expect(editor.value).toBe("alpha beta ");
    editor.moveWordLeft();
    expect(editor.col).toBe(6);
    editor.killToStart();
    expect(editor.value).toBe("beta ");
    editor.moveEnd();
    editor.killToEnd();
    expect(editor.value).toBe("beta ");
  });
});

describe("layout()", () => {
  it("wraps at width-1 so the last cell never arms a deferred wrap", () => {
    const { rows } = layout({ lines: ["x".repeat(50)], prompt: "❯ ", width: 20 });
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(19);
    expect(rows.join("")).toBe(`❯ ${"x".repeat(50)}`);
  });

  it("never splits a double-width cluster across rows", () => {
    const text = "日本語のテキストを入力してみるテストです";
    const { rows } = layout({ lines: [text], prompt: "❯ ", width: 20 });
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(19);
    expect(rows.join("")).toBe(`❯ ${text}`);
  });

  it("places the cursor at the right visible column for CJK", () => {
    const state = { lines: ["日本語"], row: 0, col: 2, prompt: "❯ ", width: 40 };
    const { cursorRow, cursorCol } = layout(state);
    expect(cursorRow).toBe(0);
    expect(cursorCol).toBe(2 + 4); // prompt "❯ " = 2 cols, two wide glyphs = 4
  });

  // The editor's cursor column is `visibleWidth(prompt) + …`. A prompt or
  // header carrying an OSC 8 link used to be measured with the whole URI
  // counted as columns, which would have parked the cursor tens of columns
  // to the right of the caret the user sees.
  it("measures a prompt containing an OSC 8 hyperlink as zero-width escapes", () => {
    const linked = `\x1b]8;;https://example.com/a/very/long/path\x1b\\❯\x1b]8;;\x1b\\ `;
    const { rows, cursorRow, cursorCol } = layout({
      lines: ["abc"], row: 0, col: 3, prompt: linked, width: 40
    });
    expect(cursorRow).toBe(0);
    expect(cursorCol).toBe(5); // "❯ " = 2 columns + "abc"
    expect(visibleWidth(rows[0])).toBe(5);
  });

  it("wraps a long line at the right column under a hyperlinked prompt", () => {
    const linked = `\x1b]8;;https://example.com\x07❯\x1b]8;;\x07 `;
    const { rows } = layout({ lines: ["x".repeat(50)], prompt: linked, width: 20 });
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(19);
    expect(rows.map((row) => row.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")).join(""))
      .toBe(`❯ ${"x".repeat(50)}`);
  });

  it("indents continuation rows and tracks the cursor per logical line", () => {
    const { rows, cursorRow, cursorCol } = layout({
      lines: ["one", "two"], row: 1, col: 3, prompt: "❯ ", continuation: "  ", width: 40
    });
    expect(rows).toEqual(["❯ one", "  two"]);
    expect(cursorRow).toBe(1);
    expect(cursorCol).toBe(5);
  });
});

describe("rendering", () => {
  it("repaints only its own region — the prompt is never re-emitted per row", () => {
    const harness = makeEditor();
    harness.editor.render();
    harness.reset();
    harness.editor.insertText("hello");
    harness.editor.render();
    const frame = harness.output;
    // One clear + one prompt, positioned relative to the region start.
    expect(frame.match(/❯ /g)).toHaveLength(1);
    expect(frame).toContain("\x1b[0J");
    expect(frame).toContain("❯ hello");
  });

  it("moves back up over every drawn row before repainting a multi-line buffer", () => {
    const harness = makeEditor();
    harness.editor.insertText("one");
    harness.editor.newline();
    harness.editor.insertText("two");
    harness.editor.render();
    harness.reset();
    harness.editor.backspace();
    harness.editor.render();
    expect(harness.output.startsWith("\x1b[1A\r\x1b[0J")).toBe(true);
    expect(harness.output).toContain("❯ one\r\n  tw");
  });

  it("erase() clears the region and finish() steps past it", () => {
    const harness = makeEditor();
    harness.editor.insertText("abc");
    harness.editor.render();
    harness.reset();
    harness.editor.erase();
    expect(harness.output).toBe("\r\x1b[0J");
    expect(harness.editor.visible).toBe(false);

    harness.editor.render();
    harness.reset();
    harness.editor.finish();
    expect(harness.output).toBe("\r\n");
  });
});
