/**
 * An async FIFO sink that lets one REPL input pump hand lines (messages AND
 * commands) to a single serial consumer ("the turn executor") WITHOUT ever
 * holding a keyboard prompt during a turn.
 *
 * ┌───────────────┐   push()   ┌──────────────┐   next()   ┌──────────────┐
 * │  input pump   │ ─────────▶ │  turn queue  │ ─────────▶ │  executor    │
 * │ (reads stdin) │            │ (this file)  │            │ (runs turns) │
 * └───────────────┘            └──────────────┘            └──────────────┘
 *
 * The key property: the input pump's `controller.question()` stays armed for
 * the whole REPL (even while a turn runs), so the user can keep typing and
 * submitting. Each submitted line is pushed here and the executor drains it
 * one-at-a-time in FIFO order — the current turn finishes before the next item
 * is started. Commands are just items too, so a `/help` typed during a long
 * turn runs after the current turn, never in the middle of its streaming.
 *
 * There is exactly one producer (the input pump) and one consumer (the
 * executor), so ordering is strict FIFO and no line is ever dropped or
 * duplicated. `close()` wakes a parked consumer with `{ done: true }`, which
 * is how the executor learns the REPL is leaving.
 */
export function createTurnQueue() {
  const items = [];
  const waiters = [];
  let closed = false;
  let closedError = null;

  /** @returns {Promise<{ value?: unknown, done: boolean }>} */
  const next = () => {
    if (items.length > 0) {
      return Promise.resolve({ value: items.shift(), done: false });
    }
    if (closed) {
      return closedError
        ? Promise.reject(closedError)
        : Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  };

  /** @returns {boolean} false if the queue is already closed (line dropped) */
  const push = (item) => {
    if (closed) return false;
    if (waiters.length > 0) {
      const waiter = waiters.shift();
      waiter.resolve({ value: item, done: false });
    } else {
      items.push(item);
    }
    return true;
  };

  /** Wake the consumer exactly once with `{ done: true }` (or reject it). */
  const close = (error = null) => {
    if (closed) return;
    closed = true;
    closedError = error ?? null;
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      if (closedError) waiter.reject(closedError);
      else waiter.resolve({ value: undefined, done: true });
    }
  };

  return {
    next,
    push,
    close,
    get size() {
      return items.length;
    },
    get closed() {
      return closed;
    }
  };
}
