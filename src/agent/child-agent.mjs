import path from "node:path";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";

/**
 * Global semaphore for child agent concurrency.
 * All AgentSession instances share this so the max is enforced
 * across the entire process regardless of nesting depth.
 */
const globalSemaphore = {
  active: 0,
  maxConcurrent: 4,
  queue: []
};

const WORKER_ENTRY_URL = new URL("./child-worker.mjs", import.meta.url);

export function setGlobalMaxConcurrentAgents(n) {
  globalSemaphore.maxConcurrent = Math.max(1, n);
}

function acquireGlobal() {
  return new Promise((resolve) => {
    if (globalSemaphore.active < globalSemaphore.maxConcurrent) {
      globalSemaphore.active += 1;
      resolve();
      return;
    }
    globalSemaphore.queue.push(resolve);
  });
}

function releaseGlobal() {
  globalSemaphore.active -= 1;
  const next = globalSemaphore.queue.shift();
  if (next) {
    globalSemaphore.active += 1;
    next();
  }
}

/**
 * @param {{
 *   settings: object,
 *   cwd: string,
 *   runAgentImpl: Function,
 *   forkImpl?: Function,
 *   workerEntry?: string,
 * }} options
 */
export function createChildAgentManager({ settings, cwd, runAgentImpl, forkImpl = fork, workerEntry } = {}) {
  setGlobalMaxConcurrentAgents(settings?.agents?.maxConcurrentAgents ?? 4);
  const isolation = settings?.agents?.isolation ?? "inline";
  const entryPath = workerEntry ?? fileURLToPath(WORKER_ENTRY_URL);

  return {
    isolation,
    // ADR 0029 P3: `onEvent` (best-effort child progress tap) and `signal`
    // (abort the inline session / forked child) are OPTIONAL — when absent the
    // behavior is byte-identical to before. The agent-kind delegated-job driver
    // threads them through so a sub-agent gains the unified lifecycle + progress
    // streaming + kill the registry contract provides.
    async run({ task, childCwd = cwd, depth = 0, onEvent, signal }) {
      const maxDepth = settings?.agents?.maxDepth ?? 3;
      if (depth >= maxDepth) {
        throw new Error(`Child agent max depth exceeded: ${maxDepth}`);
      }
      await acquireGlobal();
      try {
        const resolvedCwd = resolveChildCwd(cwd, childCwd);
        if (isolation === "fork") {
          return await runForked({
            settings,
            task,
            cwd: resolvedCwd,
            depth: depth + 1,
            forkImpl,
            entryPath,
            onEvent,
            signal
          });
        }
        const result = await runAgentImpl({
          settings,
          prompt: task,
          cwd: resolvedCwd,
          depth: depth + 1,
          childAgentManager: this,
          onEvent,
          signal
        });
        return {
          cwd: resolvedCwd,
          depth: depth + 1,
          exitCode: result?.exitCode ?? 0,
          text: result?.text ?? "",
          sessionId: result?.sessionId
        };
      } finally {
        releaseGlobal();
      }
    },
    getActiveCount() {
      return globalSemaphore.active;
    }
  };
}

async function runForked({ settings, task, cwd, depth, forkImpl, entryPath, onEvent, signal }) {
  return await new Promise((resolve, reject) => {
    let settled = false;
    let pendingResult = null;
    let pendingError = null;
    const child = forkImpl(entryPath, [], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe", "ipc"]
    });
    // ADR 0029 P3: kill via the registry handle aborts the forked child. Honor
    // an already-aborted signal too so a race can't strand a live child.
    let onAbort = null;
    if (signal) {
      onAbort = () => { try { child.kill(); } catch { /* ignored */ } };
      if (signal.aborted) onAbort();
      else signal.addEventListener?.("abort", onAbort, { once: true });
    }
    const cleanupAbort = () => { try { signal?.removeEventListener?.("abort", onAbort); } catch { /* ignored */ } };
    child.on("message", (message) => {
      if (!message || typeof message !== "object") return;
      // Forward any non-terminal IPC message as best-effort progress (child-worker
      // may emit `{ kind:'progress', ... }` in a later phase; today it doesn't, so
      // the driver's own heartbeat carries liveness for fork children).
      if (message.kind !== "done" && message.kind !== "failed" && typeof onEvent === "function") {
        try { onEvent({ source: "fork", ...message }); } catch { /* best-effort */ }
      }
      if (message.kind === "done") {
        pendingResult = {
          cwd,
          depth,
          exitCode: message.exitCode ?? 0,
          text: typeof message.text === "string" ? message.text : "",
          sessionId: message.sessionId
        };
        try { child.kill(); } catch { /* ignored */ }
      } else if (message.kind === "failed") {
        pendingError = new Error(message.error?.message ?? "Forked child agent failed");
        try { child.kill(); } catch { /* ignored */ }
      }
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanupAbort();
      reject(error);
    });
    child.on("exit", (code, exitSignal) => {
      if (settled) return;
      settled = true;
      cleanupAbort();
      if (pendingError) return reject(pendingError);
      if (pendingResult) return resolve(pendingResult);
      reject(new Error(`Forked child agent exited unexpectedly (code=${code}, signal=${exitSignal})`));
    });
    child.send({
      kind: "run",
      settings,
      task,
      cwd,
      depth
    });
  });
}

function resolveChildCwd(parentCwd, childCwd) {
  const root = path.resolve(parentCwd);
  const resolved = path.resolve(root, childCwd);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Child agent cwd escapes workspace: ${childCwd}`);
  }
  return resolved;
}
