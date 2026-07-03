import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { getShellProfile } from "../platform/shell-profile.mjs";

const RING_BUFFER_BYTES = 1024 * 1024;

class RingBuffer {
  constructor(maxBytes = RING_BUFFER_BYTES) {
    this.maxBytes = maxBytes;
    this.text = "";
    this.totalBytes = 0;
  }

  append(chunk) {
    if (typeof chunk !== "string") chunk = String(chunk ?? "");
    if (chunk.length === 0) return;
    this.totalBytes += Buffer.byteLength(chunk, "utf8");
    this.text = (this.text + chunk).slice(-this.maxBytes);
  }

  read({ tail } = {}) {
    if (!Number.isFinite(tail) || tail <= 0) return this.text;
    const lines = this.text.split("\n");
    const tailIndex = Math.max(0, lines.length - Math.floor(tail));
    return lines.slice(tailIndex).join("\n");
  }

  get bytes() {
    return Buffer.byteLength(this.text, "utf8");
  }

  get truncated() {
    return this.totalBytes > Buffer.byteLength(this.text, "utf8");
  }
}

/**
 * Phase 6 §2.3 — registry of running background shells.
 *
 * `start({ command, cwd })` spawns the child via the platform shell profile,
 * captures stdout/stderr into per-stream ring buffers, and returns
 * `{ shellId, pid }`. Subsequent calls (`status`, `logs`, `kill`) are keyed
 * by `shellId`.
 *
 * `closeAll()` is invoked on session shutdown — sends SIGTERM, waits up to 5s,
 * then SIGKILL. `now()` is exposed as a constructor option to keep tests
 * deterministic.
 */
export class ShellManager {
  constructor({ now = () => Date.now(), spawnImpl = spawn, idFactory = randomUUID } = {}) {
    this.now = now;
    this.spawnImpl = spawnImpl;
    this.idFactory = idFactory;
    this.shells = new Map();
  }

  start({ command, cwd = process.cwd(), env = process.env, label = null } = {}) {
    if (typeof command !== "string" || command.length === 0) {
      throw new TypeError("ShellManager.start: command is required");
    }
    const profile = getShellProfile();
    const child = this.spawnImpl(profile.shell, [...profile.args, command], {
      cwd: path.resolve(cwd),
      env: { ...env, ...(profile.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const shellId = this.idFactory();
    const stdout = new RingBuffer();
    const stderr = new RingBuffer();
    const entry = {
      shellId,
      command,
      cwd: path.resolve(cwd),
      label,
      pid: child.pid ?? null,
      child,
      stdout,
      stderr,
      startedAt: this.now(),
      status: "running",
      exitCode: null,
      exitedAt: null,
      error: null
    };
    child.stdout?.on("data", (chunk) => stdout.append(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk) => stderr.append(chunk.toString("utf8")));
    child.on("error", (error) => {
      entry.error = error?.message ?? String(error);
    });
    child.on("close", (code) => {
      entry.status = "exited";
      entry.exitCode = code ?? null;
      entry.exitedAt = this.now();
    });
    // Critical: don't let backgrounded shells pin the agent's event loop.
    //
    // Agents commonly run `pnpm dev` / dev servers via runInBackground:true.
    // On Windows the bg shell's grandchildren (cmd → node nuxt) escape the
    // immediate child's job, so even after closeAll SIGTERMs the bash child,
    // the grandchildren still hold the inherited stdio write ends of the
    // pipes we set up here. That keeps stdout/stderr Readable streams alive
    // and the agent process never exits — meta.json stays `running` forever.
    //
    // unref() releases the underlying handles from the libuv keep-alive
    // accounting. The streams still emit `data`/`close` while the agent has
    // other work pending; they just stop blocking process exit once it
    // doesn't.
    try { child.unref?.() } catch { /* nothing to unref on mocks */ }
    try { child.stdout?.unref?.() } catch { /* mock streams */ }
    try { child.stderr?.unref?.() } catch { /* mock streams */ }
    this.shells.set(shellId, entry);
    return { shellId, pid: entry.pid };
  }

  status(shellId) {
    const entry = this.requireShell(shellId);
    const elapsed = (entry.exitedAt ?? this.now()) - entry.startedAt;
    return {
      shellId,
      command: entry.command,
      cwd: entry.cwd,
      status: entry.status,
      pid: entry.pid,
      exitCode: entry.exitCode,
      runningMs: Math.max(0, elapsed),
      runningSec: Math.max(0, Math.floor(elapsed / 1000)),
      stdoutBytes: entry.stdout.bytes,
      stderrBytes: entry.stderr.bytes,
      error: entry.error
    };
  }

  logs(shellId, { stream = "both", tail = null } = {}) {
    const entry = this.requireShell(shellId);
    const want = (stream ?? "both").toLowerCase();
    const result = {
      shellId,
      stdout: "",
      stderr: "",
      truncated: false
    };
    if (want === "stdout" || want === "both") {
      result.stdout = entry.stdout.read({ tail });
      result.truncated ||= entry.stdout.truncated;
    }
    if (want === "stderr" || want === "both") {
      result.stderr = entry.stderr.read({ tail });
      result.truncated ||= entry.stderr.truncated;
    }
    return result;
  }

  async kill(shellId, { signal = "SIGTERM", graceMs = 0 } = {}) {
    const entry = this.requireShell(shellId);
    if (entry.status === "exited") {
      return { shellId, killed: false, exitCode: entry.exitCode, alreadyExited: true };
    }
    try {
      entry.child.kill(signal);
    } catch (error) {
      entry.error = error?.message ?? String(error);
    }
    if (graceMs > 0) {
      await waitFor(() => entry.status === "exited", { timeoutMs: graceMs });
      if (entry.status !== "exited") {
        try {
          entry.child.kill("SIGKILL");
        } catch (error) {
          entry.error = error?.message ?? String(error);
        }
      }
    }
    return { shellId, killed: true, exitCode: entry.exitCode };
  }

  list() {
    const out = [];
    for (const shellId of this.shells.keys()) out.push(this.status(shellId));
    return out;
  }

  has(shellId) {
    return this.shells.has(shellId);
  }

  forget(shellId) {
    return this.shells.delete(shellId);
  }

  async closeAll({ graceMs = 5000 } = {}) {
    const ids = [...this.shells.keys()];
    for (const id of ids) {
      const entry = this.shells.get(id);
      if (!entry || entry.status === "exited") continue;
      try {
        entry.child.kill("SIGTERM");
      } catch {
        // ignored
      }
    }
    await waitFor(() => {
      for (const entry of this.shells.values()) {
        if (entry.status !== "exited") return false;
      }
      return true;
    }, { timeoutMs: graceMs });
    for (const entry of this.shells.values()) {
      if (entry.status !== "exited") {
        try {
          entry.child.kill("SIGKILL");
        } catch {
          // ignored
        }
      }
    }
  }

  requireShell(shellId) {
    const entry = this.shells.get(shellId);
    if (!entry) throw new Error(`Unknown shellId: ${shellId}`);
    return entry;
  }
}

let SHARED_INSTANCE = null;

export function getSharedShellManager() {
  if (!SHARED_INSTANCE) SHARED_INSTANCE = new ShellManager();
  return SHARED_INSTANCE;
}

export function resetSharedShellManagerForTests() {
  SHARED_INSTANCE = new ShellManager();
  return SHARED_INSTANCE;
}

async function waitFor(predicate, { timeoutMs = 1000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}
