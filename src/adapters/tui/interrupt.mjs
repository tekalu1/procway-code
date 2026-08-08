/**
 * Ctrl+C / Esc handling, branched on session state (P2-4, Claude Code parity).
 *
 *                      first press                     second press (<2s)
 *   idle               clear the input line +          exit
 *                      "(Press Ctrl-C again to exit)"
 *   turn running       interrupt THE TURN only →       (counter was reset —
 *                      "Interrupted by user" →         this is an idle first
 *                      back to the prompt              press again)
 *
 * Why the branch matters: before Phase 2 the first Ctrl+C always armed the
 * exit counter, so a user who stopped a runaway turn and then immediately
 * pressed Ctrl+C again — the natural reflex when the terminal looks busy —
 * killed the session and lost the transcript. Interrupting a turn now
 * deliberately RESETS the counter (`armed = false`): quitting is only ever two
 * presses at an *idle* prompt.
 *
 * Esc maps to the same two actions minus the exit path (`triggerEscape`).
 * Before Phase 2 Esc did nothing at all in the REPL — only the session picker
 * looked at `key.name === "escape"`.
 *
 * In a TTY the controller feeds `trigger()` directly (raw mode clears termios
 * ISIG, so no SIGINT is ever raised); the `process.on("SIGINT")` registration
 * is what covers piped/non-TTY runs and external `kill -INT`.
 */

import { USER_INTERRUPT_MESSAGE } from "../../agent/abort.mjs";

export function attachInterruptHandler({
  session,
  getSession,
  output = process.stderr,
  onTurnAbort,
  onExit,
  onIdleFirstPress,
  isTurnRunning,
  windowMs = 2000,
  process: proc = process,
  exit = (code) => proc.exit(code)
} = {}) {
  let lastPressAt = 0;
  let armed = false;
  let disposed = false;

  const target = () => (typeof getSession === "function" ? getSession() : session);

  const running = () => {
    if (typeof isTurnRunning === "function") return Boolean(isTurnRunning());
    // No explicit predicate (one-shot callers, embedders): fall back to the
    // session's own flag, and to "assume running" when it has none.
    const current = target();
    if (current && typeof current.runningTurn === "boolean") return current.runningTurn;
    return true;
  };

  const write = (text) => {
    try { output.write(text); } catch { /* ignore */ }
  };

  const interruptTurn = () => {
    if (typeof onTurnAbort === "function") onTurnAbort();
    const current = target();
    let aborted = false;
    if (current && typeof current.abort === "function") aborted = current.abort() !== false;
    // The turn settles as `{ error: "Interrupted by user" }` (conversation.mjs
    // maps every abort site to that one message) and prints nothing itself —
    // this is the line the user sees.
    write(`\n${USER_INTERRUPT_MESSAGE}\n`);
    // Stopping a turn must never arm "press again to exit".
    armed = false;
    lastPressAt = 0;
    return aborted;
  };

  const handler = () => {
    if (disposed) return;
    if (running()) { interruptTurn(); return; }

    const now = Date.now();
    if (armed && lastPressAt > 0 && now - lastPressAt <= windowMs) {
      write("\n");
      if (typeof onExit === "function") onExit();
      exit(130);
      return;
    }
    lastPressAt = now;
    armed = true;
    if (typeof onIdleFirstPress === "function") onIdleFirstPress();
    write("\n(Press Ctrl-C again to exit)\n");
  };

  /** Esc: same state branch, but it never exits. */
  const escapeHandler = () => {
    if (disposed) return;
    if (running()) { interruptTurn(); return; }
    if (typeof onIdleFirstPress === "function") onIdleFirstPress();
  };

  proc.on("SIGINT", handler);

  return {
    dispose() {
      disposed = true;
      proc.removeListener("SIGINT", handler);
    },
    /** Ctrl+C — called by the input controller (raw mode) and by SIGINT. */
    trigger: handler,
    /** Esc — interrupt while running, clear the line while idle. */
    triggerEscape: escapeHandler
  };
}
