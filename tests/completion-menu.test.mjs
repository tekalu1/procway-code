import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { createCompletionSource, renderCompletionMenu, MENU_LIMIT } from "../src/adapters/tui/completion-menu.mjs";
import { createReplCompleter } from "../src/adapters/tui/path-completion.mjs";
import { createSlashCompleter } from "../src/adapters/tui/slash-completion.mjs";
import { createInputController } from "../src/adapters/tui/input-controller.mjs";
import { layout } from "../src/adapters/tui/line-editor.mjs";
import { stripAnsi, visibleWidth } from "../src/adapters/tui/ansi.mjs";

const fakeFs = {
  readdirSync(dir) {
    if (dir.endsWith("/repo")) return ["src", "tests", "README.md"];
    if (dir.endsWith("/repo/src")) return ["cli.mjs", "adapters"];
    throw new Error("ENOENT");
  },
  statSync(file) {
    return { isDirectory: () => /\/(src|tests|adapters)$/.test(file) };
  }
};

function makeSource() {
  return createCompletionSource({
    cwd: "/repo",
    completer: createReplCompleter({ cwd: "/repo", slashCompleter: createSlashCompleter(), fs: fakeFs })
  });
}

function makeTty() {
  const input = new EventEmitter();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = () => {};
  input.resume = () => {};
  input.pause = () => {};
  return input;
}

function makeOutput({ columns = 80 } = {}) {
  const emitter = new EventEmitter();
  emitter.isTTY = true;
  emitter.columns = columns;
  emitter.rows = 24;
  emitter.buffer = "";
  emitter.write = (value) => { emitter.buffer += value; return true; };
  return emitter;
}

function type(input, text) {
  input.emit("data", Buffer.from(text, "utf8"));
}

describe("completion source", () => {
  const source = makeSource();

  it("opens on a bare `/` with every command and a `… and N more` tail", () => {
    const menu = source("/");
    expect(menu.token).toBe("/");
    expect(menu.items).toHaveLength(MENU_LIMIT);
    expect(menu.total).toBeGreaterThan(MENU_LIMIT);
    expect(menu.items[0].value).toBe("/branch");
    expect(menu.items[0].description).toMatch(/Branch the conversation/);
  });

  it("narrows live as more characters arrive", () => {
    expect(source("/co").items.map((item) => item.value)).toEqual(["/compact", "/config", "/context"]);
    expect(source("/cont").items.map((item) => item.value)).toEqual(["/context"]);
  });

  it("closes once the single match is typed in full, so Enter still submits", () => {
    expect(source("/context")).toBeNull();
    expect(source("hello there")).toBeNull();
  });

  it("serves @path references with the same shape", () => {
    const menu = source("please read @src/");
    expect(menu.token).toBe("@src/");
    expect(menu.items.map((item) => item.value)).toEqual(["@src/adapters/", "@src/cli.mjs"]);
  });
});

describe("completion menu rendering", () => {
  const items = [
    { value: "/compact", label: "/compact [--strategy <name>]", description: "Compact the conversation history" },
    { value: "/config", label: "/config [setup]", description: "Show settings or configure a provider" }
  ];

  it("marks the selected row and aligns the label column", () => {
    const rows = renderCompletionMenu({ items, selected: 1, total: 5, width: 80 }).split("\n");
    expect(rows[0].startsWith("  /compact")).toBe(true);
    expect(rows[1].startsWith("❯ /config")).toBe(true);
    expect(rows[2]).toContain("… and 3 more");
    const descriptionColumns = rows.slice(0, 2).map((row) => row.indexOf("  Co") >= 0 ? row.indexOf("  Co") : row.indexOf("  Sh"));
    expect(new Set(descriptionColumns).size).toBe(1);
  });

  it("never overflows the terminal width", () => {
    for (const width of [30, 50, 80]) {
      for (const row of renderCompletionMenu({ items, selected: 0, total: 2, width }).split("\n")) {
        expect(visibleWidth(stripAnsi(row)), `${width}: ${row}`).toBeLessThanOrEqual(width);
      }
    }
  });

  it("returns an empty string when there is nothing to show", () => {
    expect(renderCompletionMenu({ items: [] })).toBe("");
  });
});

describe("the menu as the input region's footer", () => {
  it("layout() draws footer rows below the input and keeps the cursor on it", () => {
    const { rows, cursorRow } = layout({
      lines: ["/co"],
      row: 0,
      col: 3,
      prompt: "❯ ",
      footer: "❯ /compact\n  /config",
      width: 80
    });
    expect(rows).toEqual(["❯ /co", "❯ /compact", "  /config"]);
    expect(cursorRow).toBe(0);
  });

  it("opens the moment `/` is typed — no Tab, no Enter", () => {
    const input = makeTty();
    const output = makeOutput();
    const controller = createInputController({ input, output }).start();
    controller.question({ prompt: "❯ ", completions: makeSource(), menuWidth: 80 }).catch(() => {});
    output.buffer = "";
    type(input, "/");
    expect(stripAnsi(output.buffer)).toContain("/branch");
    controller.dispose();
  });

  it("moves the selection with ↓ and accepts with Tab", async () => {
    const input = makeTty();
    const output = makeOutput();
    const controller = createInputController({ input, output }).start();
    const answer = controller.question({ prompt: "❯ ", completions: makeSource(), menuWidth: 80 });
    type(input, "/co");
    type(input, "\x1b[B");   // ↓ → /config
    type(input, "\t");       // accept
    type(input, "\r");
    await expect(answer).resolves.toBe("/config");
    controller.dispose();
  });

  it("accepts with Enter without submitting the line", async () => {
    const input = makeTty();
    const output = makeOutput();
    const controller = createInputController({ input, output }).start();
    const answer = controller.question({ prompt: "❯ ", completions: makeSource(), menuWidth: 80 });
    type(input, "/co");
    type(input, "\r");       // accepts /compact, does NOT submit
    let settled = false;
    answer.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    type(input, "\r");       // now the line goes
    await expect(answer).resolves.toBe("/compact");
    controller.dispose();
  });

  it("closes on Esc and keeps what was typed", async () => {
    const input = makeTty();
    const output = makeOutput();
    let escapes = 0;
    const controller = createInputController({ input, output, onEscape: () => { escapes += 1; } }).start();
    const answer = controller.question({ prompt: "❯ ", completions: makeSource(), menuWidth: 80 });
    type(input, "/co");
    output.buffer = "";
    type(input, "\x1b");
    await new Promise((resolve) => setTimeout(resolve, 40));
    // The menu is gone …
    expect(stripAnsi(output.buffer)).not.toContain("/compact");
    // … the REPL's own Esc handler was NOT triggered …
    expect(escapes).toBe(0);
    // … and the buffer survived.
    type(input, "\r");
    await expect(answer).resolves.toBe("/co");
    controller.dispose();
  });

  it("re-opens once the user types again after Esc", async () => {
    const input = makeTty();
    const output = makeOutput();
    const controller = createInputController({ input, output }).start();
    controller.question({ prompt: "❯ ", completions: makeSource(), menuWidth: 80 }).catch(() => {});
    type(input, "/co");
    type(input, "\x1b");
    // A lone ESC is only known to be a lone ESC once the escape-flush window
    // has passed (otherwise `ESC n` would be Alt+n).
    await new Promise((resolve) => setTimeout(resolve, 40));
    output.buffer = "";
    type(input, "n");
    expect(stripAnsi(output.buffer)).toContain("/config");
    controller.dispose();
  });

  it("leaves no residue in the scrollback: the footer is erased on submit", async () => {
    const input = makeTty();
    const output = makeOutput();
    const controller = createInputController({ input, output }).start();
    const answer = controller.question({ prompt: "❯ ", completions: makeSource(), menuWidth: 80 });
    type(input, "/context\r");
    await expect(answer).resolves.toBe("/context");
    const tail = output.buffer.slice(output.buffer.lastIndexOf("❯ /context"));
    expect(stripAnsi(tail)).not.toContain("/compact");
    controller.dispose();
  });

  it("drives @path completion with the same keys", async () => {
    const input = makeTty();
    const output = makeOutput();
    const controller = createInputController({ input, output }).start();
    const answer = controller.question({ prompt: "❯ ", completions: makeSource(), menuWidth: 80 });
    type(input, "read @src/");
    expect(stripAnsi(output.buffer)).toContain("@src/cli.mjs");
    type(input, "\x1b[B"); // ↓ → @src/cli.mjs
    type(input, "\t");
    type(input, "\r");
    await expect(answer).resolves.toBe("read @src/cli.mjs");
    controller.dispose();
  });

  it("keeps Ctrl+C working while the menu is open", () => {
    const input = makeTty();
    const output = makeOutput();
    let interrupts = 0;
    const controller = createInputController({ input, output, onInterrupt: () => { interrupts += 1; } }).start();
    controller.question({ prompt: "❯ ", completions: makeSource(), menuWidth: 80 }).catch(() => {});
    type(input, "/co");
    type(input, "\x03");
    expect(interrupts).toBe(1);
    controller.dispose();
  });
});
