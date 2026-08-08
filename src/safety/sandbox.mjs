/**
 * Phase 6 §2.4.2 — best-effort process sandbox.
 *
 * `wrapShellCommand({ command, sandbox })` returns either the original command
 * or a `bash -c "ulimit ... && exec ..."` wrapper on POSIX so child processes
 * inherit memory / CPU caps. Windows can only enforce a wall-clock timeout
 * via the existing `runShell` timer; we surface that fact in the returned
 * `notes` array so the caller can report it.
 */

const POSIX_PLATFORMS = new Set(["linux", "darwin", "freebsd", "openbsd", "netbsd", "sunos", "aix"]);

export function isPosixPlatform(platform = process.platform) {
  return POSIX_PLATFORMS.has(platform);
}

export function buildUlimitPrefix(sandbox = {}) {
  const parts = [];
  if (Number.isFinite(sandbox.memoryMB) && sandbox.memoryMB > 0) {
    const kb = Math.floor(Number(sandbox.memoryMB) * 1024);
    parts.push(`ulimit -v ${kb}`);
  }
  if (Number.isFinite(sandbox.cpuSeconds) && sandbox.cpuSeconds > 0) {
    parts.push(`ulimit -t ${Math.floor(Number(sandbox.cpuSeconds))}`);
  }
  return parts;
}

/**
 * Wrap the user's command with `ulimit` calls when running on POSIX. Returns
 * `{ command, wrapped, notes }` so the caller can decide whether to re-route
 * the spawn call. Windows / unsupported platforms return `wrapped: false`.
 */
export function wrapShellCommand({ command, sandbox, platform = process.platform } = {}) {
  if (typeof command !== "string" || command.length === 0) {
    return { command, wrapped: false, notes: ["empty command"] };
  }
  if (!sandbox || (sandbox.memoryMB == null && sandbox.cpuSeconds == null)) {
    return { command, wrapped: false, notes: [] };
  }
  if (!isPosixPlatform(platform)) {
    return {
      command,
      wrapped: false,
      notes: ["sandbox: memory/CPU limits unsupported on this platform; relying on timeoutMs"]
    };
  }
  const prefix = buildUlimitPrefix(sandbox);
  if (prefix.length === 0) {
    return { command, wrapped: false, notes: ["sandbox: no applicable ulimit fields"] };
  }
  return {
    command: `${prefix.join(" && ")} && ${command}`,
    wrapped: true,
    notes: [`sandbox: applied ${prefix.join(" + ")}`]
  };
}

/**
 * Resolve effective sandbox settings. Returns `null` when the user did not
 * configure any limits — callers should treat that as "do nothing".
 */
export function resolveSandbox({ settings } = {}) {
  const config = settings?.tools?.sandbox;
  if (!config || typeof config !== "object") return null;
  const out = {};
  if (Number.isFinite(config.memoryMB)) out.memoryMB = Number(config.memoryMB);
  if (Number.isFinite(config.cpuSeconds)) out.cpuSeconds = Number(config.cpuSeconds);
  if (Number.isFinite(config.timeoutMs)) out.timeoutMs = Number(config.timeoutMs);
  return Object.keys(out).length > 0 ? out : null;
}
