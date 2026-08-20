import { describe, expect, it } from "vitest";
import { EventBus } from "../src/core/events/bus.mjs";
import { createEvent } from "../src/core/events/types.mjs";
import { createStreamingRenderer } from "../src/adapters/tui/streaming-renderer.mjs";
import { renderMarkdown, trimTrailingNewlines } from "../src/adapters/tui/markdown-render.mjs";
import { renderTranscriptNode } from "../src/adapters/tui/transcript-node-render.mjs";
import { stripAnsi } from "../src/adapters/tui/ansi.mjs";

function makeWriter() {
  let buffer = "";
  return {
    isTTY: false,
    columns: 80,
    write(value) { buffer += value; return true; },
    get text() { return buffer; }
  };
}

function tick(bus, deltas, messageId = "m-1", sessionId = "s-1") {
  for (const text of deltas) {
    bus.emit(createEvent("assistant.message.delta", { sessionId, messageId, deltaText: text }));
  }
}

describe("streaming renderer (single-sink)", () => {
  it("appends text deltas to a single writer", () => {
    const writer = makeWriter();
    const bus = new EventBus();
    const renderer = createStreamingRenderer({ writer, colorize: false }).attach(bus);
    tick(bus, ["Hello ", "world\n"]);
    bus.emit(createEvent("assistant.message.completed", {
      sessionId: "s-1",
      messageId: "m-1",
      content: [{ kind: "text", text: "Hello world" }]
    }));
    expect(writer.text).toContain("Hello world");
    renderer.detach();
  });

  it("defers fenced code block rendering until the closing fence", () => {
    const writer = makeWriter();
    const bus = new EventBus();
    const renderer = createStreamingRenderer({ writer, colorize: false }).attach(bus);
    tick(bus, ["pre line\n", "```js\n", "const x = ", "1;\n"]);
    expect(writer.text).toContain("pre line");
    expect(writer.text).not.toContain("const x = 1;");
    tick(bus, ["```\n"]);
    bus.emit(createEvent("assistant.message.completed", {
      sessionId: "s-1",
      messageId: "m-1",
      content: [{ kind: "text", text: "ok" }]
    }));
    expect(writer.text).toContain("const x = 1;");
    renderer.detach();
  });

  it("ends a message with exactly one blank line (the transcript's node separator)", () => {
    const writer = makeWriter();
    const bus = new EventBus();
    const renderer = createStreamingRenderer({ writer, colorize: false }).attach(bus);
    tick(bus, ["partial line"]);
    bus.emit(createEvent("assistant.message.completed", {
      sessionId: "s-1",
      messageId: "m-1",
      content: [{ kind: "text", text: "partial line" }]
    }));
    // The body ends with its own "\n", then one blank line before the next
    // prompt — the same spacing `renderTranscriptNodes` puts between nodes.
    // (Before Phase 3c the no-colour path wrote the raw text through, so this
    // asserted "partial line\n" with no separator.)
    expect(writer.text).toBe("partial line\n\n");
    renderer.detach();
  });

  it("renders Markdown when colorize is true (single-sink integration)", () => {
    const writer = makeWriter();
    const bus = new EventBus();
    const renderer = createStreamingRenderer({ writer, colorize: true, width: 60 }).attach(bus);
    tick(bus, ["# Title\n", "and body **bold**\n"]);
    bus.emit(createEvent("assistant.message.completed", {
      sessionId: "s-1",
      messageId: "m-1",
      content: [{ kind: "text", text: "..." }]
    }));
    expect(writer.text).toContain("\x1b[1m");
    // Coloured headings carry their level through weight/colour, so the `#`
    // markers are dropped (they survive only in the no-colour form).
    expect(stripAnsi(writer.text)).toContain("Title");
    expect(stripAnsi(writer.text)).toContain("and body bold");
    renderer.detach();
  });

  it("survives consecutive delta events without races", () => {
    const writer = makeWriter();
    const bus = new EventBus();
    const renderer = createStreamingRenderer({ writer, colorize: false }).attach(bus);
    for (let i = 0; i < 100; i += 1) {
      bus.emit(createEvent("assistant.message.delta", { sessionId: "s-1", messageId: "m-1", deltaText: `chunk-${i}\n` }));
    }
    bus.emit(createEvent("assistant.message.completed", {
      sessionId: "s-1",
      messageId: "m-1",
      content: [{ kind: "text", text: "ok" }]
    }));
    expect(writer.text).toContain("chunk-0");
    expect(writer.text).toContain("chunk-99");
    renderer.detach();
  });

  it("hadOutput() stays true after streaming completes (so completion fallbacks skip)", () => {
    const writer = makeWriter();
    const bus = new EventBus();
    const renderer = createStreamingRenderer({ writer, colorize: false }).attach(bus);
    tick(bus, ["| a | b |\n", "|---|---|\n", "| 1 | 2 |\n"]);
    bus.emit(createEvent("assistant.message.completed", {
      sessionId: "s-1",
      messageId: "m-1",
      content: [{ kind: "text", text: "| a | b |\n|---|---|\n| 1 | 2 |\n" }]
    }));
    expect(renderer.isStreaming()).toBe(false);
    expect(renderer.hadOutput()).toBe(true);
    renderer.detach();
  });

  it("holds an open code fence, then emits it in one piece when it closes", () => {
    const writer = makeWriter();
    const bus = new EventBus();
    const renderer = createStreamingRenderer({ writer, colorize: true, width: 60 }).attach(bus);
    tick(bus, ["```js\n", "const x = 1;\n", "const y = 2;\n"]);
    // A half-rendered fence would emit truncated ANSI runs (Phase 5 §2.4).
    expect(stripAnsi(writer.text)).toBe("");
    tick(bus, ["```\n", "after\n\n"]);
    expect(stripAnsi(writer.text)).toContain("const x = 1;");
    expect(stripAnsi(writer.text)).toContain("└──");
    renderer.detach();
  });

  it("resets output tracking on user.prompt.submitted so subsequent turns can use the fallback", () => {
    const writer = makeWriter();
    const bus = new EventBus();
    const renderer = createStreamingRenderer({ writer, colorize: false }).attach(bus);
    tick(bus, ["first turn output\n"]);
    bus.emit(createEvent("assistant.message.completed", {
      sessionId: "s-1",
      messageId: "m-1",
      content: [{ kind: "text", text: "first turn output" }]
    }));
    expect(renderer.hadOutput()).toBe(true);
    bus.emit(createEvent("user.prompt.submitted", {
      sessionId: "s-1",
      messageId: "m-2",
      content: [{ kind: "text", text: "next prompt" }]
    }));
    expect(renderer.hadOutput()).toBe(false);
    renderer.detach();
  });
});

/**
 * The regression guard for "live and replay render differently".
 *
 * Before Phase 3c the renderer cut its buffer at the last newline and pushed
 * each fragment through `renderMarkdown()`, which renders a whole document —
 * so every cut added a blank line and the streamed message drifted from the
 * one replayed by `procway-code resume` (a heading + a two-item list gained
 * four of them). The invariant below is chunking-independent by construction:
 * blocks render independently, so a prefix now plus the rest later is the
 * same bytes as one shot.
 */
const PARITY_DOCS = {
  "the reported case": "## 見出し\n\n本文です。\n\n- 箇条書き1\n- 箇条書き2\n\n次の段落。\n",
  "every block kind": [
    "# Title",
    "",
    "Intro with **bold**, *italic*, `code` and a [link](https://example.com).",
    "",
    "## Sub",
    "",
    "- bullet one",
    "- bullet two",
    "  - nested",
    "- [x] done",
    "- [ ] open",
    "",
    "1. first",
    "2. second",
    "",
    "> quoted one",
    "> quoted two",
    "",
    "| col a | col b |",
    "|-------|-------|",
    "| 1     | 2     |",
    "",
    "```js",
    "const x = 1;",
    "```",
    "",
    "---",
    "",
    "Final paragraph.",
    ""
  ].join("\n"),
  "japanese wrapping and emoji": "日本語の長い文章をここに書きます。折り返しが発生するように十分に長い文章を用意して、禁則処理が効くかどうかも確認します。「括弧」も入れます。絵文字も 🚀🎉 混ぜます。\n\n- 箇条書きの中でも折り返すくらい長い日本語の文章を書いておきます。\n",
  "strikethrough and links": [
    "~~打ち消し~~ と See [docs](https://example.com/docs) for more.",
    "",
    "Mixed ~~**struck bold**~~ and **~~bold struck~~** and [a long label that wraps somewhere](https://example.com/some/deep/path).",
    "",
    "- [x] ~~done item~~ with [link](https://example.com/l)",
    "",
    "> quoted [docs](https://example.com/a/b/c) and ~~strike~~ long enough to wrap around the terminal.",
    "",
    "[bad](javascript:alert(1)) and [f](file:///etc/passwd) stay plain text.",
    ""
  ].join("\n"),
  "no trailing newline": "para one\n\npara two, unterminated",
  "single line": "just one line",
  "ends on a list": "- a\n- b\n- c\n",
  "ends on a table": "| a | b |\n|---|---|\n| 1 | 2 |\n",
  "ends on a code fence": "```js\nconst a = 1;\n```\n",
  "crlf source": "# Title\r\n\r\npara\r\n"
};

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

function fixedChunks(text, size) {
  const chunks = [];
  for (let index = 0; index < text.length; index += size) chunks.push(text.slice(index, index + size));
  return chunks;
}

/** What `renderTranscriptNode` writes for this message on replay, + separator. */
function replayed(text, { colorize, width, hyperlinks = false }) {
  return `${trimTrailingNewlines(renderMarkdown(text, { width, color: colorize, hyperlinks }))}\n\n`;
}

describe("live output === replayed output", () => {
  for (const [name, text] of Object.entries(PARITY_DOCS)) {
    for (const colorize of [true, false]) {
      it(`matches the replayed render for "${name}" (colorize=${colorize}) at every chunk size`, () => {
        const expected = replayed(text, { colorize, width: 80 });
        const chunkings = [
          ...[1, 2, 3, 7, 40, 10_000].map((size) => fixedChunks(text, size)),
          text.split(/(?<=\n)/),                       // whole lines
          text.split(/(?=\n)/),                        // cut just before each \n
          [text]                                       // one shot
        ];
        for (const chunks of chunkings) {
          expect(streamAll(text, chunks, { colorize, width: 80 })).toBe(expected);
        }
      });
    }
  }

  // P3d-3: OSC 8 is the first escape we emit that is NOT an SGR run, and the
  // one whose payload (the URI) is long enough that a mis-measured width
  // would be obvious. Parity has to hold with links on, at every chunk size
  // and at a width narrow enough to force the per-row re-open.
  for (const width of [40, 80]) {
    it(`matches the replayed render with OSC 8 links on (width=${width})`, () => {
      const text = PARITY_DOCS["strikethrough and links"];
      const expected = replayed(text, { colorize: true, width, hyperlinks: true });
      expect(expected).toContain("\x1b]8;;https://example.com/docs\x1b\\");
      for (const size of [1, 3, 7, 100, 5000]) {
        expect(streamAll(text, fixedChunks(text, size), { colorize: true, width, hyperlinks: true }))
          .toBe(expected);
      }
      // Cutting a chunk *inside* a link's Markdown source must not change a byte.
      const cut = text.indexOf("https://example.com/docs") + 5;
      expect(streamAll(text, [text.slice(0, cut), text.slice(cut)], { colorize: true, width, hyperlinks: true }))
        .toBe(expected);
    });
  }

  it("is stable across every possible two-chunk split point", () => {
    const text = PARITY_DOCS["the reported case"];
    const expected = replayed(text, { colorize: true, width: 80 });
    for (let cut = 1; cut < text.length; cut += 1) {
      expect(streamAll(text, [text.slice(0, cut), text.slice(cut)], { colorize: true, width: 80 })).toBe(expected);
    }
  });

  it("matches the assistant node the transcript replays, byte for byte", () => {
    const text = PARITY_DOCS["every block kind"];
    const node = renderTranscriptNode({ kind: "assistant", text }, { width: 80, colorize: true });
    // The node carries no role label — it IS the body — so the live stream
    // and the replayed transcript are byte-identical (the old "Assistant:"
    // label was dropped so resume no longer looks different from live).
    expect(streamAll(text, fixedChunks(text, 7), { colorize: true, width: 80 })).toBe(`${node}\n\n`);
  });

  it("no longer multiplies blank lines the way the newline-cut renderer did", () => {
    const text = PARITY_DOCS["the reported case"];
    const blanks = (value) => stripAnsi(value).split("\n").filter((line) => line.trim() === "").length;
    // The user's report: 11 blank lines live vs 5 on replay. Now they agree.
    expect(blanks(streamAll(text, fixedChunks(text, 7)))).toBe(blanks(renderMarkdown(text, { width: 80, color: true })));
  });

  it("matches after an interrupted turn (partial text, turn.failed)", () => {
    // Ctrl+C mid-turn: the partial text is what gets folded into
    // session.messages, so the screen and the resumed transcript must agree.
    const partial = "## Heading\n\n- one\n- two\n\nUnfinished parag";
    const writer = makeWriter();
    const bus = new EventBus();
    const renderer = createStreamingRenderer({ writer, colorize: true, width: 80 }).attach(bus);
    for (const chunk of fixedChunks(partial, 5)) {
      bus.emit(createEvent("assistant.message.delta", { sessionId: "s-1", messageId: "m-1", deltaText: chunk }));
    }
    bus.emit(createEvent("turn.failed", { sessionId: "s-1", messageId: "m-1", error: { message: "aborted" } }));
    expect(writer.text).toBe(replayed(partial, { colorize: true, width: 80 }));
    renderer.detach();
  });

  // Phase 3c item 3, closed against the REAL replay renderer rather than
  // `renderMarkdown` alone: Ctrl+C mid-turn folds the partial text into
  // `session.messages`, and `procway-code resume` re-renders it through
  // `renderTranscriptNode`. The screen the user was looking at when they
  // interrupted and the screen they get back must be the same bytes.
  for (const hyperlinks of [false, true]) {
    it(`interrupt → resume replays the partial message byte for byte (hyperlinks=${hyperlinks})`, () => {
      const partial = [
        "## Heading",
        "",
        "- one ~~struck~~",
        "- two with [docs](https://example.com/docs)",
        "",
        "Unfinished parag"
      ].join("\n");
      const writer = makeWriter();
      const bus = new EventBus();
      const renderer = createStreamingRenderer({ writer, colorize: true, width: 80, hyperlinks }).attach(bus);
      for (const chunk of fixedChunks(partial, 5)) {
        bus.emit(createEvent("assistant.message.delta", { sessionId: "s-1", messageId: "m-1", deltaText: chunk }));
      }
      bus.emit(createEvent("turn.failed", { sessionId: "s-1", messageId: "m-1", error: { message: "aborted" } }));
      renderer.detach();

      const node = renderTranscriptNode({ kind: "assistant", text: partial }, { width: 80, colorize: true, hyperlinks });
      expect(writer.text).toBe(`${node}\n\n`);
      expect(writer.text.includes("\x1b]8;")).toBe(hyperlinks);
    });
  }
});
