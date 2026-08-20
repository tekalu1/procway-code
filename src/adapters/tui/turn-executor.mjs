/**
 * The REPL's turn executor — the single serial consumer of the turn queue
 * (turn-queue.mjs), extracted from cli.mjs so its routing rules are testable.
 *
 * Two kinds of item reach it:
 *
 *   - a **string**: a line the user submitted. It is a `/command` first
 *     (`dispatch`) and a message to the model second (`runMessage`, which is
 *     where `@file` / `!shell` expansion happens).
 *   - a **wake item** (`{kind:"wake", text}`, event-wake / issue #143): a
 *     synthetic turn the wake supervisor produced because background work
 *     settled. It goes STRAIGHT to `runWake`, deliberately skipping both of
 *     the above:
 *       · `dispatch` — the wake body is machine-written text that may begin
 *         with `/`, and a slash-command interpretation would silently eat it;
 *       · `@` / `!` expansion — a path or shell-looking fragment inside a child
 *         agent's result would pop an approval prompt for something the user
 *         never typed.
 *
 * Because there is exactly one consumer, a wake queued while a turn is running
 * simply runs after it: the FIFO is the concurrency guard, which is why the
 * REPL replaces the supervisor's default injector (a direct `session.runTurn`)
 * with one that pushes here instead.
 */

export const WAKE_ITEM_KIND = "wake";

/**
 * The one-line, muted marker the terminal prints in place of a wake turn's
 * body. Exported (rather than inlined at the call site) because it is printed
 * TWICE: live, by the REPL's `runWake`, and on replay, by
 * transcript-node-render's `wake` node — a resumed session must read exactly
 * like the session did when it happened.
 */
export const WAKE_NOTICE_LINE = "· background work settled — resuming automatically";

/** Wrap a wake body as a queue item. */
export function makeWakeItem(text) {
  return { kind: WAKE_ITEM_KIND, text: typeof text === "string" ? text : String(text ?? "") };
}

/**
 * @returns {string | null} the wake body, or null when `value` is not a wake
 *   item (or carries nothing worth a turn).
 */
export function readWakeText(value) {
  if (!value || typeof value !== "object" || value.kind !== WAKE_ITEM_KIND) return null;
  const text = typeof value.text === "string" ? value.text : "";
  return text.trim() ? text : null;
}

/**
 * Build the wake-supervisor injector for a queue-owning surface.
 *
 * Never throws and never rejects: a closed queue means the REPL is leaving, and
 * a rejected injection would only make the supervisor retry into the void.
 *
 * @param {{ queue: { push: (item: unknown) => boolean } }} input
 * @returns {(text: string) => Promise<boolean>} true when the wake was queued
 */
export function createWakeInjector({ queue }) {
  return async (text) => {
    const item = makeWakeItem(text);
    if (readWakeText(item) === null) return false;
    try {
      return queue?.push(item) === true;
    } catch {
      return false;
    }
  };
}

/**
 * Drain the queue one item at a time until it closes.
 *
 * @param {object} input
 * @param {{ next: () => Promise<{value?: unknown, done: boolean}> }} input.queue
 * @param {(line: string) => Promise<boolean>} input.dispatch  true = consumed as a /command
 * @param {(line: string) => Promise<void>} input.runMessage   user message → turn
 * @param {(text: string) => Promise<void>} input.runWake      wake body → turn
 */
export async function drainTurnQueue({ queue, dispatch, runMessage, runWake }) {
  for (;;) {
    const { value, done } = await queue.next();
    if (done) break;
    const wakeText = readWakeText(value);
    if (wakeText !== null) {
      await runWake(wakeText);
      continue;
    }
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!trimmed) continue;
    if (await dispatch(trimmed)) continue;
    await runMessage(trimmed);
  }
}
