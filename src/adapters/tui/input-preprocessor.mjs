import { readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { evaluatePermissions } from "../../safety/permissions.mjs";

const FILE_REF_PATTERN = /(^|\s)@([A-Za-z0-9_\-./\\:]+)/g;
const MAX_FILE_BYTES = 200_000;

/**
 * Inspect a REPL line for `@<path>` and `!<command>` directives. Returns the
 * directives that were found *without* expanding them — the caller decides
 * whether to confirm with the user before replacing the line. Pure: no I/O.
 *
 * Supported forms:
 *   - `@<path>`         — one file reference
 *   - `` !`command` ``  — backtick-delimited multi-word command
 *   - `!"command"`      — double-quote delimited multi-word command
 *   - `!command`        — single-token command (no spaces; ends at next whitespace)
 *   - `!command ...`    — when `!` is the first non-whitespace character of the
 *                         line, the rest of the line is taken as the command
 */
export function detectDirectives(line) {
  if (typeof line !== "string" || line.length === 0) return { files: [], commands: [] };
  const files = [];
  const commands = [];
  let match;
  FILE_REF_PATTERN.lastIndex = 0;
  while ((match = FILE_REF_PATTERN.exec(line)) != null) {
    files.push({ raw: `@${match[2]}`, filePath: match[2] });
  }
  collectShellDirectives(line, commands);
  return { files, commands };
}

function collectShellDirectives(line, commands) {
  let i = 0;
  while (i < line.length) {
    const at = line.indexOf("!", i);
    if (at === -1) return;
    if (at > 0) {
      const prev = line[at - 1];
      if (prev !== " " && prev !== "\t" && prev !== "\n") {
        i = at + 1;
        continue;
      }
    }
    const next = line[at + 1];
    if (next === undefined) return;
    if (next === "`") {
      const close = line.indexOf("`", at + 2);
      if (close === -1) return;
      const command = line.slice(at + 2, close).trim();
      const raw = line.slice(at, close + 1);
      if (command) commands.push({ raw, command });
      i = close + 1;
      continue;
    }
    if (next === "\"") {
      const close = line.indexOf("\"", at + 2);
      if (close === -1) return;
      const command = line.slice(at + 2, close).trim();
      const raw = line.slice(at, close + 1);
      if (command) commands.push({ raw, command });
      i = close + 1;
      continue;
    }
    if (next === " " || next === "\t" || next === "\n") {
      i = at + 1;
      continue;
    }
    // Bare `!` directive: gobble until the next whitespace OR, when at the
    // start of the line, the rest of the line.
    const tail = line.slice(at + 1);
    let command;
    let raw;
    const isLeading = at === 0;
    if (isLeading) {
      command = tail.trim();
      raw = line.slice(at);
    } else {
      const space = tail.search(/\s/);
      const wordEnd = space === -1 ? line.length : at + 1 + space;
      command = line.slice(at + 1, wordEnd).trim();
      raw = line.slice(at, wordEnd);
    }
    if (command) commands.push({ raw, command });
    i = at + raw.length;
  }
}

/**
 * Expand `@<path>` and `!<command>` references in `line` into a richer prompt
 * by reading files and (optionally) running shell commands. The result is the
 * string that should be sent to the LLM as the user prompt.
 *
 * @param {{
 *   line: string,
 *   cwd: string,
 *   readFileImpl?: typeof readFile,
 *   runShellImpl?: ({ command, cwd }: { command: string, cwd: string }) => Promise<{ exitCode: number, stdout: string, stderr: string }>,
 *   maxFileBytes?: number
 * }} input
 */
export async function expandInput({
  line,
  cwd = process.cwd(),
  readFileImpl = readFile,
  runShellImpl = defaultRunShell,
  maxFileBytes = MAX_FILE_BYTES,
  permissions = null,
  approvalRequester = null
} = {}) {
  if (typeof line !== "string") return { expanded: "", attached: [] };
  const { files, commands } = detectDirectives(line);
  const attached = [];
  let working = line;

  for (const ref of files) {
    const resolved = path.isAbsolute(ref.filePath) ? ref.filePath : path.resolve(cwd, ref.filePath);
    let content = "";
    let bytes = 0;
    let truncated = false;
    let error = null;
    try {
      const info = await stat(resolved);
      if (info.isFile()) {
        bytes = info.size;
        const raw = await readFileImpl(resolved, "utf8");
        if (raw.length > maxFileBytes) {
          content = `${raw.slice(0, maxFileBytes)}\n...[truncated to ${maxFileBytes} bytes]`;
          truncated = true;
        } else {
          content = raw;
        }
      } else {
        error = "not-a-file";
      }
    } catch (cause) {
      error = cause?.code ?? cause?.message ?? "read-error";
    }
    const fence = "```";
    const block = error
      ? `\n[Attached: ${ref.filePath} — error: ${error}]\n`
      : `\n[Attached: ${ref.filePath} (${bytes} bytes${truncated ? ", truncated" : ""})]\n${fence}\n${content}\n${fence}\n`;
    working = working.split(ref.raw).join(block);
    attached.push({ kind: "file", ref: ref.filePath, bytes, truncated, error });
  }

  for (const ref of commands) {
    const gate = await gateShell({ command: ref.command, permissions, approvalRequester });
    let result;
    if (gate.blocked) {
      result = { exitCode: 126, stdout: "", stderr: gate.reason };
    } else {
      try {
        result = await runShellImpl({ command: ref.command, cwd });
      } catch (cause) {
        result = { exitCode: 127, stdout: "", stderr: cause?.message ?? String(cause) };
      }
    }
    const fence = "```";
    const block = `\n[Shell: ${ref.command} (exit ${result.exitCode})]\n${fence}\n${(result.stdout || "")}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}\n${fence}\n`;
    working = working.split(ref.raw).join(block);
    attached.push({
      kind: "shell",
      command: ref.command,
      exitCode: result.exitCode,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      blocked: gate.blocked === true
    });
  }

  return { expanded: working, attached };
}

async function gateShell({ command, permissions, approvalRequester }) {
  if (!permissions) return { blocked: false };
  const decision = evaluatePermissions({
    rules: permissions,
    kind: "run_shell",
    summary: command,
    mutation: true
  });
  if (decision === "deny") {
    return { blocked: true, reason: `permissions denied: run_shell:${command}` };
  }
  if (decision === "ask") {
    if (typeof approvalRequester !== "function") {
      return { blocked: true, reason: `permissions ask (no approver attached): run_shell:${command}` };
    }
    const allowed = await approvalRequester({ kind: "run_shell", summary: command });
    if (!allowed) return { blocked: true, reason: `permissions denied by user: run_shell:${command}` };
  }
  return { blocked: false };
}

/**
 * Decode shell stdout/stderr bytes. Try UTF-8 first; on Windows, when the
 * UTF-8 result contains replacement characters (U+FFFD), fall back to
 * Shift-JIS (CP932) — cmd.exe built-ins like `dir` write OEM-codepage bytes
 * to a redirected stdout regardless of the active console codepage, so a
 * `chcp 65001` prefix does not help them.
 *
 * Pure — exported for direct unit-testing.
 */
export function decodeShellBytes(buffer, platform = process.platform) {
  if (!buffer || buffer.length === 0) return "";
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  if (platform !== "win32" || !utf8.includes("�")) return utf8;
  try {
    return new TextDecoder("shift_jis", { fatal: false }).decode(buffer);
  } catch {
    return utf8;
  }
}

function defaultRunShell({ command, cwd }) {
  return new Promise((resolve) => {
    const child = spawn(command, [], { shell: true, cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on("data", (chunk) => { stdoutChunks.push(chunk); });
    child.stderr.on("data", (chunk) => { stderrChunks.push(chunk); });
    child.on("error", (error) => resolve({
      exitCode: 127,
      stdout: decodeShellBytes(Buffer.concat(stdoutChunks)),
      stderr: decodeShellBytes(Buffer.concat(stderrChunks)) + (error?.message ?? "")
    }));
    child.on("exit", (code) => resolve({
      exitCode: code ?? 0,
      stdout: decodeShellBytes(Buffer.concat(stdoutChunks)),
      stderr: decodeShellBytes(Buffer.concat(stderrChunks))
    }));
  });
}
