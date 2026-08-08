/**
 * The single owner of stdin and of the terminal's raw mode (P2-1).
 *
 * Before Phase 2 SIX places fought over stdin — `runRepl`'s readline,
 * `resumeSession`'s second readline, `approval-prompt.mjs`'s fallback
 * readline, `session-picker.mjs`'s own `setRawMode(true)`,
 * `secret-input.mjs`'s `listeners("data")` surgery, and `auth-cli.mjs`. Two of
 * them could be live at once, and that produced a REPL that simply stopped
 * responding:
 *
 *   resolveParkedApproval() → #continueParkedRounds() (detached) →
 *   approval.requested → approval-prompt calls rl.question() while the main
 *   loop's rl.question() is still pending. Node's readline drops the second
 *   callback on the floor (internal/readline/interface: `if (this[kQuestionCallback])`
 *   … the new callback is never stored) and readline/promises overwrites
 *   `kQuestionReject`, so the approval promise NEVER settles:
 *
 *     APPROVAL [y/n]? APPROVAL [y/n]?
 *     APPROVAL got: "y"
 *     after 300ms → approval: "y"  repl: "pending"     ← wedged forever
 *
 * Here that is structurally impossible: there is one key stream and one
 * *activity* reading it at a time. A `question()` from the REPL loop runs at
 * level 0; an interjection (approval, secret, picker) runs at level 1 and
 * PREEMPTS the level-0 prompt — the prompt's editor is erased, kept intact, and
 * repainted when the overlay finishes. Two overlays serialize FIFO. No promise
 * is ever dropped.
 *
 * Everything else in Phase 2 hangs off that single ownership: bracketed paste
 * (P2-3), Ctrl+C / Esc routed by state (P2-4), keystrokes typed during a turn
 * queued instead of echoed into the stream (P2-8), and persistent history
 * (P2-6).
 */

import { StringDecoder } from "node:string_decoder";
import { LineEditor } from "./line-editor.mjs";
import { createKeyDecoder } from "./key-decoder.mjs";
import { graphemes, terminalWidth, visibleWidth } from "./ansi.mjs";
import { renderCompletionMenu } from "./completion-menu.mjs";
import { sanitizeInline } from "./sanitize.mjs";

const ESC_FLUSH_MS = 25;

/** Split a multi-line prompt into the part printed once and the input prefix. */
export function splitPrompt(prompt) {
  const text = String(prompt ?? "");
  const index = text.lastIndexOf("\n");
  if (index === -1) return { header: "", prefix: text };
  return { header: `${text.slice(0, index)}\n`, prefix: text.slice(index + 1) };
}

export function createInputController(options = {}) {
  return new InputController(options);
}

export class InputController {
  constructor({
    input = process.stdin,
    output = process.stdout,
    completer = null,
    history = null,
    onInterrupt = null,
    onEscape = null,
    onEof = null,
    bracketedPaste = true
  } = {}) {
    this.input = input;
    this.output = output;
    this.completer = completer;
    this.history = history;
    this.onInterrupt = onInterrupt;
    this.onEscape = onEscape;
    this.onEof = onEof;
    this.useBracketedPaste = bracketedPaste;

    this.tty = Boolean(input?.isTTY && typeof input.setRawMode === "function");
    this.disposed = false;

    /** @type {object|null} the activity currently reading keys */
    this.current = null;
    /** @type {object[]} activities waiting for their turn (FIFO per level) */
    this.pending = [];
    /** @type {object[]} activities preempted by an overlay (LIFO) */
    this.suspendedStack = [];
    /** Keys typed while nothing was reading — replayed into the next prompt (P2-8). */
    this.queuedEvents = [];

    this.decoder = new StringDecoder("utf8");
    this.keys = createKeyDecoder();
    this.escTimer = null;
    this.wasRaw = input?.isRaw === true;
    this.started = false;
    this.ended = false;
    this.lineBuffer = "";
    /** True while a newline-less transient row (spinner) is on screen. */
    this.transientDirty = false;

    this.onData = (chunk) => this.#onData(chunk);
    this.onEnd = () => this.#onEnd();
  }

  /* ---------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------- */

  start() {
    if (this.started || this.disposed) return this;
    this.started = true;
    if (this.tty) {
      this.wasRaw = this.input.isRaw === true;
      try { this.input.setRawMode(true); } catch { /* ignore */ }
      if (this.useBracketedPaste) this.#raw("\x1b[?2004h");
    }
    this.input.on("data", this.onData);
    this.input.on("end", this.onEnd);
    // A resized window reflows every wrapped row, so the editor's record of
    // what it drew is stale — repaint from the current geometry.
    this.onResize = () => {
      const editor = this.current?.editor;
      if (!editor?.visible) return;
      editor.visible = false;
      editor.drawnCursorRow = 0;
      editor.render();
    };
    this.output?.on?.("resize", this.onResize);
    this.input.resume?.();
    return this;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.escTimer) { clearTimeout(this.escTimer); this.escTimer = null; }
    try { this.current?.editor?.erase?.(); } catch { /* ignore */ }
    this.input.removeListener?.("data", this.onData);
    this.input.removeListener?.("end", this.onEnd);
    if (this.onResize) this.output?.removeListener?.("resize", this.onResize);
    if (this.tty) {
      if (this.useBracketedPaste) this.#raw("\x1b[?2004l");
      try { this.input.setRawMode(this.wasRaw); } catch { /* ignore */ }
      // Erase whatever the spinner / prompt left on the current line so the
      // shell prompt after us starts clean.
      this.#raw("\r\x1b[2K");
    }
    try { this.input.pause?.(); } catch { /* ignore */ }
    const abort = new Error("Aborted with Ctrl+C");
    abort.name = "AbortError";
    for (const activity of [this.current, ...this.suspendedStack, ...this.pending]) {
      if (activity) { try { activity.reject(abort); } catch { /* ignore */ } }
    }
    this.current = null;
    this.suspendedStack = [];
    this.pending = [];
  }

  /* ---------------------------------------------------------------- *
   * Output
   * ---------------------------------------------------------------- */

  #raw(text) {
    try { this.output.write(text); } catch { /* ignore */ }
  }

  /**
   * Write around the active input region: erase it, write, repaint. Every
   * adapter that prints while a prompt is on screen must go through here, or
   * the editor's row bookkeeping desyncs from the terminal.
   */
  write(text) {
    const editor = this.current?.editor;
    // A transient row (spinner frame) has no trailing newline, so anything
    // written next would be appended to it — `… (0s)model waiting failed`.
    // Clear it first (P3b-2).
    const prefix = this.transientDirty ? "\r\x1b[2K" : "";
    this.transientDirty = false;
    if (!editor || !editor.visible) { this.#raw(`${prefix}${text}`); return; }
    editor.erase();
    this.#raw(text);
    editor.render();
  }

  /**
   * Write a row that will be overwritten by the next write (a spinner frame).
   * Refused while a prompt is on screen: a repainting spinner must never land
   * on top of an approval question the user is answering.
   */
  writeTransient(text) {
    const editor = this.current?.editor;
    if (editor?.visible) return false;
    this.#raw(`\r\x1b[2K${text}`);
    this.transientDirty = true;
    return true;
  }

  /** A `{ write }` sink other adapters can hold onto (e.g. interrupt.mjs). */
  get writer() {
    return {
      write: (text) => this.write(text),
      writeTransient: (text) => this.writeTransient(text),
      isTTY: this.output?.isTTY === true
    };
  }

  /* ---------------------------------------------------------------- *
   * Public prompt APIs
   * ---------------------------------------------------------------- */

  /**
   * Read one (possibly multi-line) input.
   *
   * @param {string|object} promptOrOptions
   * @returns {Promise<string|null>} null = EOF (Ctrl+D on an empty buffer)
   */
  question(promptOrOptions = "") {
    const options = typeof promptOrOptions === "string" ? { prompt: promptOrOptions } : (promptOrOptions ?? {});
    const {
      prompt = "",
      continuation = null,
      level = 0,
      history = level === 0,
      multiline = true,
      replayQueued = level === 0,
      // (textBeforeCursor) => { token, items, total } | null — the incremental
      // completion menu (P3b-7). It is drawn as the editor region's FOOTER, so
      // it repaints in place and leaves nothing in the scrollback; ↑↓ moves the
      // selection, Tab/Enter accepts it, Esc closes it and keeps the input.
      completions = null,
      menuWidth = null
    } = options;
    const { header, prefix } = splitPrompt(prompt);
    return this.#enqueue({
      kind: "line",
      level,
      header,
      prefix,
      completions,
      menuWidth,
      // Continuation rows are indented to the prompt's width so a multi-line
      // prompt reads as one block instead of re-printing the prompt per row.
      continuation: continuation ?? " ".repeat(visibleWidth(prefix)),
      history: history ? this.history : null,
      multiline,
      replayQueued
    });
  }

  /** Hidden input (API tokens). Never recorded in history. */
  readSecret({ prompt = "" } = {}) {
    return this.#enqueue({ kind: "secret", level: 1, prefix: prompt, header: "" });
  }

  /**
   * Take exclusive control of the key stream (session picker, y/n menus).
   *
   * @param {(key: object, api: { finish: (value?: unknown) => void, write: (text: string) => void }) => void} onKey
   * @param {{ onStart?: Function, onSuspend?: Function, onResume?: Function }} hooks
   */
  withExclusiveKeys(onKey, hooks = {}) {
    return this.#enqueue({ kind: "exclusive", level: 1, onKey, hooks });
  }

  /** Erase the active prompt's buffer (idle Ctrl+C / Esc). */
  clearInput() {
    const editor = this.current?.editor;
    if (!editor) { this.queuedEvents = []; return false; }
    if (editor.isEmpty) return false;
    editor.clear();
    // The slash menu belongs to the text that was just wiped.
    this.#refreshMenu(this.current, { render: false });
    editor.render();
    return true;
  }

  hasInput() {
    const editor = this.current?.editor;
    return Boolean(editor && !editor.isEmpty) || this.queuedEvents.length > 0;
  }

  /** True while a level-0 prompt is on screen (used for Ctrl+C state). */
  get isPrompting() {
    return Boolean(this.current && this.current.kind === "line");
  }

  /**
   * True while ANY activity owns the key stream — a prompt, an approval
   * overlay, a hidden secret, the session picker. Background writers (the
   * timeline spinner) check this so a repainting frame can never land on top
   * of something the user is answering (P3b-2).
   */
  get isReading() {
    return Boolean(this.current);
  }

  /* ---------------------------------------------------------------- *
   * Scheduling
   * ---------------------------------------------------------------- */

  #enqueue(spec) {
    if (this.disposed) return Promise.resolve(null);
    this.start();
    return new Promise((resolve, reject) => {
      const activity = { ...spec, resolve, reject, settled: false };
      activity.settle = (value) => {
        if (activity.settled) return;
        activity.settled = true;
        this.#detach(activity);
        resolve(value);
        this.#pump();
      };
      activity.fail = (error) => {
        if (activity.settled) return;
        activity.settled = true;
        this.#detach(activity);
        reject(error);
        this.#pump();
      };
      if (this.current && spec.level > this.current.level) {
        // Overlay preempts a base prompt: keep it intact, repaint later.
        const preempted = this.current;
        preempted.suspend?.();
        this.suspendedStack.push(preempted);
        this.current = null;
        this.#run(activity);
        return;
      }
      if (this.current) {
        this.pending.push(activity);
        return;
      }
      this.#run(activity);
    });
  }

  #detach(activity) {
    if (this.current === activity) this.current = null;
    this.pending = this.pending.filter((entry) => entry !== activity);
    this.suspendedStack = this.suspendedStack.filter((entry) => entry !== activity);
  }

  #pump() {
    if (this.disposed || this.current) return;
    const overlayIndex = this.pending.findIndex((entry) => entry.level > 0);
    if (overlayIndex >= 0) {
      this.#run(this.pending.splice(overlayIndex, 1)[0]);
      return;
    }
    if (this.suspendedStack.length > 0) {
      const activity = this.suspendedStack.pop();
      this.current = activity;
      activity.resume?.();
      return;
    }
    if (this.pending.length > 0) this.#run(this.pending.shift());
  }

  #run(activity) {
    this.current = activity;
    // Whatever transient row was on screen is about to be repainted over.
    this.transientDirty = false;
    if (activity.kind === "line") this.#startLine(activity);
    else if (activity.kind === "secret") this.#startSecret(activity);
    else this.#startExclusive(activity);
  }

  /* ---------------------------------------------------------------- *
   * Activity: line editor
   * ---------------------------------------------------------------- */

  #startLine(activity) {
    const editor = new LineEditor({
      write: (text) => this.#raw(text),
      prompt: activity.prefix,
      // The static part of a multi-line prompt is drawn INSIDE the region, so
      // a repaint rewrites it in place instead of scrolling a new copy in.
      header: this.tty ? activity.header : "",
      continuation: activity.continuation,
      width: () => terminalWidth(this.output),
      tty: this.tty
    });
    activity.editor = editor;
    activity.suspend = () => { editor.erase(); };
    activity.resume = () => { editor.render(); };
    activity.history?.reset?.();
    if (!this.tty) {
      // Piped stdin: no editing, just hand over whole lines.
      this.#raw(activity.prefix);
      this.#drainLines();
      return;
    }
    this.#refreshMenu(activity, { render: false });
    editor.render();
    if (activity.replayQueued && this.queuedEvents.length > 0) {
      const queued = this.queuedEvents;
      this.queuedEvents = [];
      for (const event of queued) {
        if (activity.settled) break;
        this.#dispatch(event);
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * Completion menu (P3b-7)
   * ---------------------------------------------------------------- */

  /** The text the completer sees: this row, up to the cursor. */
  #textBeforeCursor(editor) {
    const line = editor.lines[editor.row] ?? "";
    return graphemes(line).slice(0, editor.col).join("");
  }

  /**
   * Recompute the menu after every keystroke, so it opens the moment `/` (or
   * `@`) is typed and narrows live as more characters arrive. A no-op when the
   * rows did not change, so an ordinary keystroke still costs one repaint.
   */
  #refreshMenu(activity, { render = true } = {}) {
    if (!activity?.completions || activity.settled || !this.tty) return;
    const editor = activity.editor;
    if (!editor) return;
    let next;
    try { next = activity.completions(this.#textBeforeCursor(editor)); } catch { next = null; }
    const previous = activity.menu;
    if (!next || !Array.isArray(next.items) || next.items.length === 0) {
      activity.menu = null;
    } else if (next.token === activity.dismissedToken) {
      // Closed with Esc and nothing has been typed since — stay closed.
      activity.menu = null;
    } else {
      const keepSelection = previous && previous.token === next.token
        ? Math.min(previous.selected, next.items.length - 1)
        : 0;
      activity.menu = { ...next, selected: keepSelection };
      if (next.token !== activity.dismissedToken) activity.dismissedToken = null;
    }
    const footer = activity.menu
      ? renderCompletionMenu({
        items: activity.menu.items,
        selected: activity.menu.selected,
        total: activity.menu.total,
        width: activity.menuWidth ?? terminalWidth(this.output),
        color: this.output?.isTTY === true
      })
      : "";
    if (footer === editor.footer) return;
    editor.footer = footer;
    if (render && editor.visible) editor.render();
  }

  #repaintMenu(activity) {
    const editor = activity.editor;
    editor.footer = activity.menu
      ? renderCompletionMenu({
        items: activity.menu.items,
        selected: activity.menu.selected,
        total: activity.menu.total,
        width: activity.menuWidth ?? terminalWidth(this.output),
        color: this.output?.isTTY === true
      })
      : "";
    editor.render();
  }

  /** Replace the token under the cursor with the highlighted candidate. */
  #acceptCompletion(activity) {
    const editor = activity.editor;
    const menu = activity.menu;
    const item = menu.items[menu.selected];
    if (!item) return;
    const cells = graphemes(editor.lines[editor.row] ?? "");
    const before = cells.slice(0, editor.col).join("");
    const after = cells.slice(editor.col).join("");
    const stem = before.slice(0, before.length - menu.token.length);
    editor.lines[editor.row] = `${stem}${item.value}${after}`;
    editor.col = graphemes(`${stem}${item.value}`).length;
    activity.dismissedToken = null;
    // A directory (`@src/`) re-opens with its children; a finished command
    // closes the menu because the source stops matching.
    this.#refreshMenu(activity, { render: false });
    editor.render();
  }

  #submit(activity) {
    const editor = activity.editor;
    const value = editor.value;
    if (editor.footer !== "") {
      // Drop the menu before the input scrolls away, or it would be left
      // behind above the answer.
      editor.footer = "";
      editor.render();
    }
    editor.finish();
    if (activity.history) activity.history.record(value);
    activity.settle(value);
  }

  #handleLineKey(activity, event) {
    const editor = activity.editor;
    if (event.type === "paste") {
      // A bracketed paste is ONE input: embedded newlines extend the buffer
      // instead of submitting N turns (P2-3).
      editor.insertText(event.text);
      editor.render();
      return;
    }
    if (event.type === "text") {
      editor.insertText(event.text);
      editor.render();
      return;
    }
    const { name, ctrl, meta } = event;

    // --- completion menu (P3b-7) -----------------------------------------
    // While the menu is open it owns ↑↓ / Tab / Enter / Esc. Ctrl+C and
    // Ctrl+D are deliberately NOT intercepted: interrupt and EOF keep their
    // meaning whatever is on screen.
    if (activity.menu && !ctrl) {
      if (name === "up") {
        activity.menu.selected = (activity.menu.selected - 1 + activity.menu.items.length) % activity.menu.items.length;
        this.#repaintMenu(activity);
        return;
      }
      if (name === "down") {
        activity.menu.selected = (activity.menu.selected + 1) % activity.menu.items.length;
        this.#repaintMenu(activity);
        return;
      }
      if (name === "tab" || (name === "return" && !meta)) {
        this.#acceptCompletion(activity);
        return;
      }
      if (name === "escape") {
        // Close the menu, keep every character the user typed.
        activity.dismissedToken = activity.menu.token;
        activity.menu = null;
        this.#repaintMenu(activity);
        return;
      }
    }

    // --- submit / newline ------------------------------------------------
    if (name === "return" && !meta) {
      if (activity.multiline && editor.endsWithContinuation()) {
        editor.applyContinuation();
        editor.render();
        return;
      }
      this.#submit(activity);
      return;
    }
    if ((name === "return" && meta) || name === "linefeed" || (name === "j" && ctrl)) {
      // Esc+Enter (macOS Option+Enter / the /terminal-setup Shift+Enter
      // binding) and Ctrl+J both mean "newline, keep editing".
      if (!activity.multiline) { this.#submit(activity); return; }
      editor.newline();
      editor.render();
      return;
    }

    // --- interrupt / EOF -------------------------------------------------
    if (name === "c" && ctrl) {
      if (activity.level > 0) {
        const error = new Error("Aborted with Ctrl+C");
        error.name = "AbortError";
        editor.erase();
        activity.fail(error);
        return;
      }
      this.onInterrupt?.();
      return;
    }
    if (name === "d" && ctrl) {
      if (editor.isEmpty) {
        if (activity.level > 0) {
          // Ctrl+D at an approval / setup prompt cancels THAT prompt; it must
          // not take the whole session down with it.
          const error = new Error("Aborted with Ctrl+D");
          error.name = "AbortError";
          editor.erase();
          activity.fail(error);
          return;
        }
        editor.finish();
        activity.settle(null);
        this.onEof?.();
        return;
      }
      if (editor.deleteForward()) editor.render();
      return;
    }
    if (name === "escape") {
      if (activity.level > 0) {
        const error = new Error("Aborted with Ctrl+C");
        error.name = "AbortError";
        editor.erase();
        activity.fail(error);
        return;
      }
      this.onEscape?.();
      return;
    }

    // --- editing ---------------------------------------------------------
    if (name === "backspace") {
      if (meta) editor.deleteWordBefore();
      else editor.backspace();
      editor.render();
      return;
    }
    if (name === "delete") { editor.deleteForward(); editor.render(); return; }
    if (name === "w" && ctrl) { editor.deleteWordBefore(); editor.render(); return; }
    if (name === "k" && ctrl) { editor.killToEnd(); editor.render(); return; }
    if (name === "u" && ctrl) { editor.killToStart(); editor.render(); return; }
    if (name === "a" && ctrl) { editor.moveHome(); editor.render(); return; }
    if (name === "e" && ctrl) { editor.moveEnd(); editor.render(); return; }
    if (name === "l" && ctrl) {
      editor.erase();
      this.#raw("\x1b[2J\x1b[H");
      editor.visible = false;
      editor.render();
      return;
    }
    if (name === "b" && ctrl) { editor.moveLeft(); editor.render(); return; }
    if (name === "f" && ctrl) { editor.moveRight(); editor.render(); return; }
    if (name === "home") { editor.moveHome(); editor.render(); return; }
    if (name === "end") { editor.moveEnd(); editor.render(); return; }
    if (name === "left") {
      if (ctrl || meta) editor.moveWordLeft(); else editor.moveLeft();
      editor.render();
      return;
    }
    if (name === "right") {
      if (ctrl || meta) editor.moveWordRight(); else editor.moveRight();
      editor.render();
      return;
    }
    if ((name === "b" || name === "f") && meta) {
      if (name === "b") editor.moveWordLeft(); else editor.moveWordRight();
      editor.render();
      return;
    }
    if (name === "up") {
      if (editor.moveUp()) { editor.render(); return; }
      this.#historyStep(activity, -1);
      return;
    }
    if (name === "down") {
      if (editor.moveDown()) { editor.render(); return; }
      this.#historyStep(activity, 1);
      return;
    }
    if (name === "tab") {
      this.#complete(activity);
      return;
    }
    // Unknown key: ignore (never echo raw escape bytes into the buffer).
  }

  #historyStep(activity, direction) {
    const history = activity.history;
    if (!history) return;
    const editor = activity.editor;
    const value = direction < 0 ? history.previous(editor.value) : history.next();
    if (value == null) return;
    editor.value = value;
    editor.render();
  }

  /**
   * Tab completion. The completer sees the text BEFORE the cursor on the
   * current logical line (readline's contract), and `head` is the token it
   * matched — so the replacement swaps just that token, leaving the rest of
   * the line and the other rows untouched.
   */
  #complete(activity) {
    const editor = activity.editor;
    if (typeof this.completer !== "function") return;
    const line = editor.lines[editor.row] ?? "";
    const cells = [...line];
    const before = cells.slice(0, editor.col).join("");
    const after = cells.slice(editor.col).join("");
    let result;
    try { result = this.completer(before); } catch { return; }
    const [matches, head] = Array.isArray(result) ? result : [[], before];
    if (!Array.isArray(matches) || matches.length === 0) return;
    const token = String(head ?? "");
    const stem = before.slice(0, before.length - token.length);
    const replacement = matches.length === 1 ? matches[0] : commonPrefix(matches);
    if (replacement.length > token.length) {
      editor.lines[editor.row] = stem + replacement + after;
      editor.col = [...(stem + replacement)].length;
    }
    // Tab with several candidates dumps the list into the scrollback. The
    // candidates are directory entries, and a file name may contain any byte
    // but `/` and NUL — so sanitise the *display*. The buffer keeps the raw
    // match (line 689): what we insert has to stay byte-exact or the path
    // would no longer resolve.
    if (matches.length > 1) this.write(`${matches.map((match) => sanitizeInline(match)).join("  ")}\n`);
    else editor.render();
  }

  /* ---------------------------------------------------------------- *
   * Activity: hidden secret
   * ---------------------------------------------------------------- */

  #startSecret(activity) {
    activity.value = "";
    activity.suspend = () => {};
    activity.resume = () => { this.#raw(activity.prefix); };
    this.#raw(activity.prefix);
    if (!this.tty) this.#drainLines();
  }

  #handleSecretKey(activity, event) {
    if (event.type === "text" || event.type === "paste") {
      activity.value += event.text;
      return;
    }
    const { name, ctrl } = event;
    if (name === "return" || name === "linefeed") {
      this.#raw("\n");
      activity.settle(activity.value);
      return;
    }
    if (name === "backspace") {
      activity.value = activity.value.slice(0, -1);
      return;
    }
    if ((name === "c" && ctrl) || name === "escape") {
      this.#raw("\n");
      activity.fail(new Error("Secret input cancelled"));
      return;
    }
    if (name === "d" && ctrl && activity.value === "") {
      this.#raw("\n");
      activity.fail(new Error("Secret input cancelled"));
    }
  }

  /* ---------------------------------------------------------------- *
   * Activity: exclusive keys
   * ---------------------------------------------------------------- */

  #startExclusive(activity) {
    activity.api = {
      finish: (value) => activity.settle(value),
      fail: (error) => activity.fail(error),
      write: (text) => this.#raw(text)
    };
    activity.suspend = () => { activity.hooks?.onSuspend?.(activity.api); };
    activity.resume = () => { activity.hooks?.onResume?.(activity.api); };
    try {
      activity.hooks?.onStart?.(activity.api);
    } catch (error) {
      activity.fail(error);
    }
  }

  /* ---------------------------------------------------------------- *
   * Key stream
   * ---------------------------------------------------------------- */

  #onData(chunk) {
    if (this.disposed) return;
    const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    if (text === "") return;
    if (!this.tty) { this.#feedLines(text); return; }
    const events = this.keys.push(text);
    for (const event of events) this.#dispatch(event);
    this.#scheduleEscFlush();
  }

  #scheduleEscFlush() {
    if (this.escTimer) { clearTimeout(this.escTimer); this.escTimer = null; }
    if (!this.keys || this.keys.pendingText === "") return;
    this.escTimer = setTimeout(() => {
      this.escTimer = null;
      if (this.disposed) return;
      for (const event of this.keys.flush()) this.#dispatch(event);
    }, ESC_FLUSH_MS);
    this.escTimer.unref?.();
  }

  #dispatch(event) {
    const activity = this.current;
    if (!activity) {
      this.#dispatchIdle(event);
      return;
    }
    if (activity.kind === "line") {
      this.#handleLineKey(activity, event);
      this.#refreshMenu(activity);
    }
    else if (activity.kind === "secret") this.#handleSecretKey(activity, event);
    else if (activity.kind === "exclusive") {
      try { activity.onKey?.(event, activity.api); } catch (error) { activity.fail(error); }
    }
  }

  /**
   * Nothing is reading — a turn is running (P2-8). Ctrl+C / Ctrl+D / Esc must
   * still act immediately; everything else is queued and replayed into the
   * next prompt instead of being echoed into the streaming output and lost.
   */
  #dispatchIdle(event) {
    if (event.type === "key") {
      const { name, ctrl } = event;
      if (name === "c" && ctrl) { this.onInterrupt?.(); return; }
      if (name === "escape") { this.onEscape?.(); return; }
      if (name === "d" && ctrl && this.queuedEvents.length === 0) { this.onEof?.(); return; }
      if (name === "return" || name === "linefeed") {
        // Keep it: the queued text is submitted with the next prompt.
        this.queuedEvents.push(event);
        return;
      }
    }
    if (this.queuedEvents.length < 500) this.queuedEvents.push(event);
  }

  /* ---------------------------------------------------------------- *
   * Non-TTY (piped stdin) fallback
   * ---------------------------------------------------------------- */

  #feedLines(text) {
    this.lineBuffer += text;
    this.#drainLines();
  }

  #drainLines() {
    while (this.current && (this.current.kind === "line" || this.current.kind === "secret")) {
      const index = this.lineBuffer.indexOf("\n");
      if (index === -1) break;
      const line = this.lineBuffer.slice(0, index).replace(/\r$/, "");
      this.lineBuffer = this.lineBuffer.slice(index + 1);
      const activity = this.current;
      if (activity.kind === "secret") {
        activity.settle(line);
      } else {
        activity.history?.record?.(line);
        activity.settle(line);
      }
    }
    if (this.ended) this.#resolveEof();
  }

  #onEnd() {
    this.ended = true;
    const tail = this.decoder.end();
    if (tail) this.lineBuffer += tail;
    if (this.lineBuffer !== "" && !this.lineBuffer.endsWith("\n")) this.lineBuffer += "\n";
    this.#drainLines();
    this.#resolveEof();
  }

  #resolveEof() {
    const activity = this.current;
    if (!activity) { this.onEof?.(); return; }
    if (activity.kind === "line") {
      activity.settle(null);
      this.onEof?.();
      return;
    }
    if (activity.kind === "secret") activity.fail(new Error("Secret input cancelled"));
  }
}

function commonPrefix(values) {
  if (values.length === 0) return "";
  let prefix = values[0];
  for (const value of values.slice(1)) {
    let index = 0;
    while (index < prefix.length && index < value.length && prefix[index] === value[index]) index += 1;
    prefix = prefix.slice(0, index);
    if (prefix === "") break;
  }
  return prefix;
}
