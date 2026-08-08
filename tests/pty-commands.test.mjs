/**
 * Slash commands and line editing, on a real pty (P4-3).
 *
 * `/help` and `/status` are the two commands a user reaches for when
 * something looks wrong, so their output is pinned byte for byte. The editing
 * cases cover the two inputs that break naive cursor arithmetic: a multi-line
 * buffer (Ctrl+J) and double-width characters.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stripAnsi, visibleWidth } from "../src/adapters/tui/ansi.mjs";
import {
  PANEL_START,
  PROMPT,
  blockFrom,
  framesBetween,
  lastFrameWith,
  makePtyEnv,
  normalizePty,
  plainPty,
  ptySupported,
  runPty
} from "./helpers/pty.mjs";

const describePty = ptySupported() ? describe : describe.skip;

const CTRL_C = "\x03";
const CTRL_D = "\x04";
const CTRL_J = "\x0a";

describePty("pty: slash commands and editing", () => {
  let env;

  beforeAll(async () => { env = await makePtyEnv(); });
  afterAll(async () => { await env?.cleanup(); });

  it("prints the full command list for /help", async () => {
    const run = await runPty({
      home: env.home,
      workspace: env.workspace,
      steps: [
        { waitFor: PROMPT, send: "/help\r" },
        // `/usage` is the last row of the listing; waiting on it means Ctrl+D
        // is sent after the whole panel has been printed, not into the middle
        // of it. (Waiting on the prompt would match the echo redraw of the
        // typed `/help` instead.)
        { waitFor: /\/usage/, send: CTRL_D }
      ]
    });
    expect(run.exitCode).toBe(0);
    // The panel itself, not the banner above it or the prompt below it.
    const help = blockFrom(run.output, PANEL_START);
    const plain = plainPty(help, env);
    // The listing is generated from the command table, so pin the shape and
    // the entries a user is told about in the README, not all 22 rows.
    for (const command of ["/help", "/status", "/resume", "/config", "/exit"]) {
      expect(plain).toContain(command);
    }
    expect(normalizePty(help, env)).toMatchSnapshot();
  }, 30000);

  it("prints the session panel for /status", async () => {
    const run = await runPty({
      home: env.home,
      workspace: env.workspace,
      steps: [
        { waitFor: PROMPT, send: "/status\r" },
        // The unavailable-tool rows are printed last.
        { waitFor: /desktop_action/, send: CTRL_D }
      ]
    });
    expect(run.exitCode).toBe(0);
    const status = blockFrom(run.output, PANEL_START);
    const plain = plainPty(status, env);
    expect(plain).toContain("openai-main:gpt-test");
    // The reasons are machine-specific and normalized away, so assert here
    // that both display tools really were reported.
    expect(status).toContain("web_browser");
    expect(status).toContain("desktop_action");
    expect(normalizePty(status, env)).toMatchSnapshot();
  }, 30000);

  it("keeps both lines of a Ctrl+J multi-line buffer on screen", async () => {
    const run = await runPty({
      home: env.home,
      workspace: env.workspace,
      steps: [
        { waitFor: PROMPT, send: "first line" },
        { waitFor: /first line/, send: CTRL_J },
        { waitFor: /\n/, send: "second line" },
        // Ctrl+C at an idle prompt clears the buffer instead of quitting,
        // which leaves the input empty so Ctrl+D can exit.
        { waitFor: /second line/, send: CTRL_C },
        { waitFor: /Press Ctrl-C again to exit/, send: CTRL_D }
      ]
    });
    expect(run.exitCode).toBe(0);
    // Both lines are visible at once, in the SAME repaint: the editor draws
    // the whole buffer, it does not append the second line to the first.
    const buffer = lastFrameWith(run.output, "second line");
    expect(plainPty(buffer, env)).toMatch(/first line[\s\S]*second line/);
    // The settled two-line buffer, the repaint that clears it, and the
    // warning — three frames, bounded by what they contain.
    expect(normalizePty(
      framesBetween(run.output, "second line", "Press Ctrl-C again to exit"),
      env
    )).toMatchSnapshot();
  }, 30000);

  it("renders a line of Japanese without corrupting the redraw", async () => {
    const run = await runPty({
      home: env.home,
      workspace: env.workspace,
      steps: [
        { waitFor: PROMPT, send: "日本語のテスト" },
        { waitFor: /日本語のテスト/, send: CTRL_C },
        { waitFor: /Press Ctrl-C again to exit/, send: CTRL_D }
      ]
    });
    expect(run.exitCode).toBe(0);
    const echoed = lastFrameWith(run.output, "日本語のテスト");
    // The buffer is drawn once per repaint, not once per byte of the UTF-8
    // sequence — and the cursor lands past 14 columns, not 7 characters.
    expect(plainPty(echoed, env).match(/日本語のテスト/g)?.length).toBe(1);
    expect(normalizePty(echoed, env)).toMatchSnapshot();
  }, 30000);

  /**
   * P4b-2: the prompt header is the FIRST row of the input region. Until this
   * phase it was rendered without a width, so on a narrow terminal it wrapped
   * and every subsequent repaint erased one row too few — the reason the
   * header drops segments at all. Editing double-width text at 40 columns is
   * the cheapest way to catch a regression: every repaint has to land on a
   * single row, and no row may exceed the window.
   */
  it("repaints cleanly while editing on a 40-column terminal", async () => {
    const run = await runPty({
      home: env.home,
      workspace: env.workspace,
      cols: 40,
      steps: [
        { waitFor: PROMPT, send: "日本語のテスト" },
        { waitFor: /日本語のテスト/, send: "\x7f\x7f" },
        // The repaint after the two backspaces, not the one before them.
        { waitFor: /日本語のテ(?!ス)/, send: CTRL_C },
        { waitFor: /Press Ctrl-C again to exit/, send: CTRL_D }
      ]
    });
    expect(run.exitCode).toBe(0);
    // A bare CR starts a new screen line just like LF (the editor returns to
    // column 0 and repaints), so both are boundaries when measuring.
    const lines = stripAnsi(run.output)
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
      .split(/\r\n|\n|\r/)
      .filter((line) => line.trim().length > 0);
    expect(lines.filter((line) => visibleWidth(line) > 40)).toEqual([]);
    // The header dropped its rightmost segment (approval mode) rather than
    // wrapping, and each repaint shows the buffer exactly once.
    expect(lines.some((line) => /^╭─ workspace · openai-main:gpt-test$/.test(line))).toBe(true);
    expect(lines.some((line) => /^╰─❯ 日本語のテ$/.test(line))).toBe(true);
  }, 30000);
});
