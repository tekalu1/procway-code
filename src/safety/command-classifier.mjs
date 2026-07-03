const DESTRUCTIVE_PATTERNS = [
  /\bsudo\b/i,
  /\brm\s+-/i,
  /\brmdir\b/i,
  /\bdel\s+(?:\/[a-z]*[fq][a-z]*\s*)+/i,
  /\bRemove-Item\b/i,
  /\bformat\b/i,
  /\bdiskpart\b/i,
  /\bdd\s+.*\bof=/i,
  /\bmkfs(?:\.[a-z0-9]+)?\b/i,
  /\bgit\s+reset\b/i,
  /\bgit\s+clean\b/i,
  /\bgit\s+checkout\s+--\b/i,
  /\bgit\s+push\b.*\s-(?:-[^\s]*force|[a-z]*f[a-z]*)\b/i
];

const NETWORK_PATTERNS = [
  /\bcurl\b/i,
  /\bwget\b/i,
  /\bInvoke-WebRequest\b/i,
  /\bInvoke-RestMethod\b/i,
  /\bgit\s+push\b/i,
  /\bnc\b/i,
  /\bncat\b/i,
  /\bssh\b/i
];

const INSTALL_PATTERNS = [
  /\bnpm\s+(i|install)\b/i,
  /\bpnpm\s+(i|install)\b/i,
  /\byarn\s+(add|install)\b/i,
  /\bpip\s+install\b/i,
  /\bcargo\s+install\b/i,
  /\bchoco\s+install\b/i,
  /\bwinget\s+install\b/i,
  /\bbrew\s+install\b/i,
  /\bgo\s+install\b/i
];

// Matches the canonical task-artifact path used by the dashboard:
//   .../backlogs/<ticket>/tasks/<task>/(memo.md | evidence/... | report/...)
// Accepts both forward and back slashes so Windows-style paths in PowerShell
// fallback commands are detected too.
const TASK_ARTIFACT_PATH = /backlogs[\\/][^\\/'"\s]+[\\/]tasks[\\/][^\\/'"\s]+[\\/](memo\.md|evidence(?:[\\/][^\s'"<>|;`]+)?|report(?:[\\/][^\s'"<>|;`]+)?)/i;

// Verbs that indicate the artifact path is the *write target*, not just a
// mention. Each entry is paired with a label for diagnostics.
const ARTIFACT_WRITE_VERBS = [
  { rx: />>?\s*['"]?[^\s'"|&;`]*backlogs/i, label: "redirect" },
  { rx: /\btee\b(?:\s+-[a-z]+)?\s+['"]?[^\s'"|&;`]*backlogs/i, label: "tee" },
  { rx: /\b(?:Set-Content|Out-File|Add-Content)\b[^|]*backlogs/i, label: "powershell-write" }
];

/**
 * Detect a shell command that writes directly to a task artifact path.
 * Returns `{ kind, path, verb }` when matched, or `null` otherwise.
 *
 * The agent must use the `task put` API for these paths; shell-level writes
 * skip the dashboard's encoding-safe writer and corrupt non-ASCII content
 * on Windows PowerShell 5.1.
 */
export function detectTaskArtifactWrite(command) {
  if (typeof command !== "string" || command.length === 0) return null;
  const pathMatch = command.match(TASK_ARTIFACT_PATH);
  if (!pathMatch) return null;
  const verb = ARTIFACT_WRITE_VERBS.find((entry) => entry.rx.test(command));
  if (!verb) return null;
  const tail = pathMatch[1].toLowerCase();
  const kind = tail.startsWith("memo")
    ? "memo"
    : tail.startsWith("evidence")
      ? "evidence"
      : "report";
  return { kind, path: pathMatch[0], verb: verb.label };
}

// Long-running orchestration commands. The run loop / single-task drives
// (`run loop` and the single-task `run task` / `run next`) each spin up a fresh
// worker pod + agent + checkAgent pass and can legitimately run for many minutes
// to hours — well past the short foreground shell wall-clock (shellTimeoutMs
// default 120s). They must NOT be bound by that outermost timer, which would
// SIGTERM the whole drive before any task finishes (see
// temporary/investigation-run-loop-timeouts.md). Liveness is instead governed by
// the turn-idle watchdog (kept fed by progress heartbeats while the child is
// alive) plus the CLI's own per-task timeouts; the value below is only a
// failsafe ceiling of last resort.
//
// `[^\n;&|]*` keeps the procway anchor and the run-subcommand token in the SAME
// command segment (the match can't span a `;` / `&&` / `|` separator). NB this
// is NOT a security boundary: detection is a whole-command boolean, so a trailing
// `&& rm ...` rider still executes under the relaxed ceiling — but classifyCommand
// independently flags such a command destructive→approval, and an `rm` completes
// instantly regardless of the ceiling.
const LONG_RUNNING_PATTERNS = [
  /(?:procway|PROCWAY_CLI)[^\n;&|]*\brun\s+(?:loop|task|next)\b/i
];

export const DEFAULT_LONG_RUNNING_SHELL_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/**
 * True when `command` invokes a procway orchestration drive (`run loop` /
 * `run task` / `run next`) that legitimately runs long. Callers raise the shell wall-clock
 * and scheduler budget to `tools.longRunningShellTimeoutMs` for these so the
 * outermost timer never kills a healthy loop.
 */
export function isLongRunningCommand(command) {
  if (typeof command !== "string" || command.length === 0) return false;
  return LONG_RUNNING_PATTERNS.some((pattern) => pattern.test(command));
}

export function classifyCommand(command) {
  const reasons = [];
  if (DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command))) reasons.push("destructive");
  if (NETWORK_PATTERNS.some((pattern) => pattern.test(command))) reasons.push("network");
  if (INSTALL_PATTERNS.some((pattern) => pattern.test(command))) reasons.push("dependency-install");
  if (detectTaskArtifactWrite(command)) reasons.push("task-artifact-write");
  if (/[<>|]/.test(command) || /\$\(/.test(command) || /\bcmd(?:\.exe)?\s+\/c\b/i.test(command)) reasons.push("redirection");
  return {
    approvalRequired: reasons.length > 0,
    reasons: [...new Set(reasons)]
  };
}
