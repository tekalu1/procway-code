const WRITE_INTENT_PATTERNS = [
  /作成/,
  /保存/,
  /書い/,
  /生成/,
  /改修/,
  /更新/,
  /編集/,
  /create/i,
  /write/i,
  /save/i,
  /generate/i,
  /update/i,
  /edit/i
];

const FILE_HINT_PATTERNS = [
  /\.md\b/i,
  /\.html\b/i,
  /\.json\b/i,
  /\.mjs\b/i,
  /\.js\b/i,
  /\.ts\b/i,
  /ファイル/,
  /temporary/,
  /plan/i
];

export function requiresFileMutation(prompt) {
  return WRITE_INTENT_PATTERNS.some((pattern) => pattern.test(prompt))
    && FILE_HINT_PATTERNS.some((pattern) => pattern.test(prompt));
}

/**
 * Detect whether the message stream from `startIndex` onward contains a
 * successful mutation tool result. Accepts both the Phase 2 internal
 * Message[] (with `content: ContentBlock[]`) and the legacy raw shape
 * (string content) so that persisted state.json files written before the
 * Phase 2 migration still report intent correctly.
 */
export function hasMutationToolResult(messages, startIndex = 0) {
  return messages.slice(startIndex).some((message) => {
    if (message.role !== "tool") return false;
    if (typeof message.content === "string") {
      return /"path"\s*:|"bytes"\s*:|"hunks"\s*:/.test(message.content)
        && !/"skipped"\s*:\s*true/.test(message.content);
    }
    if (!Array.isArray(message.content)) return false;
    return message.content.some(isSuccessfulMutationBlock);
  });
}

function isSuccessfulMutationBlock(block) {
  if (!block || block.kind !== "tool_result") return false;
  if (block.ok === false) return false;
  const data = block.result?.data;
  if (data == null) return false;
  if (Array.isArray(data)) {
    return data.some((entry) => entry && (entry.path != null || entry.bytes != null || entry.hunks != null) && entry.skipped !== true);
  }
  if (data.skipped === true) return false;
  return data.path != null || data.bytes != null || data.hunks != null;
}

// --- Procway runner task-completion enforcement ---------------------------
//
// The procway runner spawns procway-code with a prompt that ends with a
// `## Meta` JSON block listing role / ticket / task / project. A worker
// run is expected to finalize by invoking
//   `node "$PROCWAY_CLI" task complete <project> <ticket> <task> --memo "…"`
// via the `run_shell` tool. Without that call, run-spawn keeps awaiting the
// runner child while the agent has nothing more to do — the task stays in
// `status: running` indefinitely. The retry loop below mirrors the
// FILE_MUTATION_RETRY pattern: if the model wants to end the turn (no tool
// calls returned) but the task-complete tool call hasn't happened yet, we
// inject a synthetic user message that demands it.

const META_HEADING_REGEX = /^##\s*Meta\b/m;
const TASK_COMPLETE_CMD_REGEX = /task\s+complete\b/;

/**
 * True iff the prompt is a procway-runner worker prompt (Meta block present
 * with role: "worker"). Reviewer prompts and ordinary REPL prompts return
 * false so they're not subjected to the retry loop.
 */
export function requiresTaskCompletion(prompt) {
  if (typeof prompt !== "string" || prompt.length === 0) return false;
  if (!META_HEADING_REGEX.test(prompt)) return false;
  return /"role"\s*:\s*"worker"/.test(prompt);
}

/**
 * Parse the trailing Meta JSON block to recover { project, ticket, task,
 * interactive }. Returns null when the block is missing or unparseable so
 * callers can skip the retry gracefully instead of crashing the turn.
 */
export function extractProcwayMeta(prompt) {
  if (typeof prompt !== "string") return null;
  const headingIdx = prompt.search(META_HEADING_REGEX);
  if (headingIdx < 0) return null;
  const sub = prompt.slice(headingIdx);
  const jsonStart = sub.indexOf("{");
  const jsonEnd = sub.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd <= jsonStart) return null;
  try {
    const meta = JSON.parse(sub.slice(jsonStart, jsonEnd + 1));
    if (typeof meta.ticket !== "string" || typeof meta.task !== "string") return null;
    return {
      project: typeof meta.project === "string" ? meta.project : null,
      ticket: meta.ticket,
      task: meta.task,
      // Phase 4c hearing tasks: a turn ending WITHOUT `task complete` is the
      // designed ChatPanel hand-off, so the completion-retry loop must stand
      // down (see shouldRemindTaskCompletion / turn-orchestrator).
      interactive: meta.interactive === true,
    };
  } catch {
    return null;
  }
}

/**
 * True iff `messages` from `startIndex` onward contains evidence that the
 * specified ticket+task is completed:
 *   - a successful `run_shell` tool result whose foreground command invoked
 *     `procway task complete` and returned exitCode 0;
 *   - a background run confirmed via a `shell_status`/`shell_wait` poll showing
 *     the shell exited with code 0 (see matchesBackgroundTaskCompleteStatus) —
 *     the bare background *start* result (runInBackground:true, status
 *     "running") never counts because the exit is still unknown when it is
 *     recorded;
 *   - a FAILED `task complete` whose output carries the server's
 *     ALREADY_COMPLETED rejection (see matchesAlreadyCompletedBlock) — the
 *     server checked the ticket row and said the task IS completed, which is
 *     more authoritative than anything in the session history.
 */
export function hasTaskCompletionToolResult(messages, { ticket, task } = {}, startIndex = 0) {
  if (!ticket || !task) return false;
  return messages.slice(startIndex).some((message) => {
    if (message.role !== "tool") return false;
    if (typeof message.content === "string") {
      return matchesLegacyTaskComplete(message.content, ticket, task);
    }
    if (!Array.isArray(message.content)) return false;
    return message.content.some((block) =>
      matchesTaskCompleteBlock(block, ticket, task)
      || matchesBackgroundTaskCompleteStatus(block, ticket, task)
      || matchesAlreadyCompletedBlock(block, ticket, task));
  });
}

function matchesTaskCompleteBlock(block, ticket, task) {
  if (!block || block.kind !== "tool_result") return false;
  if (block.ok === false) return false;
  const data = block.result?.data;
  if (!data || typeof data.command !== "string") return false;
  if (data.runInBackground === true) return false;
  if (!TASK_COMPLETE_CMD_REGEX.test(data.command)) return false;
  if (!data.command.includes(ticket) || !data.command.includes(task)) return false;
  if (data.exitCode !== 0) return false;
  // Defensive: a real `task complete` either prints JSON to stdout (success)
  // or an error message to stderr (blocked / network). Exit 0 with both
  // streams empty means the CLI never ran at all — historically caused by
  // an unset `$PROCWAY_CLI` expanding to "" so `node ""` silently exits 0.
  // Treat that as "not completed" so the worker retries instead of stalling.
  const stdoutHasContent = typeof data.stdout === "string" && data.stdout.length > 0;
  const stderrHasContent = typeof data.stderr === "string" && data.stderr.length > 0;
  return stdoutHasContent || stderrHasContent;
}

/**
 * Background counterpart to matchesTaskCompleteBlock. `task complete` runs the
 * checkAgent review, which routinely takes several minutes — longer than the
 * per-tool timeout — so the worker may run it in the background and
 * confirm completion via a `shell_job` status/wait result. This
 * matches that result: a successful `shell_status`/`shell_wait` whose tracked command
 * is `task complete <ticket> <task>`, status "exited", exitCode 0. shell_status
 * reports byte counts rather than stream content, so the "CLI never ran" guard
 * checks stdoutBytes/stderrBytes (mirrors the foreground stdout/stderr guard).
 */
function matchesBackgroundTaskCompleteStatus(block, ticket, task) {
  if (!block || block.kind !== "tool_result") return false;
  if (block.ok === false) return false;
  const data = block.result?.data;
  if (!data || (data.tool !== "shell_status" && data.tool !== "shell_wait")) return false;
  if (typeof data.command !== "string") return false;
  if (!TASK_COMPLETE_CMD_REGEX.test(data.command)) return false;
  if (!data.command.includes(ticket) || !data.command.includes(task)) return false;
  if (data.status !== "exited") return false;
  if (data.exitCode !== 0) return false;
  const stdoutBytes = typeof data.stdoutBytes === "number" ? data.stdoutBytes : 0;
  const stderrBytes = typeof data.stderrBytes === "number" ? data.stderrBytes : 0;
  return stdoutBytes > 0 || stderrBytes > 0;
}

// The server rejects `task complete` on an already-completed task with a 400
// whose code is ALREADY_COMPLETED; the CLI prints `Error (400 ALREADY_COMPLETED):
// Task "<task>" is already completed` to stderr and exits 1. The message-text
// fallback covers CLI builds that predate the code-in-stderr format.
const ALREADY_COMPLETED_OUTPUT_REGEX = /ALREADY_COMPLETED|is already completed/;

/**
 * Escape hatch for the case where the task IS completed but the session
 * history holds no successful `task complete` record — the task was completed
 * outside this session (dashboard UI, human CLI), or the record was lost to
 * compaction / a partial resume. Without this, the completion-retry loop
 * demands `task complete` → the server answers 400 ALREADY_COMPLETED → exit 1
 * can never become 0 → the turn spins until maxToolRounds. A failed run whose
 * output carries the server's ALREADY_COMPLETED verdict is authoritative
 * proof of completion, so treat it as satisfying the check. exitCode is NOT
 * required to be non-zero (a future idempotent server could exit 0); the
 * matcher keys solely on the verdict in the output.
 */
function matchesAlreadyCompletedBlock(block, ticket, task) {
  if (!block || block.kind !== "tool_result") return false;
  if (block.ok === false) return false;
  const data = block.result?.data;
  if (!data || typeof data.command !== "string") return false;
  if (!TASK_COMPLETE_CMD_REGEX.test(data.command)) return false;
  if (!data.command.includes(ticket) || !data.command.includes(task)) return false;
  const stdout = typeof data.stdout === "string" ? data.stdout : "";
  const stderr = typeof data.stderr === "string" ? data.stderr : "";
  return ALREADY_COMPLETED_OUTPUT_REGEX.test(stdout) || ALREADY_COMPLETED_OUTPUT_REGEX.test(stderr);
}

function matchesLegacyTaskComplete(raw, ticket, task) {
  return TASK_COMPLETE_CMD_REGEX.test(raw)
    && raw.includes(ticket)
    && raw.includes(task)
    && /"exitCode"\s*:\s*0/.test(raw)
    // Same defensive guard as the structured path above.
    && /"stdout"\s*:\s*"[^"]/.test(raw);
}

/**
 * Synthetic user-message text injected when the worker turn ends without a
 * successful `task complete` CLI call. Shared between the per-round retry in
 * turn-orchestrator and the session-level pending reminder injected on the
 * next runTurn (after an abort / failure / interrupt / tool-loop-exceeded).
 */
export function buildTaskCompletionRetryPrompt({ project, ticket, task } = {}) {
  const proj = project ?? "<project>";
  const t = ticket ?? "<ticket>";
  const tk = task ?? "<task>";
  return `You declared the task is finished in your text, but you did not run the procway CLI to actually finalize it. The runner sees \`status: running\` and the task will never close until you do.

\`task complete\` runs the checkAgent review, which uses AI tool-calls and routinely takes several minutes. Run it in the FOREGROUND with a generous timeout — output streams as progress, so the long wait is safe:

  run_shell:
    command: node "$PROCWAY_CLI" task complete ${proj} ${t} ${tk} --memo "<one-line summary of what you accomplished>"
    timeoutMs: 900000

  Confirm exitCode is 0. Only then is the task actually complete.
  (If you already started it with runInBackground:true, join it with shell_job action:"wait" instead of polling status in a loop.)

If exitCode is non-zero the completion was blocked — read the stdout/stderr in the result (or shell_job action:"logs" for a background run) for the reason (checklist gate failed, blocking review thread, unresolved error). For a blocking review thread the default path is: FIX the flagged issue, then rerun \`task complete\`. Only if you are confident the finding is a false positive, rebut it on the thread and ask the AI to re-evaluate:
  \`node "$PROCWAY_CLI" task reviews ${proj} ${t} ${tk}\` — list threads
  \`node "$PROCWAY_CLI" task review-comment ${proj} ${t} ${tk} {threadId} --body "..."\` — post your rebuttal
  \`node "$PROCWAY_CLI" task re-review ${proj} ${t} ${tk} {threadId}\` — AI re-evaluation (auto-resolves on pass)
Do NOT use \`task review-resolve\` — manual resolve is human-only and the server rejects it from a worker session. \`task review-wontfix --reason "..."\` is a last resort for findings that genuinely need no action. Then retry \`task complete\`. Do NOT respond with another final answer until it has exited with code 0.`;
}

/**
 * Session-level check used at turn-end paths. Returns true when the session
 * is a procway worker (has procwayMeta) and the messages so far do NOT
 * contain a successful `task complete` invocation for that ticket/task.
 *
 * Callers should set `session.pendingTaskCompletionReminder = true` so the
 * next `runTurn` injects the reminder text — see conversation.mjs.
 */
export function shouldRemindTaskCompletion(session) {
  if (!session || !session.procwayMeta) return false;
  // Interactive (hearing) tasks legitimately end turns without `task
  // complete` — that is the awaiting-user-input hand-off to ChatPanel, not a
  // stall. Reminding here bullied the worker into self-answering the hearing
  // and completing the task without ever asking the user (observed under
  // auto-approve on 2026-06-05, but the bug was mode-independent).
  if (session.procwayMeta.interactive === true) return false;
  const { ticket, task } = session.procwayMeta;
  if (typeof ticket !== "string" || typeof task !== "string") return false;
  const messages = Array.isArray(session.messages) ? session.messages : [];
  return !hasTaskCompletionToolResult(messages, { ticket, task }, 0);
}
