/**
 * Multi-line raw-mode line editor (P2-2).
 *
 * readline gives one logical line and repaints the WHOLE prompt on every
 * keystroke — with the two-line `╭─ …/╰─❯ ` prompt that meant a stray
 * `╭─ ai-agent …` header per backspace, and its cursor maths counts UTF-16
 * code units, so a Japanese line desynced the cursor from the glyphs. This
 * editor owns a `string[]` of logical lines instead and repaints only the
 * region it drew, measuring every column with ansi.mjs `visibleWidth` /
 * `graphemes`.
 *
 * `layout()` is exported separately and is pure: tests assert the wrapped rows
 * and the (row, col) cursor without a terminal.
 */

import { graphemes, visibleWidth } from "./ansi.mjs";

/**
 * Wrap `lines` into terminal rows and locate the cursor.
 *
 * Wrapping happens at `width - 1` columns so a row never fills the last cell:
 * writing INTO the final column arms the terminal's deferred wrap, and the
 * `\r\n` we emit next would then land a row too low.
 *
 * @param {{ lines: string[], row: number, col: number, prompt?: string,
 *           continuation?: string, width?: number }} state
 * @returns {{ rows: string[], cursorRow: number, cursorCol: number }}
 */
export function layout({ lines, row = 0, col = 0, prompt = "", continuation = "", width = 80, header = "", footer = "" }) {
  const limit = Math.max(8, (Number(width) || 80) - 1);
  // Header rows (the `╭─ workspace provider:model` line) are part of the
  // region so a repaint rewrites them IN PLACE. readline instead re-emitted
  // the whole two-line prompt on every keystroke, which is why a backspace
  // used to scroll a fresh `╭─ ai-agent …` into the transcript.
  const rows = header === "" ? [] : header.replace(/\n$/, "").split("\n");
  const headerRows = rows.length;
  let cursorRow = headerRows;
  let cursorCol = visibleWidth(prompt);

  const source = lines.length > 0 ? lines : [""];
  for (let index = 0; index < source.length; index += 1) {
    const prefix = index === 0 ? prompt : continuation;
    let text = prefix;
    let used = visibleWidth(prefix);
    if (index === row && col <= 0) {
      cursorRow = rows.length;
      cursorCol = used;
    }
    const cells = graphemes(source[index]);
    for (let cell = 0; cell < cells.length; cell += 1) {
      const cellWidth = visibleWidth(cells[cell]);
      if (used + cellWidth > limit && used > 0) {
        rows.push(text);
        text = "";
        used = 0;
      }
      text += cells[cell];
      used += cellWidth;
      if (index === row && col === cell + 1) {
        cursorRow = rows.length;
        cursorCol = used;
      }
    }
    rows.push(text);
  }
  // Footer rows (the incremental slash menu, P3b-7) live INSIDE the region
  // below the input, so a repaint rewrites them in place and erasing the
  // prompt takes them with it. The cursor stays on an input row, and
  // `render()` already walks back up from the last row.
  if (footer !== "") {
    for (const line of String(footer).replace(/\n$/, "").split("\n")) rows.push(line);
  }
  return { rows, cursorRow, cursorCol };
}

const WORD_RE = /[\p{L}\p{N}_]/u;

export class LineEditor {
  /**
   * @param {{ write?: (text: string) => void, prompt?: string,
   *           continuation?: string, width?: () => number, tty?: boolean }} options
   */
  constructor({ write = () => {}, prompt = "", continuation = "", width = () => 80, tty = true, header = "", footer = "" } = {}) {
    this.writeOut = write;
    this.prompt = prompt;
    this.header = header;
    /** Extra rows drawn below the input (the incremental slash menu). */
    this.footer = footer;
    this.continuation = continuation;
    this.widthOf = typeof width === "function" ? width : () => Number(width) || 80;
    this.tty = tty;
    this.lines = [""];
    this.row = 0;
    this.col = 0;
    this.drawnRows = 0;
    this.drawnCursorRow = 0;
    this.visible = false;
  }

  /* ---------------------------------------------------------------- *
   * Buffer state
   * ---------------------------------------------------------------- */

  get value() {
    return this.lines.join("\n");
  }

  set value(text) {
    this.lines = String(text ?? "").split("\n");
    if (this.lines.length === 0) this.lines = [""];
    this.row = this.lines.length - 1;
    this.col = graphemes(this.lines[this.row]).length;
  }

  get isEmpty() {
    return this.lines.length === 1 && this.lines[0] === "";
  }

  #cells(row = this.row) {
    return graphemes(this.lines[row] ?? "");
  }

  #setLine(row, cells) {
    this.lines[row] = cells.join("");
  }

  /* ---------------------------------------------------------------- *
   * Editing primitives — every one is grapheme-indexed
   * ---------------------------------------------------------------- */

  insertText(text) {
    const value = String(text ?? "").replace(/\r\n?/g, "\n");
    if (value === "") return;
    const parts = value.split("\n");
    for (let index = 0; index < parts.length; index += 1) {
      if (index > 0) this.newline();
      const chunk = parts[index];
      if (chunk === "") continue;
      const cells = this.#cells();
      cells.splice(this.col, 0, ...graphemes(chunk));
      this.#setLine(this.row, cells);
      this.col += graphemes(chunk).length;
    }
  }

  newline() {
    const cells = this.#cells();
    const head = cells.slice(0, this.col).join("");
    const tail = cells.slice(this.col).join("");
    this.lines.splice(this.row, 1, head, tail);
    this.row += 1;
    this.col = 0;
  }

  /** Backspace. Joins with the previous line when the cursor is at column 0. */
  backspace() {
    if (this.col > 0) {
      const cells = this.#cells();
      cells.splice(this.col - 1, 1);
      this.#setLine(this.row, cells);
      this.col -= 1;
      return true;
    }
    if (this.row === 0) return false;
    const previous = this.#cells(this.row - 1);
    const current = this.lines[this.row];
    this.lines.splice(this.row - 1, 2, previous.join("") + current);
    this.row -= 1;
    this.col = previous.length;
    return true;
  }

  deleteForward() {
    const cells = this.#cells();
    if (this.col < cells.length) {
      cells.splice(this.col, 1);
      this.#setLine(this.row, cells);
      return true;
    }
    if (this.row >= this.lines.length - 1) return false;
    this.lines.splice(this.row, 2, this.lines[this.row] + this.lines[this.row + 1]);
    return true;
  }

  /** Ctrl+W / Alt+Backspace — delete the word before the cursor. */
  deleteWordBefore() {
    if (this.col === 0) return this.backspace();
    const cells = this.#cells();
    let start = this.col;
    while (start > 0 && !WORD_RE.test(cells[start - 1])) start -= 1;
    while (start > 0 && WORD_RE.test(cells[start - 1])) start -= 1;
    cells.splice(start, this.col - start);
    this.#setLine(this.row, cells);
    this.col = start;
    return true;
  }

  /** Ctrl+K — kill to end of line (joins the next line when already at EOL). */
  killToEnd() {
    const cells = this.#cells();
    if (this.col < cells.length) {
      this.#setLine(this.row, cells.slice(0, this.col));
      return true;
    }
    return this.deleteForward();
  }

  /** Ctrl+U — kill to start of line. */
  killToStart() {
    const cells = this.#cells();
    this.#setLine(this.row, cells.slice(this.col));
    this.col = 0;
    return true;
  }

  /** Ctrl+C on an idle prompt: wipe the buffer but keep the prompt. */
  clear() {
    this.lines = [""];
    this.row = 0;
    this.col = 0;
  }

  moveLeft() {
    if (this.col > 0) { this.col -= 1; return true; }
    if (this.row === 0) return false;
    this.row -= 1;
    this.col = this.#cells().length;
    return true;
  }

  moveRight() {
    if (this.col < this.#cells().length) { this.col += 1; return true; }
    if (this.row >= this.lines.length - 1) return false;
    this.row += 1;
    this.col = 0;
    return true;
  }

  moveWordLeft() {
    if (this.col === 0) return this.moveLeft();
    const cells = this.#cells();
    let index = this.col;
    while (index > 0 && !WORD_RE.test(cells[index - 1])) index -= 1;
    while (index > 0 && WORD_RE.test(cells[index - 1])) index -= 1;
    this.col = index;
    return true;
  }

  moveWordRight() {
    const cells = this.#cells();
    if (this.col >= cells.length) return this.moveRight();
    let index = this.col;
    while (index < cells.length && !WORD_RE.test(cells[index])) index += 1;
    while (index < cells.length && WORD_RE.test(cells[index])) index += 1;
    this.col = index;
    return true;
  }

  moveUp() {
    if (this.row === 0) return false;
    this.row -= 1;
    this.col = Math.min(this.col, this.#cells().length);
    return true;
  }

  moveDown() {
    if (this.row >= this.lines.length - 1) return false;
    this.row += 1;
    this.col = Math.min(this.col, this.#cells().length);
    return true;
  }

  moveHome() {
    this.col = 0;
  }

  moveEnd() {
    this.col = this.#cells().length;
  }

  moveBufferStart() {
    this.row = 0;
    this.col = 0;
  }

  moveBufferEnd() {
    this.row = this.lines.length - 1;
    this.col = this.#cells().length;
  }

  /** True when the line under the cursor ends with an unescaped backslash. */
  endsWithContinuation() {
    const cells = this.#cells();
    if (this.col !== cells.length) return false;
    let backslashes = 0;
    for (let index = cells.length - 1; index >= 0 && cells[index] === "\\"; index -= 1) backslashes += 1;
    return backslashes % 2 === 1;
  }

  /** Consume the trailing `\` (the `\`+Enter continuation) and open a new line. */
  applyContinuation() {
    const cells = this.#cells();
    cells.splice(cells.length - 1, 1);
    this.#setLine(this.row, cells);
    this.col = cells.length;
    this.newline();
  }

  /* ---------------------------------------------------------------- *
   * Rendering
   * ---------------------------------------------------------------- */

  layout() {
    return layout({
      lines: this.lines,
      row: this.row,
      col: this.col,
      prompt: this.prompt,
      continuation: this.continuation,
      width: this.widthOf(),
      header: this.header,
      footer: this.footer
    });
  }

  /**
   * Repaint the region this editor owns. The cursor is assumed to sit where
   * the previous render left it (or at column 0 of a fresh line when nothing
   * has been drawn yet).
   */
  render() {
    if (!this.tty) return;
    const { rows, cursorRow, cursorCol } = this.layout();
    let out = "";
    if (this.visible && this.drawnCursorRow > 0) out += `\x1b[${this.drawnCursorRow}A`;
    out += "\r\x1b[0J";
    out += rows.join("\r\n");
    const up = rows.length - 1 - cursorRow;
    if (up > 0) out += `\x1b[${up}A`;
    out += "\r";
    if (cursorCol > 0) out += `\x1b[${cursorCol}C`;
    this.drawnRows = rows.length;
    this.drawnCursorRow = cursorRow;
    this.drawnCursorCol = cursorCol;
    this.visible = true;
    this.writeOut(out);
  }

  /** Erase the drawn region and park the cursor at its first column. */
  erase() {
    if (!this.tty || !this.visible) {
      this.visible = false;
      return;
    }
    let out = "";
    if (this.drawnCursorRow > 0) out += `\x1b[${this.drawnCursorRow}A`;
    out += "\r\x1b[0J";
    this.visible = false;
    this.drawnRows = 0;
    this.drawnCursorRow = 0;
    this.writeOut(out);
  }

  /** Leave the rendered text on screen and move past it (used on submit). */
  finish() {
    if (!this.tty) return;
    if (this.visible) {
      const down = Math.max(0, this.drawnRows - 1 - this.drawnCursorRow);
      let out = "";
      if (down > 0) out += `\x1b[${down}B`;
      out += "\r\n";
      this.writeOut(out);
    }
    this.visible = false;
    this.drawnRows = 0;
    this.drawnCursorRow = 0;
  }
}
