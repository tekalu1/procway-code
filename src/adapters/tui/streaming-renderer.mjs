import {
  renderMarkdown,
  renderMarkdownBlocks,
  splitReadyBlocks,
  trimTrailingNewlines
} from "./markdown-render.mjs";
import { supportsColor, terminalWidth } from "./ansi.mjs";

/**
 * StreamingRenderer — accumulates `assistant.message.delta` chunks and writes
 * Markdown-rendered output to a single sink. ALL writes coming from the
 * streaming path flow through this object's `write` boundary, which is the
 * key invariant that prevents the spinner/streaming race that caused
 * hotfix 294f143.
 *
 * ## Live output === replayed output (Phase 3c)
 *
 * The renderer used to cut its buffer at the last newline and hand each
 * fragment to `renderMarkdown()`. That function renders a *whole document*
 * (it emits block separators and the trailing blank of the phantom final
 * line), so every fragment added blank lines: a heading + a two-item list
 * streamed with one blank line per chunk boundary, while the same message
 * replayed by `procway-code resume` had none. Same text, two renderings.
 *
 * Now the split happens on *block* boundaries (`splitReadyBlocks`) and the
 * blocks are rendered with `renderMarkdownBlocks` — the very function
 * `renderMarkdown` is built from. Because blocks render independently,
 * emitting a prefix now and the rest later is byte-identical to one shot, so
 * for any chunking of any message:
 *
 *   live output === trimTrailingNewlines(renderMarkdown(fullText)) + "\n\n"
 *
 * and the right-hand side is exactly what `renderTranscriptNode` writes for
 * the `assistant` node on every replay route (plus its "Assistant:" label).
 * The trailing "\n\n" is the one blank line that separates the message from
 * the next prompt — the same separator the transcript uses between nodes.
 *
 * A consequence worth stating: a block only reaches the screen once it cannot
 * change any more. Paragraphs, tables, quotes and open ``` fences therefore
 * wait for the line that closes them (that last one is the Phase 5 §2.4 rule:
 * rendering a half-finished fence emits truncated ANSI runs). Headings,
 * rules, closed fences and *individual list items* flush immediately, so the
 * perceived latency is unchanged from the old newline-cut behaviour — model
 * output arrives one line at a time anyway.
 *
 * Usage:
 *   const renderer = createStreamingRenderer({ writer: process.stdout, width });
 *   renderer.attach(events);
 *   ... session.runTurn(...)
 *   renderer.detach();
 */
export function createStreamingRenderer({
  writer = process.stdout,
  width = terminalWidth(writer),
  // P1-3: one colour decision for the whole TUI. `supportsColor` folds in
  // NO_COLOR / FORCE_COLOR / TERM=dumb on top of the isTTY check.
  colorize = supportsColor(writer),
  // P3d-3: OSC 8 links. Resolved once by the caller (`resolveHyperlinks`) and
  // handed to BOTH the live and the replay renderer — deciding per-renderer
  // would break the byte-for-byte parity asserted below.
  hyperlinks = false
} = {}) {
  return new StreamingRenderer({ writer, width, colorize, hyperlinks });
}

export class StreamingRenderer {
  constructor({ writer, width, colorize, hyperlinks = false }) {
    this.writer = writer;
    this.width = width;
    this.colorize = colorize;
    this.hyperlinks = hyperlinks;
    this.bus = null;
    this.subscriptions = [];
    this.buffer = "";
    this.streaming = false;
    this.firstWrite = true;
    this.producedOutput = false;
    /** Did this message already put a rendered block on screen? */
    this.wroteBody = false;
  }

  attach(bus) {
    if (!bus) return this;
    this.bus = bus;
    this.subscribe("user.prompt.submitted", () => this.resetOutputTracking());
    this.subscribe("assistant.message.delta", (event) => this.#onDelta(event));
    this.subscribe("assistant.message.completed", (event) => this.#onCompleted(event));
    this.subscribe("turn.failed", () => this.#onTurnEnd("failed"));
    this.subscribe("turn.completed", () => this.#onTurnEnd("completed"));
    return this;
  }

  detach() {
    if (!this.bus) return;
    for (const { type, handler } of this.subscriptions) this.bus.off(type, handler);
    this.subscriptions = [];
    this.bus = null;
  }

  subscribe(type, handler) {
    this.bus.on(type, handler);
    this.subscriptions.push({ type, handler });
  }

  /** SIGWINCH (P3b-11): reflow the Markdown at the new terminal width. */
  setWidth(width) {
    const next = Number(width);
    if (Number.isFinite(next) && next > 0) this.width = next;
    return this.width;
  }

  isStreaming() {
    return this.streaming;
  }

  hadOutput() {
    return this.streaming || this.buffer.length > 0 || this.producedOutput;
  }

  resetOutputTracking() {
    this.producedOutput = false;
  }

  #onDelta(event) {
    const text = event?.deltaText;
    if (typeof text !== "string" || text.length === 0) return;
    this.streaming = true;
    if (this.firstWrite) {
      // The timeline renderer clears the spinner when delta arrives — write
      // a leading marker on its own so the streamed text starts at column 0.
      this.firstWrite = false;
    }
    this.buffer += text;
    this.#flushReadyBlocks();
  }

  /**
   * End of message. Whatever is left in the buffer is a complete document
   * tail, so it goes through `renderMarkdown` — and its trailing blank line
   * is trimmed, because the replayed transcript node is trimmed too. The one
   * remaining "\n" is the blank line before the next prompt.
   */
  #onCompleted() {
    if (!this.streaming) return;
    this.#flushReadyBlocks();
    const tail = trimTrailingNewlines(
      renderMarkdown(this.buffer, {
        width: this.width,
        color: this.colorize,
        hyperlinks: this.hyperlinks
      })
    );
    this.buffer = "";
    if (tail.length > 0) {
      this.producedOutput = true;
      this.wroteBody = true;
      this.writer.write(`${tail}\n`);
    }
    // A message that rendered to nothing at all (whitespace only) still owes
    // the "block end" newline, or the invariant above would not hold for it.
    if (!this.wroteBody) this.writer.write("\n");
    this.writer.write("\n");
    this.streaming = false;
    this.firstWrite = true;
    this.wroteBody = false;
  }

  #onTurnEnd() {
    if (this.streaming) {
      this.#onCompleted();
    } else {
      this.firstWrite = true;
    }
  }

  /** Drain every block that can no longer change out of `this.buffer`. */
  #flushReadyBlocks() {
    const { blocks, rest } = splitReadyBlocks(this.buffer);
    this.buffer = rest;
    if (blocks.length === 0) return;
    const rendered = renderMarkdownBlocks(blocks, {
      width: this.width,
      color: this.colorize,
      hyperlinks: this.hyperlinks
    });
    if (rendered.length === 0) return;
    this.producedOutput = true;
    this.wroteBody = true;
    this.writer.write(rendered);
  }
}
