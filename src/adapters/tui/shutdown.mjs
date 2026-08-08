/**
 * One exit path for the REPL (P2-5).
 *
 * Before Phase 2 leaving the REPL meant one of five different things:
 *
 *  - `interrupt.mjs` called `exit(130)` synchronously — no `session.save()`,
 *    no `shellManager.closeAll()`, so the last turn and any background shell
 *    were lost;
 *  - `/exit` called no `process.exit` at all, so undici's keep-alive socket
 *    pool and MCP stdio children kept the event loop pinned and the process
 *    hung after the goodbye line (`runPrompt` and `auth` both had teardown —
 *    only the REPL did not);
 *  - Ctrl+D rejected the pending question and fell out of the loop;
 *  - an uncaught error propagated to `main().catch`;
 *  - SIGTERM was not handled at all, so Node's default killed the process
 *    instantly: no save, no child reaping.
 *
 * `createShutdown()` collapses all of that into one idempotent sequence:
 *
 *   1. abort the in-flight turn and give it a short window to unwind;
 *   2. `session.save({ force: true })`;
 *   3. reap background shells and MCP stdio children;
 *   4. dispose the input controller (raw mode off, bracketed paste off,
 *      keypress listeners removed, spinner line erased);
 *   5. flush stdio and `process.exit(code)`.
 *
 * Note on `tools/shell.mjs`: it installs a `process.on("exit")` reaper that
 * SIGKILLs any still-tracked FOREGROUND child's process group. That is a
 * last-resort net and stays — by the time it runs, step 1 has already
 * terminated those groups and the tracking set is normally empty, so it is a
 * no-op rather than a double kill.
 */

import path from "node:path";
import { dim, supportsColor } from "./ansi.mjs";
import { sanitizeInline } from "./sanitize.mjs";

const DEFAULT_JOIN_MS = 1500;
const DEFAULT_GRACE_MS = 2000;

/**
 * Leaving on purpose prints the command that brings this conversation back.
 * SIGTERM (a supervisor killing us) and crash paths stay silent: nobody is
 * reading that terminal, and a hint under a stack trace is noise.
 */
const RESUME_HINT_REASONS = new Set(["exit-command", "eof", "sigint"]);

export function createShutdown({
  getSession = () => null,
  controller = null,
  shellManager = null,
  output = process.stdout,
  errorOutput = process.stderr,
  exit = (code) => process.exit(code),
  joinMs = DEFAULT_JOIN_MS,
  graceMs = DEFAULT_GRACE_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onWarn = null,
  argv = process.argv,
  colorize = null
} = {}) {
  let running = null;

  async function shutdown({ code = 0, reason = "exit" } = {}) {
    if (running) return running;
    running = perform({ code, reason });
    return running;
  }

  async function perform({ code, reason }) {
    const session = safe(() => getSession(), null);

    // 1. Stop the turn. abort() reaches the provider fetch/SSE, the tool
    //    scheduler and run_shell's process group (AbortSignal work), so the
    //    join below is just letting the unwind finish.
    if (session?.abort) {
      safe(() => session.abort());
      const deadline = Date.now() + joinMs;
      while (session.runningTurn === true && Date.now() < deadline) {
        await sleep(25);
      }
    }

    // 2. Persist. force: true bypasses the snapshot throttle — this is the
    //    last write of the process.
    if (session?.save) {
      try {
        await session.save({ force: true });
      } catch (error) {
        warn(`session save failed: ${error?.message ?? error}`);
      }
    }

    // 3. Reap children: background shells first, then MCP stdio servers.
    if (shellManager?.closeAll) {
      try {
        await shellManager.closeAll({ graceMs });
      } catch (error) {
        warn(`shell cleanup failed: ${error?.message ?? error}`);
      }
    }
    const registry = session?.mcpRegistry;
    if (registry?.close) {
      try {
        await registry.close();
      } catch (error) {
        warn(`mcp cleanup failed: ${error?.message ?? error}`);
      }
    }

    // 4. Give the terminal back.
    safe(() => controller?.dispose?.());

    // 4b. …and tell the user how to come back. After dispose(), so the hint
    //     lands on a clean row instead of the erased prompt/spinner line.
    if (RESUME_HINT_REASONS.has(reason)) {
      const hint = renderResumeHint({
        session,
        command: resumeCommandName(argv),
        colorize: colorize ?? safe(() => supportsColor(output), false)
      });
      if (hint) safe(() => output.write(hint));
    }

    // 5. Flush, then leave. Without the explicit exit, undici's keep-alive
    //    pool alone can hold the loop open for a minute.
    await flush(output);
    await flush(errorOutput);
    exit(code);
    return code;
  }

  function warn(message) {
    if (typeof onWarn === "function") { safe(() => onWarn(message)); return; }
    safe(() => errorOutput.write(`[shutdown] ${message}\n`));
  }

  shutdown.isRunning = () => running != null;
  return shutdown;
}

/**
 * The "how do I get back in?" footer.
 *
 * Silent when there is nothing to come back to: no session id, persistence
 * turned off (`session.enabled: false` never writes a snapshot, so the id
 * would not resolve), or a conversation with no turns in it — the id of a
 * session where nobody said anything is not worth a line.
 *
 * @returns {string} "" when no hint applies.
 */
export function renderResumeHint({ session, command = "procway-code", colorize = false } = {}) {
  const sessionId = typeof session?.sessionId === "string" ? session.sessionId : "";
  if (!sessionId) return "";
  if (session?.settings?.session?.enabled === false) return "";
  if (conversationTurns(session?.messages) === 0) return "";
  const label = "Resume this session:";
  // The id is read back out of the session store and the command name off
  // argv[1]; neither is guaranteed to be the ULID/basename we expect once a
  // session directory can be shared or restored.
  const line = `  ${sanitizeInline(command)} resume ${sanitizeInline(sessionId)}`;
  return colorize ? `\n${dim(label)}\n${dim(line)}\n` : `\n${label}\n${line}\n`;
}

/** User/assistant messages — the system prompt alone is not a conversation. */
function conversationTurns(messages) {
  if (!Array.isArray(messages)) return 0;
  return messages.filter((message) => message?.role === "user" || message?.role === "assistant").length;
}

/**
 * What the user typed to start us. Installed, that is `procway-code`; in this
 * repo it is `node src/cli.mjs`, and printing the installed name there would
 * hand out a command that does not exist on the machine.
 */
export function resumeCommandName(argv = process.argv) {
  const entry = typeof argv?.[1] === "string" ? argv[1] : "";
  if (!entry) return "procway-code";
  const base = path.basename(entry);
  // The bin shim keeps its own name (`procway-code`), so the shebang gives us
  // exactly what the user typed.
  if (!base.endsWith(".mjs") && !base.endsWith(".js")) return base || "procway-code";
  // Launched through a wrapper that resolved the real file inside a package
  // install — the command the user has on PATH is still the bin name.
  if (entry.includes(`${path.sep}node_modules${path.sep}`)) return "procway-code";
  const relative = safe(() => path.relative(process.cwd(), entry), entry) ?? entry;
  const target = relative && !relative.startsWith("..") ? relative : entry;
  return `${path.basename(argv?.[0] ?? "node") || "node"} ${target}`;
}

function safe(fn, fallback = undefined) {
  try { return fn(); } catch { return fallback; }
}

/** Resolve once the stream has drained (or immediately when it never buffered). */
function flush(stream) {
  return new Promise((resolve) => {
    if (!stream || typeof stream.write !== "function") { resolve(); return; }
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    try {
      if (stream.write("")) { done(); return; }
      stream.once("drain", done);
      setTimeout(done, 200).unref?.();
    } catch {
      done();
    }
  });
}
