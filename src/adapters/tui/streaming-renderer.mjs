import { renderMarkdown } from "./markdown-render.mjs";

/**
 * StreamingRenderer — accumulates `assistant.message.delta` chunks and writes
 * Markdown-rendered output to a single sink. ALL writes coming from the
 * streaming path flow through this object's `write` boundary, which is the
 * key invariant that prevents the spinner/streaming race that caused
 * hotfix 294f143.
 *
 * Phase 5 §2.4: code-block ranges are buffered until the closing fence is
 * seen, since rendering a half-finished ``` block would emit truncated ANSI
 * colour runs.
 *
 * Usage:
 *   const renderer = createStreamingRenderer({ writer: process.stdout, width });
 *   renderer.attach(events);
 *   ... session.runTurn(...)
 *   renderer.detach();
 *
 * The renderer is also a no-op when `writer.isTTY === false` and
 * `colorize !== true`, which keeps headless / CI runs clean.
 */
export function createStreamingRenderer({
  writer = process.stdout,
  width = writer?.columns ?? 80,
  colorize = writer?.isTTY === true
} = {}) {
  return new StreamingRenderer({ writer, width, colorize });
}

export class StreamingRenderer {
  constructor({ writer, width, colorize }) {
    this.writer = writer;
    this.width = width;
    this.colorize = colorize;
    this.bus = null;
    this.subscriptions = [];
    this.buffer = "";
    this.codeBlockOpen = false;
    this.streaming = false;
    this.firstWrite = true;
    this.producedOutput = false;
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

  #onCompleted() {
    if (!this.streaming) return;
    this.#flushReadyBlocks({ final: true });
    if (this.buffer.length > 0) {
      this.#writeRendered(this.buffer);
      this.buffer = "";
    }
    if (this.streaming) this.writer.write("\n");
    this.streaming = false;
    this.firstWrite = true;
    this.codeBlockOpen = false;
  }

  #onTurnEnd() {
    if (this.streaming) {
      this.#onCompleted();
    } else {
      this.firstWrite = true;
    }
  }

  /**
   * Drain whole "renderable units" out of `this.buffer`:
   *
   * - When we are NOT inside a code block: every fully-terminated newline
   *   chunk before an unclosed ``` is rendered immediately.
   * - When we hit ```: stop flushing, mark `codeBlockOpen` and wait for the
   *   matching fence. On close, render the whole code block at once.
   * - On `final: true` we render whatever remains.
   */
  #flushReadyBlocks({ final = false } = {}) {
    while (this.buffer.length > 0) {
      if (!this.codeBlockOpen) {
        const fenceIndex = this.buffer.indexOf("```");
        if (fenceIndex === -1) {
          const lastNewline = this.buffer.lastIndexOf("\n");
          if (lastNewline === -1) {
            if (final) {
              this.#writeRendered(this.buffer);
              this.buffer = "";
            }
            return;
          }
          const head = this.buffer.slice(0, lastNewline + 1);
          const tail = this.buffer.slice(lastNewline + 1);
          this.#writeRendered(head);
          this.buffer = tail;
          if (!final) return;
          if (this.buffer.length > 0) {
            this.#writeRendered(this.buffer);
            this.buffer = "";
          }
          return;
        }
        if (fenceIndex > 0) {
          const head = this.buffer.slice(0, fenceIndex);
          this.#writeRendered(head);
          this.buffer = this.buffer.slice(fenceIndex);
        }
        this.codeBlockOpen = true;
        continue;
      }
      // Inside a code block — look for the closing fence after the opener.
      const closeIndex = this.buffer.indexOf("\n```", 3);
      if (closeIndex === -1) {
        if (final) {
          this.#writeRendered(this.buffer);
          this.buffer = "";
          this.codeBlockOpen = false;
        }
        return;
      }
      const fenceEnd = this.buffer.indexOf("\n", closeIndex + 1);
      const cutEnd = fenceEnd === -1 ? this.buffer.length : fenceEnd + 1;
      const block = this.buffer.slice(0, cutEnd);
      this.#writeRendered(block);
      this.buffer = this.buffer.slice(cutEnd);
      this.codeBlockOpen = false;
    }
  }

  #writeRendered(chunk) {
    if (!chunk) return;
    this.producedOutput = true;
    if (!this.colorize) {
      this.writer.write(chunk);
      return;
    }
    const rendered = renderMarkdown(chunk, { width: this.width, color: true });
    this.writer.write(rendered);
  }
}
