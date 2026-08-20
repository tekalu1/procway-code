import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createInputController, splitPrompt } from "../src/adapters/tui/input-controller.mjs";
import { renderScreen } from "./helpers/screen.mjs";

function makeTty() {
  const input = new EventEmitter();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = vi.fn((raw) => { input.isRaw = raw; });
  input.resume = vi.fn();
  input.pause = vi.fn();
  return input;
}

function makePipe() {
  const input = new EventEmitter();
  input.isTTY = false;
  input.resume = vi.fn();
  input.pause = vi.fn();
  return input;
}

function makeOutput() {
  let text = "";
  return {
    isTTY: true,
    columns: 60,
    write(value) { text += value; return true; },
    get text() { return text; },
    clear() { text = ""; }
  };
}

/** Deliver raw bytes exactly as a terminal would. */
function type(input, bytes) {
  input.emit("data", Buffer.from(bytes, "utf8"));
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("input controller — ownership", () => {
  it("enables raw mode + bracketed paste on start and restores both on dispose", () => {
    const input = makeTty();
    const output = makeOutput();
    const controller = createInputController({ input, output }).start();
    expect(input.setRawMode).toHaveBeenCalledWith(true);
    expect(output.text).toContain("\x1b[?2004h");
    output.clear();
    controller.dispose();
    expect(output.text).toContain("\x1b[?2004l");
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
    expect(input.listenerCount("data")).toBe(0);
  });
});

describe("input controller — multi-line input (P2-2)", () => {
  it("Enter submits", async () => {
    const input = makeTty();
    const controller = createInputController({ input, output: makeOutput() });
    const pending = controller.question("❯ ");
    type(input, "hello\r");
    await expect(pending).resolves.toBe("hello");
    controller.dispose();
  });

  it("Ctrl+J inserts a newline and Enter submits the whole buffer", async () => {
    const input = makeTty();
    const controller = createInputController({ input, output: makeOutput() });
    const pending = controller.question("❯ ");
    type(input, "line one\x0aline two\x0aline three");
    type(input, "\r");
    await expect(pending).resolves.toBe("line one\nline two\nline three");
    controller.dispose();
  });

  it("backslash + Enter continues onto the next line", async () => {
    const input = makeTty();
    const controller = createInputController({ input, output: makeOutput() });
    const pending = controller.question("❯ ");
    type(input, "first\\\r");
    type(input, "second\r");
    await expect(pending).resolves.toBe("first\nsecond");
    controller.dispose();
  });

  it("Esc+Enter (Option/Shift+Enter) inserts a newline", async () => {
    const input = makeTty();
    const controller = createInputController({ input, output: makeOutput() });
    const pending = controller.question("❯ ");
    type(input, "a\x1b\rb\r");
    await expect(pending).resolves.toBe("a\nb");
    controller.dispose();
  });

  it("edits across lines: backspace at column 0 joins with the previous line", async () => {
    const input = makeTty();
    const controller = createInputController({ input, output: makeOutput() });
    const pending = controller.question("❯ ");
    type(input, "ab\x0acd");
    type(input, "\x01");   // Ctrl+A → start of line 2
    type(input, "\x7f");   // backspace joins
    type(input, "\r");
    await expect(pending).resolves.toBe("abcd");
    controller.dispose();
  });

  it("repaints a Japanese line without repeating the prompt header", async () => {
    const input = makeTty();
    const output = makeOutput();
    const controller = createInputController({ input, output });
    const pending = controller.question("╭─ ws p:m\n╰─❯ ");
    output.clear();
    type(input, "日本語のテキストを入力してみるテストです");
    type(input, "\x7f\x7f\x7f");
    // The static header belongs to the repainted region: every frame rewinds
    // over it (cursor-up + erase-to-end) and rewrites it in place. readline
    // instead appended a fresh `╭─ …` line per keystroke — the reported bug.
    const frames = output.text.split("\x1b[0J").slice(1);
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) expect(frame.startsWith("╭─ ws p:m")).toBe(true);
    expect(output.text).not.toContain("\n╭─ ws p:m");
    type(input, "\r");
    await expect(pending).resolves.toBe("日本語のテキストを入力してみるテス");
    controller.dispose();
  });
});

describe("input controller — bracketed paste (P2-3)", () => {
  it("treats a multi-line paste as one input instead of one turn per line", async () => {
    const input = makeTty();
    const controller = createInputController({ input, output: makeOutput() });
    const pending = controller.question("❯ ");
    type(input, "\x1b[200~alpha\nbeta\ngamma\x1b[201~");
    type(input, "\r");
    await expect(pending).resolves.toBe("alpha\nbeta\ngamma");
    controller.dispose();
  });
});

describe("input controller — serialization (the readline wedge regression)", () => {
  it("an interjected question preempts the prompt and BOTH promises settle", async () => {
    // Reproduces the parked-approval hang: `resolveParkedApproval` starts a
    // detached continuation that emits `approval.requested` while the REPL's
    // own question() is still pending. On one readline the second question's
    // callback was dropped and the approval never resolved.
    const input = makeTty();
    const controller = createInputController({ input, output: makeOutput() });
    const repl = controller.question("❯ ");
    type(input, "some typing");
    const approval = controller.question({ prompt: "Approve [y/n]? ", level: 1 });
    await tick();
    type(input, "y\r");
    await expect(approval).resolves.toBe("y");
    // The base prompt is restored with its buffer intact.
    type(input, "!\r");
    await expect(repl).resolves.toBe("some typing!");
    controller.dispose();
  });

  it("two interjections serialize FIFO", async () => {
    const input = makeTty();
    const controller = createInputController({ input, output: makeOutput() });
    const first = controller.question({ prompt: "one? ", level: 1 });
    const second = controller.question({ prompt: "two? ", level: 1 });
    type(input, "a\r");
    await expect(first).resolves.toBe("a");
    await tick();
    type(input, "b\r");
    await expect(second).resolves.toBe("b");
    controller.dispose();
  });
});

describe("approval prompt over a live REPL prompt (parked-approval wedge)", () => {
  it("resolves the approval AND the REPL prompt — the exact hang that wedged the REPL", async () => {
    const { attachApprovalPrompt } = await import("../src/adapters/tui/approval-prompt.mjs");
    const { EventBus } = await import("../src/core/events/bus.mjs");

    const input = makeTty();
    const controller = createInputController({ input, output: makeOutput() });
    const decisions = [];
    const events = new EventBus();
    const session = {
      events,
      approve: (requestId, decision) => decisions.push([requestId, decision])
    };
    const handle = attachApprovalPrompt({ session, controller });

    // The REPL is sitting at its prompt with half a message typed…
    const repl = controller.question("❯ ");
    type(input, "half typed");
    // …when a detached parked-approval continuation asks for a decision.
    events.emit({ type: "approval.requested", kind: "run_shell", summary: "rm -rf x", requestId: "req-1", payload: {} });
    await tick();
    type(input, "y\r");
    await tick();
    await tick();
    expect(decisions).toEqual([["req-1", "allow"]]);

    type(input, " rest\r");
    await expect(repl).resolves.toBe("half typed rest");
    handle.dispose();
    controller.dispose();
  });

  it("Ctrl+D at an overlay cancels only that overlay (deny), not the session", async () => {
    const input = makeTty();
    const onEof = vi.fn();
    const controller = createInputController({ input, output: makeOutput(), onEof });
    const overlay = controller.question({ prompt: "Approve? ", level: 1 });
    type(input, "\x04");
    await expect(overlay).rejects.toThrow(/Aborted/);
    expect(onEof).not.toHaveBeenCalled();
    controller.dispose();
  });
});

describe("input controller — turn-time keystrokes (P2-8)", () => {
  it("queues keys typed while nothing is reading and replays them at the next prompt", async () => {
    const input = makeTty();
    const controller = createInputController({ input, output: makeOutput() }).start();
    type(input, "typed during the turn");
    const pending = controller.question("❯ ");
    type(input, "\r");
    await expect(pending).resolves.toBe("typed during the turn");
    controller.dispose();
  });

  it("Ctrl+C during a turn is delivered immediately, not queued", () => {
    const input = makeTty();
    const onInterrupt = vi.fn();
    const controller = createInputController({ input, output: makeOutput(), onInterrupt }).start();
    type(input, "\x03");
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    controller.dispose();
  });
});

describe("input controller — control keys", () => {
  it("Ctrl+C at an idle prompt clears the line instead of exiting", async () => {
    const input = makeTty();
    const controller = createInputController({ input, output: makeOutput() });
    const cleared = [];
    controller.onInterrupt = () => { cleared.push(controller.clearInput()); };
    const pending = controller.question("❯ ");
    type(input, "some text");
    type(input, "\x03");
    expect(cleared).toEqual([true]);
    type(input, "kept\r");
    await expect(pending).resolves.toBe("kept");
    controller.dispose();
  });

  it("Ctrl+D ends the prompt only when the buffer is empty", async () => {
    const input = makeTty();
    const onEof = vi.fn();
    const controller = createInputController({ input, output: makeOutput(), onEof });
    const withText = controller.question("❯ ");
    type(input, "hello\x04");
    expect(onEof).not.toHaveBeenCalled();
    type(input, "\r");
    await expect(withText).resolves.toBe("hello");

    const empty = controller.question("❯ ");
    type(input, "\x04");
    await expect(empty).resolves.toBeNull();
    expect(onEof).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("Esc at a prompt is routed to the caller (interrupt / clear)", () => {
    const input = makeTty();
    const onEscape = vi.fn();
    const controller = createInputController({ input, output: makeOutput(), onEscape });
    controller.question("❯ ").catch(() => {}); // dispose() aborts it below
    type(input, "\x1b");
    return new Promise((resolve) => setTimeout(() => {
      expect(onEscape).toHaveBeenCalledTimes(1);
      controller.dispose();
      resolve();
    }, 60));
  });
});

describe("input controller — secret + exclusive modes", () => {
  it("readSecret never echoes and never touches stdin listeners", async () => {
    const input = makeTty();
    const output = makeOutput();
    const controller = createInputController({ input, output }).start();
    const listenersBefore = input.listenerCount("data");
    const pending = controller.readSecret({ prompt: "Token: " });
    output.clear();
    type(input, "super-secret\r");
    await expect(pending).resolves.toBe("super-secret");
    expect(output.text).toBe("\n");
    expect(input.listenerCount("data")).toBe(listenersBefore);
    controller.dispose();
  });

  it("Ctrl+C cancels a secret prompt", async () => {
    const input = makeTty();
    const controller = createInputController({ input, output: makeOutput() });
    const pending = controller.readSecret({ prompt: "Token: " });
    type(input, "abc\x03");
    await expect(pending).rejects.toThrow("Secret input cancelled");
    controller.dispose();
  });

  it("withExclusiveKeys receives decoded keys and can finish with a value", async () => {
    const input = makeTty();
    const controller = createInputController({ input, output: makeOutput() });
    const seen = [];
    const pending = controller.withExclusiveKeys((key, api) => {
      seen.push(key.name ?? key.type);
      if (key.name === "return") api.finish("picked");
    });
    type(input, "\x1b[B\x1b[B\r");
    await expect(pending).resolves.toBe("picked");
    expect(seen).toEqual(["down", "down", "return"]);
    controller.dispose();
  });
});

describe("input controller — piped stdin", () => {
  it("reads whole lines and reports EOF as null", async () => {
    const input = makePipe();
    const controller = createInputController({ input, output: makeOutput() });
    const first = controller.question("> ");
    input.emit("data", Buffer.from("hello\nworld\n"));
    await expect(first).resolves.toBe("hello");
    await expect(controller.question("> ")).resolves.toBe("world");
    const last = controller.question("> ");
    input.emit("end");
    await expect(last).resolves.toBeNull();
    controller.dispose();
  });
});

describe("input controller — persistent dock (TODO panel + status row)", () => {
  async function arm(prompt = "❯ ") {
    const input = makeTty();
    const output = makeOutput();
    const controller = createInputController({ input, output });
    const pending = controller.question(prompt);
    await tick();
    output.clear();
    return { input, output, controller, pending };
  }

  it("pins the panel and a status spinner above the prompt, then drops the status on a content write", async () => {
    const { output, controller, pending } = await arm();
    controller.writer.setDockPanel("▌ TODO\n   ✔ a");
    controller.writer.writeTransient("⠋ model waiting (0.3s)");
    // Layout top→bottom: status spinner, panel, input row. `lastIndexOf`
    // reads the FINAL composite (each transient repaint redraws the whole
    // dock), so this is a true vertical-order check.
    expect(output.text.lastIndexOf("model waiting")).toBeGreaterThan(-1);
    expect(output.text.lastIndexOf("model waiting")).toBeLessThan(output.text.lastIndexOf("▌ TODO"));
    expect(output.text.lastIndexOf("❯")).toBeGreaterThan(output.text.lastIndexOf("▌ TODO"));
    // In-place repaint replaces the old frame instead of stacking lines.
    controller.writer.writeTransient("⠙ model waiting (0.4s)");
    expect(output.text).toContain("⠙ model waiting");
    // A newline-terminated content write clears the status but keeps the panel
    // pinned directly above the prompt.
    output.clear();
    controller.writer.write("response line\n");
    expect(output.text).toContain("response line");
    expect(output.text).not.toContain("model waiting");
    expect(output.text.indexOf("▌ TODO")).toBeGreaterThan(output.text.indexOf("response line"));
    expect(output.text.lastIndexOf("❯")).toBeGreaterThan(output.text.indexOf("▌ TODO"));
    controller.dispose();
    await pending.catch(() => {});
  });

  it("commits the docked editor's submitted line to the feed and re-pins the panel (no scroll leak)", async () => {
    const { input, output, controller, pending } = await arm();
    controller.writer.setDockPanel("▌ TODO\n   ✔ a");
    output.clear();
    type(input, "hello\r");
    await expect(pending).resolves.toBe("hello");
    // The submitted line is committed as a feed row and the TODO panel is
    // re-pinned BELOW it (immediately above the now-empty prompt) — i.e. the
    // panel does NOT scroll up past the message on submit, and the message is
    // not swallowed by the dock redraw.
    expect(output.text).toContain("\u276f hello");
    expect(output.text.lastIndexOf("\u276f hello")).toBeGreaterThan(-1);
    expect(output.text.lastIndexOf("\u276f hello")).toBeLessThan(output.text.lastIndexOf("▌ TODO"));
    expect(output.text.lastIndexOf("\u276f")).toBeGreaterThan(output.text.lastIndexOf("▌ TODO"));
    controller.dispose();
  });

  it("re-arming the prompt after a docked submit leaves ONE dock copy (no TODO/header flow)", async () => {
    const input = makeTty();
    const output = makeOutput();
    const controller = createInputController({ input, output }).start();
    const q1 = controller.question("╭─ ws · p:m\n╰─❯ ");
    await tick();
    controller.writer.setDockPanel("▌ TODO\n   ✔ a\ny");
    output.clear();
    // Submit; the pump then re-arms a fresh base prompt while a turn runs.
    type(input, "hello\r");
    await expect(q1).resolves.toBe("hello");
    const q2 = controller.question("╭─ ws · p:m\n╰─❯ ");
    await tick();
    controller.writer.write("response\n");
    await tick();
    // The submitted line is committed to the feed, and the TODO panel + `╭─`
    // header appear exactly once on the FINAL SCREEN — the re-arm must not
    // stack a second dock below the old one, and the pinned panel must not
    // "flow" into the scrollback in addition to being pinned.
    const lines = renderScreen(output.text, { width: 60, height: 24 });
    expect(lines.join("\n")).toContain("hello");
    expect(lines.filter((l) => l.includes("▌ TODO")).length).toBe(1);
    expect(lines.filter((l) => l.includes("╭─ ws")).length).toBe(1);
    expect(lines.join("\n").lastIndexOf("❯")).toBeGreaterThan(lines.indexOf("▌ TODO"));
    controller.dispose();
    await q2.catch(() => {});
  });

  it("drop the panel with null (off mode) and clear the status with clearTransient()", async () => {
    const { output, controller, pending } = await arm();
    controller.writer.setDockPanel("▌ TODO\n   ✔ a");
    output.clear();
    controller.writer.writeTransient("⠋ spinning");
    expect(output.text).toContain("spinning");
    output.clear();
    controller.writer.clearTransient();
    expect(output.text).not.toContain("spinning");
    expect(output.text).toContain("▌ TODO");
    output.clear();
    controller.writer.setDockPanel(null);
    expect(output.text).not.toContain("▌ TODO");
    controller.dispose();
    await pending.catch(() => {});
  });

  it("an EMPTY write changes nothing — the panel and the input stay on screen", async () => {
    const { output, controller, pending } = await arm("╭─ ws · p:m\n╰─❯ ");
    controller.writer.setDockPanel("▌ TODO\n   ✔ a");
    output.clear();
    // `renderAssistantContent()` returns "" for a round whose assistant message
    // is tool calls only, and the REPL wrote that verbatim — so EVERY turn that
    // used a tool sent an empty string through here. It was treated as a
    // partial (unterminated) line: the dock came down and, because a hidden
    // editor took a bare-write early return, nothing ever put it back. The
    // input line stayed gone until the user pressed Enter (which re-arms the
    // prompt and redraws the dock).
    controller.writer.write("");
    expect(output.text).toBe("");
    // The dock is still live: a following content write repaints it as usual.
    controller.writer.write("after\n");
    const lines = renderScreen(output.text, { width: 60, height: 10 });
    expect(lines.filter((l) => l.includes("▌ TODO")).length).toBe(1);
    expect(lines.filter((l) => l.includes("╰─❯")).length).toBe(1);
    controller.dispose();
    await pending.catch(() => {});
  });

  it("a partial (unterminated) write hides the dock, and the next full line brings it back", async () => {
    const { output, controller, pending } = await arm("╭─ ws · p:m\n╰─❯ ");
    controller.writer.setDockPanel("▌ TODO\n   ✔ a");
    output.clear();
    // Half a line: the dock has to come down (it must not be painted over an
    // unterminated row), but that state has to be RECOVERABLE — before, a
    // hidden editor made every later write a bare passthrough.
    controller.writer.write("half");
    controller.writer.write(" line\n");
    const lines = renderScreen(output.text, { width: 60, height: 10 });
    expect(lines.join("\n")).toContain("half line");
    expect(lines.filter((l) => l.includes("▌ TODO")).length).toBe(1);
    expect(lines.filter((l) => l.includes("╭─ ws")).length).toBe(1);
    expect(lines.filter((l) => l.includes("╰─❯")).length).toBe(1);
    controller.dispose();
    await pending.catch(() => {});
  });

  it("isOverlay is false at the base prompt and true while an overlay reads keys; writeTransient is then refused", async () => {
    const { input, controller, pending } = await arm();
    expect(controller.isOverlay).toBe(false);
    expect(controller.writer.hasDock).toBe(true);
    const approval = controller.question({ prompt: "Approve? ", level: 1 });
    await tick();
    expect(controller.isOverlay).toBe(true);
    expect(controller.writer.writeTransient("spinner")).toBe(false);
    type(input, "y\r");
    await expect(approval).resolves.toBe("y");
    expect(controller.isOverlay).toBe(false);
    controller.dispose();
    await pending.catch(() => {});
  });
});

describe("splitPrompt", () => {
  it("keeps only the last line as the editable prefix", () => {
    expect(splitPrompt("╭─ ws\n╰─❯ ")).toEqual({ header: "╭─ ws\n", prefix: "╰─❯ " });
    expect(splitPrompt("> ")).toEqual({ header: "", prefix: "> " });
  });
});
