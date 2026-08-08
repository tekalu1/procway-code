import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { buildMcpInjection } from "../mcp/host/inject-config.mjs";

const ZERO_USAGE = Object.freeze({ inputTokens: 0, outputTokens: 0 });

// The MCP host CLI is resolved from THIS module's URL, not from a guessed repo
// root. `${repoRoot}/ai-agent/src/mcp/host/cli.mjs` only exists inside the
// monorepo checkout; when procway-code is installed from npm the package root
// is `node_modules/procway-code`, and that path resolves to a file that is not
// there — the sub-CLI would then start with an MCP server that never launches.
const HOST_CLI_PATH = fileURLToPath(new URL("../mcp/host/cli.mjs", import.meta.url));

/**
 * Detect sub-CLI flavor from `provider.command` so MCP injection can pick the
 * right config shape. Defaults to "codex" if unrecognized — that matches
 * the most common case and keeps PoC scope tight.
 */
function detectProviderFlavor(command) {
  const base = String(command).toLowerCase().replace(/\.(cmd|bat|exe)$/, "");
  if (base.includes("claude")) return "claude";
  return "codex";
}

/**
 * `child.kill()` on Windows only signals the immediate child. When we route
 * through cmd.exe (the only way to invoke .cmd / .bat shims) the actual
 * agent (node, codex, …) lives one process deeper and survives. taskkill /T
 * walks the tree and /F forces termination so a runaway turn really stops.
 */
function killTree(child, platform) {
  if (!child || child.killed || child.exitCode !== null) return;
  if (platform === "win32" && typeof child.pid === "number") {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    } catch { /* fallthrough to the basic kill */ }
  }
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
}

export async function runCliAgentProvider({
  provider,
  prompt,
  cwd = process.cwd(),
  timeoutMs = 300000,
  // 5 MB. codex with --json can balloon when it runs large directory listings
  // (node_modules etc.) — 200KB rolled the head off and ate the
  // thread.started marker, defeating the parser. 5 MB swallows realistic
  // agent turns; if a single reply is genuinely larger than that, we have
  // other problems and a streaming parser is needed.
  maxOutputBytes = 5_000_000,
  spawnImpl = spawn,
  platform = process.platform,
  signal
}) {
  if (!provider.command) throw new Error("cli-agent provider requires command");
  let args = (provider.args ?? []).map((arg) => arg === "{prompt}" ? prompt : arg);

  // mcpHost mode: PoC (TK-135). Inject MCP server config + flags so the
  // sub-CLI calls procway tools through MCP instead of its own built-ins.
  // When `mcpHost` is unset/false the code path below is identical to the
  // pre-PoC behavior — easy to revert by deleting this block.
  let spawnEnv = undefined;
  let mcpTempFiles = [];
  if (provider.mcpHost === true) {
    const flavor = detectProviderFlavor(provider.command);
    const injection = buildMcpInjection({
      provider: flavor,
      hostCli: HOST_CLI_PATH,
      cwd,
      disallowBuiltinMutations: provider.mcpHostKeepBuiltins !== true
    });
    args = [...args, ...injection.extraArgs];
    if (injection.env) spawnEnv = { ...process.env, ...injection.env };
    mcpTempFiles = injection.tempFiles;
  }

  // On Windows, Node's child_process.spawn cannot directly invoke .cmd / .bat
  // shims (e.g. npm-installed CLIs like `codex.cmd`) without going through
  // cmd.exe — it throws EINVAL synchronously since the CVE-2024-27980 fix.
  // We route through cmd.exe ourselves with manual MS CRT-compatible quoting
  // so paths with spaces and args containing quotes survive intact.
  let child;
  if (platform === "win32") {
    // cmd.exe `/c` strips the outermost two quotes when more than one quote is
    // present in the command line. Wrap the already-quoted inner command line
    // in another pair of quotes so cmd reveals our intended quoting verbatim.
    const inner = [provider.command, ...args].map(escapeWinArg).join(" ");
    child = spawnImpl("cmd.exe", ["/d", "/s", "/c", `"${inner}"`], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: true,
      ...(spawnEnv ? { env: spawnEnv } : {})
    });
  } else {
    child = spawnImpl(provider.command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      ...(spawnEnv ? { env: spawnEnv } : {})
    });
  }

  let outBuf = "";
  let errBuf = "";
  let timedOut = false;
  let aborted = false;
  let spawnError = null;
  child.on("error", (err) => { spawnError = err; });

  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child, platform);
  }, timeoutMs);

  // External cancellation (UI Stop button → conversation.abort()).
  // Aborting walks the spawn tree so a long-running codex / claude-code
  // turn cannot continue ignoring the user.
  let abortHandler = null;
  if (signal) {
    if (signal.aborted) {
      aborted = true;
      killTree(child, platform);
    } else {
      abortHandler = () => {
        aborted = true;
        killTree(child, platform);
      };
      signal.addEventListener("abort", abortHandler, { once: true });
    }
  }

  child.stdout?.on("data", (chunk) => {
    outBuf = appendLimited(outBuf, chunk.toString(), maxOutputBytes);
  });
  child.stderr?.on("data", (chunk) => {
    errBuf = appendLimited(errBuf, chunk.toString(), maxOutputBytes);
  });

  try {
    if (provider.stdinMode === "none") {
      child.stdin?.end();
    } else if (provider.stdinMode === "json") {
      child.stdin?.write(JSON.stringify({ prompt }));
      child.stdin?.end();
    } else {
      child.stdin?.write(prompt);
      child.stdin?.end();
    }
  } catch (err) {
    if (!spawnError) spawnError = err;
  }

  const code = await new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.on("close", settle);
    child.on("error", () => settle(-1));
  });
  clearTimeout(timer);
  if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);

  // mcpHost mode (PoC): clean up generated temp config files. Always best-effort.
  for (const f of mcpTempFiles) {
    try {
      const stat = fs.statSync(f);
      if (stat.isDirectory()) fs.rmSync(f, { recursive: true, force: true });
      else fs.unlinkSync(f);
    } catch { /* ignore */ }
  }

  if (aborted) {
    const err = new Error("cli-agent provider aborted by user");
    err.code = "aborted";
    throw err;
  }
  if (spawnError) {
    throw new Error(`cli-agent provider failed to start (${provider.command}): ${spawnError.message}`);
  }
  if (code !== 0 || timedOut) {
    const reason = timedOut ? `timed out after ${timeoutMs}ms` : `exit ${code}`;
    throw new Error(`cli-agent provider failed (${reason}): ${errBuf || outBuf}`.trim());
  }

  const content = parseCodexJsonStream(outBuf) ?? outBuf;
  return {
    message: { role: "assistant", content },
    toolCalls: [],
    usage: { ...ZERO_USAGE }
  };
}

/**
 * Codex emits a JSON-Lines event stream when invoked with `--json`. A turn
 * typically contains an intermediate `agent_message` (codex narrating its
 * intent — e.g. "I'll check the rules first."), one or more
 * `command_execution` items, and a final `agent_message` with the actual
 * reply. We surface only the LAST agent_message so the chat panel shows the
 * conclusion, not the thinking-out-loud preamble.
 *
 * Detection is by ANY recognised codex event line — not just the leading
 * `thread.started`. When a turn produces enough output to roll the head off
 * the bounded buffer, the first line we see may be an arbitrary
 * `item.completed` or be partial JSON; as long as we encounter a clearly
 * codex-shaped event somewhere in the stream we treat the whole thing as
 * codex output.
 *
 * Returns:
 *   - the final agent_message text when stdout is recognisably codex JSON
 *     (empty string if there were no agent_messages but we still detected
 *     codex shape — better than dumping raw JSON to the chat panel)
 *   - null when the output is not codex JSON (caller falls back to raw stdout)
 */
const CODEX_EVENT_TYPES = new Set([
  "thread.started",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "item.started",
  "item.completed",
  "item.updated"
]);

function parseCodexJsonStream(text) {
  const lines = text.split(/\r?\n/);
  let detected = false;
  let lastMessage = "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (typeof event?.type === "string" && CODEX_EVENT_TYPES.has(event.type)) {
      detected = true;
    }
    if (
      event?.type === "item.completed"
      && event.item?.type === "agent_message"
      && typeof event.item.text === "string"
    ) {
      lastMessage = event.item.text;
    }
  }
  return detected ? lastMessage : null;
}

/**
 * Quote a single argument for the Microsoft C runtime / CommandLineToArgvW
 * parser used by most Windows console apps. Implements the algorithm from
 * https://docs.microsoft.com/en-us/archive/blogs/twistylittlepassagesallalike/everyone-quotes-command-line-arguments-the-wrong-way
 */
function escapeWinArg(s) {
  if (s === "") return '""';
  // Empty trigger characters set: spaces, tabs, newlines, double quotes.
  if (!/[\s"]/.test(s)) return s;
  let result = '"';
  let backslashes = 0;
  for (const ch of s) {
    if (ch === "\\") {
      backslashes += 1;
      continue;
    }
    if (ch === '"') {
      // Each preceding backslash needs to be doubled, and the quote itself
      // gets escaped with one extra backslash.
      result += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    result += "\\".repeat(backslashes) + ch;
    backslashes = 0;
  }
  // Any trailing backslashes get doubled because we're closing with a quote.
  result += "\\".repeat(backslashes * 2) + '"';
  return result;
}

function appendLimited(current, next, maxBytes) {
  const combined = current + next;
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) return combined;
  return combined.slice(-maxBytes);
}
