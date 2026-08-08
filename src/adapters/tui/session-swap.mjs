/**
 * P1-7 — swapping the REPL's active session (`/resume`, `/checkout`).
 *
 * Before Phase 1 the swap had no teardown at all, and four things broke at
 * once:
 *
 *  1. the old session's `TimelineRenderer` kept its spinner `setInterval`
 *     running and stayed subscribed to the dead event bus;
 *  2. the old `StreamingRenderer` stayed subscribed too, so a late event on
 *     the old bus could still write to stdout mid-prompt;
 *  3. the approval-prompt / todo subscriptions were never disposed;
 *  4. `attachInterruptHandler` had captured the FIRST session in a closure, so
 *     after `/resume` a Ctrl+C aborted the session you had just left.
 *
 * (4) is fixed at the call site by passing `getSession: () => activeSession`
 * to `attachInterruptHandler`; (1)–(3) are fixed here. `createReplSession`
 * records every subscription it makes on `session.tuiDisposables` so this
 * module can tear them down without knowing what they are.
 */

/** Detach the renderers and adapter subscriptions bound to `session`. */
export function disposeSessionRenderers(session) {
  if (!session) return;
  for (const renderer of [session.timelineRenderer, session.streamingRenderer, session.reasoningRenderer]) {
    try { renderer?.detach?.(); } catch { /* ignore */ }
  }
  for (const disposable of session.tuiDisposables ?? []) {
    try { disposable?.dispose?.(); } catch { /* ignore */ }
  }
  session.tuiDisposables = [];
}

/**
 * Make `next` the active session, tearing down `previous` first.
 *
 * @returns {object} the session the caller should treat as active — `next`
 *   when one was produced, otherwise `previous` (a cancelled picker).
 */
export function swapActiveSession(previous, next) {
  if (!next || next === previous) return previous ?? next ?? null;
  disposeSessionRenderers(previous);
  return next;
}
