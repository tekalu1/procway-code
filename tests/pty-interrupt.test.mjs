/**
 * Leaving the REPL, on a real pty (P4-3).
 *
 * Both regressions this pins were invisible to unit tests:
 *
 *  - Ctrl+D used to print a stack trace on the way out, because the readline
 *    abort surfaced as an unhandled error instead of a UI control event. The
 *    renderer tests never saw it — nothing threw when a *fake* writer was
 *    closed.
 *  - the two-stage Ctrl+C was unit-tested against `new EventEmitter()`
 *    standing in for `process`, so the tests passed whether or not the
 *    keystroke was ever wired to the handler in `src/cli.mjs`. Here the
 *    keystroke goes through the terminal, the raw-mode key decoder and the
 *    controller, exactly as a user's does.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROMPT, makePtyEnv, plainPty, ptySupported, runPty } from "./helpers/pty.mjs";

const describePty = ptySupported() ? describe : describe.skip;

const CTRL_C = "\x03";
const CTRL_D = "\x04";

/** Anything that would betray an unhandled error reaching the top level. */
function looksLikeCrash(text) {
  return /\n\s+at [\w$.<>]+ \(|\bTypeError\b|\bReferenceError\b|ERR_USE_AFTER_CLOSE|Unhandled|node:internal/.test(text);
}

describePty("pty: leaving the REPL", () => {
  let env;

  beforeAll(async () => { env = await makePtyEnv(); });
  afterAll(async () => { await env?.cleanup(); });

  it("exits cleanly on Ctrl+D with no stack trace", async () => {
    const run = await runPty({
      home: env.home,
      workspace: env.workspace,
      steps: [{ waitFor: PROMPT, send: CTRL_D }]
    });
    expect(run.exitCode).toBe(0);
    expect(run.signal).toBeNull();
    const text = plainPty(run.output, env);
    expect(looksLikeCrash(text), text.slice(-600)).toBe(false);
    expect(run.stderr).toBe("");
  }, 30000);

  it("ignores Ctrl+D while the input line still has text", async () => {
    const run = await runPty({
      home: env.home,
      workspace: env.workspace,
      steps: [
        { waitFor: PROMPT, send: "unsent text" },
        // Ctrl+D on a non-empty buffer is a no-op, so it produces no output
        // of its own: the `!` in the same write is what proves the REPL is
        // still reading. If Ctrl+D had quit, the echo never arrives and this
        // step times out.
        { waitFor: /unsent text/, send: `${CTRL_D}!` },
        { waitFor: /unsent text!/, send: CTRL_C },
        { waitFor: /Press Ctrl-C again to exit/, send: CTRL_D }
      ]
    });
    expect(run.exitCode).toBe(0);
    expect(looksLikeCrash(plainPty(run.output, env))).toBe(false);
  }, 30000);

  it("does not quit on a single Ctrl+C at an idle prompt", async () => {
    const run = await runPty({
      home: env.home,
      workspace: env.workspace,
      steps: [
        { waitFor: PROMPT, send: CTRL_C },
        // Still alive: it answers with the warning and takes Ctrl+D, which
        // exits 0 — the two-press path would have exited 130.
        { waitFor: /Press Ctrl-C again to exit/, send: CTRL_D }
      ]
    });
    expect(run.exitCode).toBe(0);
  }, 30000);

  it("quits with 130 on two Ctrl+C presses inside the window", async () => {
    const run = await runPty({
      home: env.home,
      workspace: env.workspace,
      steps: [
        { waitFor: PROMPT, send: CTRL_C },
        { waitFor: /Press Ctrl-C again to exit/, send: CTRL_C }
      ]
    });
    expect(run.exitCode).toBe(130);
    expect(looksLikeCrash(plainPty(run.output, env))).toBe(false);
  }, 30000);
});
