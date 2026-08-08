/**
 * Shared abort vocabulary for a turn.
 *
 * A user Stop (Ctrl+C / the dashboard Stop button) must look IDENTICAL to the
 * user no matter where it lands — between rounds, mid-stream inside the
 * provider's SSE loop, or inside a running tool. That requires one message,
 * one code, and one recognizable abort `reason` that every layer can test for.
 * This module owns all four; it deliberately has no imports so any layer
 * (providers, tools, agent) can use it without creating an import cycle.
 */

/** The single user-facing wording for "the user pressed Stop / Ctrl+C". */
export const USER_INTERRUPT_MESSAGE = "Interrupted by user";
export const USER_INTERRUPT_CODE = "interrupted";
const USER_INTERRUPT_NAME = "UserInterruptAbort";

/**
 * The abort reason `session.abort()` passes to `AbortController.abort()`. It is
 * a real Error (not a bare tag object) because undici rejects an aborted fetch
 * WITH the reason — so even a layer that lets it escape unmapped renders the
 * unified message instead of the raw DOMException "This operation was aborted".
 */
export function createUserInterruptAbort() {
  const error = new Error(USER_INTERRUPT_MESSAGE);
  error.name = USER_INTERRUPT_NAME;
  error.code = USER_INTERRUPT_CODE;
  return error;
}

/** True for the reason/error produced by createUserInterruptAbort(). */
export function isUserInterruptAbort(value) {
  if (!value || typeof value !== "object") return false;
  return value.name === USER_INTERRUPT_NAME || value.code === USER_INTERRUPT_CODE;
}

/**
 * True when `error` is (or wraps) an abort of any kind — user Stop, idle
 * watchdog, or a plain DOMException / undici AbortError. Used to decide whether
 * a mid-stream failure should still commit its partial assistant output.
 */
export function isAbortError(error, depth = 0) {
  if (!error || typeof error !== "object" || depth > 4) return false;
  if (isUserInterruptAbort(error)) return true;
  if (error.name === "AbortError" || error.name === "IdleWatchdogAbort") return true;
  if (error.code === "ABORT_ERR" || error.code === 20) return true;
  return isAbortError(error.cause, depth + 1);
}

/**
 * Combine several (possibly undefined) AbortSignals into one that aborts as
 * soon as any input does, propagating the first reason. Node's
 * `AbortSignal.any` only landed in 20.3 and this package supports >=20.0, so
 * roll it by hand — no dependency, same semantics.
 */
export function anySignal(signals) {
  const list = (Array.isArray(signals) ? signals : [signals]).filter(Boolean);
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  const already = list.find((s) => s.aborted);
  if (already) return already;
  const controller = new AbortController();
  const listeners = [];
  const onAbort = (reason) => {
    for (const { signal, handler } of listeners) {
      try { signal.removeEventListener?.("abort", handler); } catch { /* ignore */ }
    }
    listeners.length = 0;
    try { controller.abort(reason); } catch { /* already aborted */ }
  };
  for (const signal of list) {
    const handler = () => onAbort(signal.reason);
    listeners.push({ signal, handler });
    signal.addEventListener?.("abort", handler, { once: true });
  }
  return controller.signal;
}
