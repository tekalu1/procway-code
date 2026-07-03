/**
 * Ctrl+C two-stage interrupt handler. First press cancels the in-flight
 * turn (if any); a second press within `windowMs` exits the process.
 *
 * The handler is purely additive — it attaches via `process.on("SIGINT", ...)`
 * and never triggers stdout writes from inside core. It is safe to attach
 * multiple times because each call returns a `dispose()` that cleans up its
 * own listeners.
 *
 * Phase 5 §2.5: in-flight tool runs are NOT killed (per brief). The first
 * Ctrl+C only flips `session.interruptRequested` and emits a `turn.failed`
 * event when the next yield point is reached. Adapters that want to flush
 * any partial deltas should listen for `turn.failed` on the EventBus.
 */
export function attachInterruptHandler({
  session,
  output = process.stderr,
  onTurnAbort,
  onExit,
  windowMs = 5000,
  process: proc = process,
  exit = (code) => proc.exit(code)
} = {}) {
  let lastPressAt = 0;
  let disposed = false;

  const handler = () => {
    if (disposed) return;
    const now = Date.now();
    const within = lastPressAt > 0 && now - lastPressAt <= windowMs;
    lastPressAt = now;
    if (within) {
      try { output.write("\n[Ctrl+C] exiting\n"); } catch { /* ignore */ }
      if (typeof onExit === "function") onExit();
      exit(130);
      return;
    }
    if (typeof onTurnAbort === "function") onTurnAbort();
    if (session && typeof session.abort === "function") session.abort();
    try { output.write("\n[Ctrl+C] interrupting current turn — press again to exit\n"); } catch { /* ignore */ }
  };

  proc.on("SIGINT", handler);

  return {
    dispose() {
      disposed = true;
      proc.removeListener("SIGINT", handler);
    },
    /** Test hook — simulate a Ctrl+C without raising a real signal. */
    trigger: handler
  };
}
