/**
 * Startup rendering, on a real pty (P4-3).
 *
 * Covers the three shapes that were broken at some point during the TUI work
 * and that no renderer unit test could see: the welcome card at a normal
 * width, at a narrow width, and in a pty that reports `columns === 0`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stripAnsi, visibleWidth } from "../src/adapters/tui/ansi.mjs";
import { PROMPT, makePtyEnv, normalizePty, ptySupported, runPty } from "./helpers/pty.mjs";

const describePty = ptySupported() ? describe : describe.skip;

/**
 * Every escape removed, one entry per printed line.
 *
 * A bare CR is a line boundary here as well as LF: the input controller
 * returns to column 0 and repaints (`\r` + erase-below), so `A\rB` is two
 * screen lines' worth of content, not one 2×-wide line. Splitting on it is
 * what makes the width assertions below measure what the terminal shows.
 */
function plainLines(output) {
  return stripAnsi(output)
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .split(/\r\n|\n|\r/);
}

/**
 * The welcome card's own six lines — `╭─ procway-code …╮` down to the closing
 * `╰…╯`. The prompt header underneath also opens with `╭─`, so it cannot be
 * selected by first glyph alone.
 */
function boxLines(output) {
  const lines = plainLines(output);
  const top = lines.findIndex((line) => line.startsWith("╭─ procway-code "));
  if (top < 0) return [];
  const bottom = lines.findIndex((line, index) => index > top && /^╰─+╯$/.test(line));
  if (bottom < 0) return lines.slice(top);
  return lines.slice(top, bottom + 1);
}

describePty("pty: startup", () => {
  let env;

  beforeAll(async () => { env = await makePtyEnv(); });
  afterAll(async () => { await env?.cleanup(); });

  async function start({ cols }) {
    return runPty({
      home: env.home,
      workspace: env.workspace,
      cols,
      steps: [
        { waitFor: PROMPT },
        // Ctrl+D at an empty prompt is the documented way out.
        { send: "\x04" }
      ]
    });
  }

  it("paints the banner, the tip line and the unavailable-tools note", async () => {
    const { output, exitCode } = await start({ cols: 80 });
    expect(exitCode).toBe(0);
    expect(normalizePty(output, env)).toMatchSnapshot();
  }, 30000);

  it("keeps every welcome-card line exactly as wide as the terminal", async () => {
    const { output } = await start({ cols: 80 });
    const lines = boxLines(output);
    expect(lines.length).toBe(6);
    for (const line of lines) expect(visibleWidth(line), line).toBe(80);
  }, 30000);

  // P4b-1/2: this used to exempt the tip line and the unavailable-tools note,
  // both of which were fixed strings wider than any narrow terminal, and it
  // only ran at 60 columns. Nothing is exempt now, the prompt header included
  // (a wrapped header desyncs the line editor's repaint bookkeeping), and the
  // sweep goes down to the 20-column floor `terminalWidth` clamps to.
  for (const cols of [80, 60, 40, 30, 20]) {
    it(`fits every startup line inside a ${cols}-column terminal`, async () => {
      const { output } = await start({ cols });
      const lines = boxLines(output);
      expect(lines.length).toBe(6);
      for (const line of lines) expect(visibleWidth(line), line).toBe(cols);
      const overflowing = plainLines(output)
        .filter((line) => line.trim().length > 0 && visibleWidth(line) > cols)
        .map((line) => `${visibleWidth(line)}: ${line}`);
      expect(overflowing).toEqual([]);
    }, 30000);
  }

  it("shortens the tip line and the unavailable-tools note instead of wrapping", async () => {
    const wide = plainLines((await start({ cols: 80 })).output);
    // 80 columns: everything still fits on one tip line, names and all.
    expect(wide.some((line) => /^Tip \/help commands {2}\/config setup provider {2}Ctrl\+J newline {2}Ctrl\+C interrupt$/.test(line))).toBe(true);
    expect(wide.some((line) => /^\d+ tools? unavailable here: .+ — \/status for why$/.test(line))).toBe(true);

    const narrow = plainLines((await start({ cols: 30 })).output);
    // 30 columns: whole tips are dropped (never half a tip), `/help` and
    // Ctrl+C survive, and the note falls back to the count plus the pointer.
    expect(narrow.some((line) => /^Tip \/help commands$/.test(line))).toBe(true);
    expect(narrow.some((line) => /^ {4}Ctrl\+C interrupt$/.test(line))).toBe(true);
    expect(narrow.some((line) => /^\d+ tools? unavailable — \/status$/.test(line))).toBe(true);
  }, 60000);

  it("falls back to 80 columns in a pty that reports columns === 0", async () => {
    // The regression: `terminalWidth()` returned 0, every panel computed a
    // negative inner width, and the whole screen collapsed to a column of
    // border glyphs. `cols: 0` reproduces that pty exactly.
    const { output, exitCode } = await start({ cols: 0 });
    expect(exitCode).toBe(0);
    const lines = boxLines(output);
    expect(lines.length).toBe(6);
    for (const line of lines) expect(visibleWidth(line), line).toBe(80);
    expect(normalizePty(output, env)).toMatchSnapshot();
  }, 30000);
});
