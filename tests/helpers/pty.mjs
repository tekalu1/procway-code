/**
 * A pseudo-terminal harness for the CLI (P4-3).
 *
 * Why this exists: every unit test in this repo calls the renderers with a
 * fake writer, and every one of them passed while the real program was
 * printing a stack trace on Ctrl+D, drawing the welcome box one column too
 * wide, and collapsing every panel in a pty that reports `columns === 0`.
 * None of those are reachable without a real terminal on the other end of
 * `process.stdout`, so these helpers start `src/cli.mjs` under a pty and read
 * back exactly what a user would see.
 *
 * The pty comes from util-linux `script(1)` rather than a native addon:
 * procway-code publishes its `pnpm-lock.yaml` to npm, so `node-pty` would
 * become part of what every user downloads. `script -qec CMD /dev/null` runs
 * CMD on a pty and copies our stdin to it, which is all the harness needs.
 *
 * Determinism rules followed here:
 *  - the child gets a hand-built env (no API keys, no PROCWAY_*, no DISPLAY),
 *    a fresh HOME and a fresh cwd, so nothing on the developer's machine
 *    leaks into the output;
 *  - input is sent only after the expected output has arrived (`waitFor`),
 *    never after a fixed sleep;
 *  - every match consumes the output up to its end, so waiting for the prompt
 *    twice means two prompts, not one prompt matched twice;
 *  - snapshots slice the output on CONTENT — repaint frames, panel headings —
 *    and never on a byte offset. See the note above `FRAME_START` for the bug
 *    that taught us the difference; it only showed up under CPU load.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ansiToPlaceholders } from "../../src/adapters/tui/ansi.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const CLI_PATH = path.join(here, "..", "..", "src", "cli.mjs");

let supported = null;

/**
 * True when this machine can run the harness: Linux with a util-linux
 * `script` that understands `-qec`. macOS/BSD ship a `script` with an
 * incompatible argument order, so the pty scenarios skip there rather than
 * pretend to pass. Everything they cover is also covered — less faithfully —
 * by the renderer unit tests.
 */
export function ptySupported() {
  if (supported !== null) return supported;
  if (process.platform !== "linux") return (supported = false);
  const probe = spawnSync("script", ["-qec", "printf ok", "/dev/null"], {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"]
  });
  supported = probe.status === 0 && /ok/.test(probe.stdout ?? "");
  return supported;
}

/**
 * A disposable HOME + workspace for one pty run.
 *
 * The workspace is always named `workspace` so the prompt header (which shows
 * the cwd basename) is byte-identical between runs and machines; the absolute
 * path still differs and is normalized out of snapshots by `normalizePty`.
 */
export async function makePtyEnv({ settings = {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "procway-pty-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  await mkdir(path.join(home, ".procway", "ai-agent"), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(
    path.join(home, ".procway", "ai-agent", "settings.json"),
    JSON.stringify({
      // Pinned rather than inherited from DEFAULT_SETTINGS: a change to the
      // shipped default model should not rewrite every pty snapshot.
      defaultProvider: "openai-main",
      approvalMode: "auto-readonly",
      providers: {
        "openai-main": { type: "openai", apiKeyEnv: "OPENAI_API_KEY", baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-test" }
      },
      ...settings
    }, null, 2) + "\n",
    "utf8"
  );
  return {
    root,
    home,
    workspace,
    cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 5 })
  };
}

/**
 * Run the CLI on a pty and drive it.
 *
 * @param {object} options
 * @param {string} options.home             HOME for the child.
 * @param {string} options.workspace        cwd for the child.
 * @param {string[]} [options.args]         extra CLI argv.
 * @param {number} [options.cols]           terminal width. `0` leaves the pty
 *   at its default size, which reports `columns === 0` — the shape that broke
 *   every panel in Phase 3b, so it is a scenario, not an accident.
 * @param {number} [options.rows]
 * @param {Array<{waitFor?: RegExp, send?: string, timeoutMs?: number}>} [options.steps]
 *   Wait for `waitFor` to appear, then write `send`. The process is always
 *   awaited to exit after the last step.
 * @param {number} [options.timeoutMs]      hard kill for the whole run.
 * @returns {Promise<{output: string, exitCode: number|null, signal: string|null,
 *   stderr: string}>} the raw pty bytes plus how the child ended. Cut the
 *   output up with `frames` / `lastFrameWith` / `framesBetween` / `blockFrom`
 *   — never by byte offset, see the note above `FRAME_START`.
 */
export async function runPty({
  home,
  workspace,
  args = [],
  cols = 80,
  rows = 24,
  steps = [],
  timeoutMs = 20000
} = {}) {
  const size = cols > 0 ? `stty cols ${cols} rows ${rows} >/dev/null 2>&1; ` : "";
  const command = `${size}exec node ${JSON.stringify(CLI_PATH)}${args.map((a) => ` ${JSON.stringify(a)}`).join("")}`;
  const child = spawn("script", ["-qec", command, "/dev/null"], {
    cwd: workspace,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      // Deliberately minimal. Anything not listed here (OPENAI_API_KEY,
      // ANTHROPIC_API_KEY, PROCWAY_*, DISPLAY, NO_COLOR, FORCE_COLOR,
      // COLORTERM, TERM_PROGRAM …) is absent, which is what makes the
      // rendering — colour level, hyperlink support, which tools report
      // themselves unavailable — reproducible on any machine.
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      TMPDIR: os.tmpdir(),
      TERM: "xterm-256color",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8"
    }
  });

  let output = "";
  let stderr = "";
  let cursor = 0;
  const waiters = [];

  const pump = () => {
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i];
      waiter.pattern.lastIndex = 0;
      const match = waiter.pattern.exec(output.slice(cursor));
      if (match) {
        cursor += match.index + match[0].length;
        waiters.splice(i, 1);
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
    }
  };

  child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); pump(); });
  // Writing to a child that has already exited must surface as a failed
  // `waitFor` (with the captured output), not as an unhandled EPIPE.
  child.stdin.on("error", () => {});
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });

  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  const waitFor = (pattern, ms) => new Promise((resolve, reject) => {
    const waiter = {
      pattern: new RegExp(pattern.source, pattern.flags.replace("g", "")),
      resolve,
      timer: setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(
          `pty: timed out after ${ms}ms waiting for ${pattern}\n`
          + `--- output since the last match ---\n${normalizePty(output.slice(cursor), { home, workspace })}\n`
        ));
      }, ms)
    };
    waiters.push(waiter);
    pump();
  });

  const guard = setTimeout(() => { child.kill("SIGKILL"); }, timeoutMs);
  try {
    for (const step of steps) {
      if (step.waitFor) await waitFor(step.waitFor, step.timeoutMs ?? 10000);
      if (typeof step.send === "string") child.stdin.write(step.send);
    }
    const { code, signal } = await exited;
    return { output, stderr, exitCode: code, signal };
  } catch (error) {
    child.kill("SIGKILL");
    await exited;
    throw error;
  } finally {
    clearTimeout(guard);
    for (const waiter of waiters) clearTimeout(waiter.timer);
  }
}

/** The prompt is ready for input: `╰─❯ ` painted by shell.mjs `renderPrompt`. */
export const PROMPT = /╰─❯/;

/* ------------------------------------------------------------------ *
 * Cutting the stream into frames
 *
 * Snapshots need a slice of the session, not the whole of it. An earlier
 * version of this harness recorded byte offsets at the moment each `waitFor`
 * matched and sliced between them — which was wrong, and only wrong on a
 * loaded machine: the offset was `output.length`, so whatever else happened
 * to arrive in the same read landed inside the slice. Under CPU pressure the
 * terminal coalesces two writes into one read, and a snapshot taken "up to
 * the interrupt message" silently grew the next repaint.
 *
 * Everything below cuts on CONTENT instead. The line editor repaints by
 * walking the cursor back up over the frame it drew last, returning to
 * column 0 and erasing forward — `ESC[<n>A`? + CR + `ESC[0J` — and that
 * sequence is the only frame boundary in the stream. Where a slice begins
 * and ends is therefore decided by what the program printed, never by how
 * the bytes were delivered.
 * ------------------------------------------------------------------ */

const FRAME_START = /(?:\x1b\[\d*A)?\r\x1b\[0J/;

/**
 * Split raw pty output into repaint frames. Anything before the first
 * repaint (the banner) is its own leading entry.
 */
export function frames(raw) {
  const text = String(raw ?? "");
  const starts = [...text.matchAll(new RegExp(FRAME_START.source, "g"))].map((match) => match.index);
  if (starts.length === 0) return text === "" ? [] : [text];
  const out = starts[0] > 0 ? [text.slice(0, starts[0])] : [];
  for (let i = 0; i < starts.length; i += 1) out.push(text.slice(starts[i], starts[i + 1]));
  return out;
}

function frameIndex(all, needle, raw) {
  const index = all.findLastIndex((frame) => frame.includes(needle));
  if (index < 0) {
    throw new Error(`pty: no repaint frame contains ${JSON.stringify(needle)}\n--- output ---\n${normalizePty(raw)}`);
  }
  return index;
}

/**
 * The SETTLED render of `needle` — the last frame that contains it.
 *
 * The editor repaints once per batch of keystrokes it reads, and a busy
 * machine can split one `write()` from the test into two reads, producing an
 * extra half-drawn frame. Taking the last one means the snapshot pins the
 * finished picture either way.
 */
export function lastFrameWith(raw, needle) {
  const all = frames(raw);
  return all[frameIndex(all, needle, raw)];
}

/**
 * Every frame from the settled render of `startNeedle` through the settled
 * render of `endNeedle`, inclusive — for pinning a short sequence of
 * repaints (type, clear, warn) as one snapshot.
 */
export function framesBetween(raw, startNeedle, endNeedle) {
  const all = frames(raw);
  const from = frameIndex(all, startNeedle, raw);
  const to = frameIndex(all, endNeedle, raw);
  if (to < from) {
    throw new Error(`pty: ${JSON.stringify(endNeedle)} was rendered before ${JSON.stringify(startNeedle)}`);
  }
  return all.slice(from, to + 1).join("");
}

/**
 * A block the program printed straight to the terminal rather than into the
 * editor's frame: from the first match of `pattern` up to the repaint that
 * follows it. Slash-command panels are written by a single renderer call, so
 * this is the whole panel and nothing else.
 */
export function blockFrom(raw, pattern) {
  const text = String(raw ?? "");
  const start = text.search(pattern);
  if (start < 0) {
    throw new Error(`pty: nothing matched ${pattern}\n--- output ---\n${normalizePty(text)}`);
  }
  const rest = text.slice(start);
  const end = rest.search(FRAME_START);
  return end < 0 ? rest : rest.slice(0, end);
}

/** The panel heading every slash command draws: an accent bar, then a title. */
export const PANEL_START = /\x1b\[[0-9;]*m▌/;

/**
 * Everything a pty writes that is not the program's own content.
 *
 * `ansiToPlaceholders` only understands SGR and OSC (the sequences the
 * renderers emit); a live terminal session also carries cursor motion and
 * bracketed-paste toggles, which are exactly the bytes that decide whether a
 * redraw lands in the right place. They are kept, as readable tokens.
 */
const CSI_TOKENS = new Map([
  ["?2004h", "[paste-on]"],
  ["?2004l", "[paste-off]"],
  ["?25h", "[cursor-show]"],
  ["?25l", "[cursor-hide]"],
  ["0J", "[erase-below]"],
  ["2J", "[erase-screen]"],
  ["H", "[home]"]
]);

/**
 * Turn raw pty bytes into something a reviewer can read and a snapshot can
 * pin, with every value that changes between runs replaced by a token.
 */
export function normalizePty(raw, { home, workspace } = {}) {
  let text = ansiToPlaceholders(String(raw ?? ""));

  // Remaining CSI sequences: cursor motion, erase, bracketed paste.
  text = text.replace(/\x1b\[([0-9;?]*)([A-Za-z])/g, (_, params, final) => {
    const key = `${params}${final}`;
    if (CSI_TOKENS.has(key)) return CSI_TOKENS.get(key);
    return `[csi:${key}]`;
  });
  // Anything left is an escape the harness does not know about — surface it
  // rather than letting a raw ESC into the snapshot file.
  text = text.replace(/\x1b/g, "[ESC]");

  // Line endings: a pty writes CRLF, and the line editor writes bare CRs to
  // return the cursor. Both are load-bearing, neither should be invisible.
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "[CR]");

  // Run-specific values.
  if (workspace) text = text.split(workspace).join("<workspace>");
  if (home) text = text.split(home).join("<home>");
  // The shutdown hint echoes the absolute path the CLI was started from.
  text = text.split(CLI_PATH).join("<cli>");
  text = text.replace(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z/g, "<session-id>");
  // The welcome card pads the workspace row to the box width, so its trailing
  // spaces depend on how long the temp path happened to be. The row's
  // alignment is asserted directly (visibleWidth) instead of by snapshot.
  text = text.replace(/^(.*\bworkspace {2}.*?)<workspace>.*$/gm, "$1<workspace-row>");
  // `/status` prints WHY each display tool is unavailable — which binaries
  // are missing on this machine. The reason also decides how many lines the
  // row wraps to, so the rows are collapsed to one token rather than patched
  // in place. Tests assert on the tool names separately.
  text = collapseToolOffRows(text);
  // …and the banner names them, which depends on the same thing. The note
  // steps down to shorter forms when the window is narrow (P4b-1), and how
  // long the names are decides WHICH form a given machine gets — so every
  // form collapses to the same token.
  // Longest form first: the alternatives are tried in order, so the names are
  // swallowed by the full form rather than left behind by a shorter match.
  text = text.replace(/\d+ tools? unavailable(?: here: [^\n]*? — \/status for why| — \/status for why| — \/status)?/g,
    "<n> tools unavailable here: <names> — /status for why");

  return text;
}

/**
 * Replace the `Tool off  <name> — <reason>` rows of `/status`, including the
 * continuation lines the reason wraps onto, with a single token.
 */
function collapseToolOffRows(text) {
  const lines = text.split("\n");
  const out = [];
  let collapsing = false;
  for (const line of lines) {
    if (/Tool off/.test(line)) {
      if (!collapsing) out.push("  <tool-off-rows>");
      collapsing = true;
      continue;
    }
    // A wrapped reason continues on a deeply indented, fully muted line.
    if (collapsing && /^\s{6,}\[muted\]/.test(line)) continue;
    collapsing = false;
    out.push(line);
  }
  return out.join("\n");
}

/** Strip the placeholder tokens too, for plain-text assertions. */
export function plainPty(raw, options) {
  return normalizePty(raw, options)
    .replace(/\[(?:\/)?[a-z0-9:;?=][^\]]*\]/gi, "")
    .replace(/\[CR\]/g, "");
}
