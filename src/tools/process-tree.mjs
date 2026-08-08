/**
 * Process-group termination, shared by the foreground shell tool (shell.mjs)
 * and the background shell registry (shell-manager.mjs).
 *
 * Lives in its own dependency-free module because shell.mjs and
 * shell-manager.mjs already reference each other through the delegated-job
 * process driver — putting these here keeps that graph acyclic.
 */

/**
 * POSIX only: children are spawned with `detached: true` so they become their
 * own process-group leader and a kill can reach the WHOLE tree. Windows has no
 * equivalent (`detached` there means "new console"), so it keeps the plain
 * `child.kill()` path.
 */
export const SUPPORTS_PROCESS_GROUPS = process.platform !== "win32";

/** Grace between the polite SIGTERM and the unconditional SIGKILL. */
export const KILL_ESCALATION_MS = 2000;

/**
 * Kill a spawned child AND everything it started.
 *
 * `child.kill()` signals the shell only — a `sleep 30 & wait`, a `pnpm dev`
 * that forks node, or any pipeline leaves ORPHANS behind when the tool
 * "stops". Signalling the NEGATIVE pid targets the whole process group, which
 * `detached: true` made the child the leader of.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @param {NodeJS.Signals|number} signal
 * @param {{ group?: boolean }} [options] `group:false` forces the single-child
 *        fallback (used for children that were NOT spawned detached).
 * @returns {boolean} whether a signal was delivered to something
 */
export function killProcessTree(child, signal, { group = SUPPORTS_PROCESS_GROUPS } = {}) {
  if (!child) return false;
  const pid = child.pid;
  if (group && Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(-pid, signal);
      return true;
    } catch (error) {
      // ESRCH: the group is already gone — nothing left to signal. Anything
      // else (EPERM, a platform that refused the negative pid) falls back to
      // the single child below.
      if (error?.code === "ESRCH") return false;
    }
  }
  try {
    child.kill(signal);
    return true;
  } catch {
    return false;
  }
}
