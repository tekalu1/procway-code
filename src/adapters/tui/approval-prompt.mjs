import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { renderDiff } from "./diff.mjs";
import { createInputController } from "./input-controller.mjs";
import { renderPanel, paint } from "./panel.mjs";
import { supportsColor, terminalWidth } from "./ansi.mjs";

/**
 * Approval adapter — subscribes to `approval.requested` and prompts the user
 * for `y / n / a / e`. `e` (edit-then-approve) writes the proposed payload to a
 * temp file, launches `EDITOR`, and the edited contents replace the payload
 * before resolving "allow".
 *
 * P3b-6 rewrote the prompt itself. It used to be one uncoloured line —
 *
 *   Approve write_file: src/foo.mjs [y/n/a/e]?
 *
 * — with no explanation of what `a` or `e` did, and, worse, ANY answer that
 * was not `y`/`a`/`e` silently denied: a typo cost you the tool call. Now the
 * request is a titled panel with a key legend, the default is stated, and an
 * unrecognised answer RE-ASKS instead of denying. Enter (empty answer) is the
 * only silent path, and it takes the stated default (deny).
 *
 * Test hooks:
 * - `launchEditor({ initial, suffix })` lets tests substitute the spawn step.
 * - `prompt({ question })` lets tests intercept the question entirely.
 */

/** The maximum number of re-asks before we give up and deny. */
const MAX_ATTEMPTS = 5;

const CHOICES = Object.freeze([
  { keys: ["y", "yes"], decision: "allow", label: "y", help: "approve this call" },
  { keys: ["n", "no"], decision: "deny", label: "n", help: "deny (default)" },
  { keys: ["a", "always"], decision: "always-allow", label: "a", help: "always allow this tool for the session" },
  { keys: ["e", "edit"], decision: "edit", label: "e", help: "edit the payload, then approve" }
]);

/**
 * @param {string|null} answer
 * @returns {"allow"|"deny"|"always-allow"|"edit"|"invalid"}
 */
export function normalizeApprovalAnswer(answer) {
  const trimmed = String(answer ?? "").trim().toLowerCase();
  if (trimmed === "") return "deny";
  const match = CHOICES.find((choice) => choice.keys.includes(trimmed));
  return match ? match.decision : "invalid";
}

/**
 * The panel printed above the question: what is being approved, on what, and
 * what each key does. Pure so the layout is unit-testable.
 */
export function renderApprovalRequest({ kind, summary, payload = {}, width = 80, color = true } = {}) {
  const rows = [["tool", kind ?? "tool", "warning"]];
  const target = payload.filePath ?? payload.path ?? null;
  if (target) rows.push(["target", target]);
  if (payload.command) rows.push(["command", String(payload.command)]);
  if (summary && summary !== target && summary !== payload.command) rows.push(["summary", summary]);
  return renderPanel({
    title: "Approval required",
    rows,
    notes: CHOICES.map((choice) => `[${choice.label}] ${choice.help}`),
    width,
    color
  });
}

/**
 * The one-line question, with the default spelled out.
 *
 * `kind` is the tool name, i.e. model-controlled, and this string is written
 * while the cursor is parked on the row the user is about to type `y` into —
 * a `\r` or a cursor-up here would let the model rewrite the question it is
 * being asked. `paint()` sanitises (panel.mjs), including on the `color:false`
 * branch.
 */
export function approvalQuestion({ kind, color = true } = {}) {
  const keys = paint("[y/n/a/e]", "accentStrong", color);
  return `${paint(`Approve ${kind ?? "tool"}?`, "bold", color)} ${keys} ${paint("(default n)", "muted", color)} `;
}

export function attachApprovalPrompt({
  session,
  input = process.stdin,
  output = process.stdout,
  controller: sharedController = null,
  launchEditor = defaultLaunchEditor,
  prompt
} = {}) {
  if (!session?.events || typeof session.approve !== "function") {
    throw new TypeError("attachApprovalPrompt: session with events + approve() is required");
  }
  let disposed = false;
  // P2-1: the approval asks the SHARED input controller, at overlay level, so
  // it preempts the REPL's own prompt and both promises still settle. The old
  // code called `rl.question()` on the REPL's readline while that readline was
  // already inside a question — Node silently drops the second callback and
  // the approval never resolved (see input-controller.mjs's header comment).
  const askQuestion = prompt ?? (async ({ question }) => {
    if (sharedController) {
      return sharedController.question({ prompt: question, level: 1, history: false, multiline: false });
    }
    // No controller (embedders / one-shot use): own stdin only for the length
    // of this question, then hand it straight back.
    const local = createInputController({ input, output }).start();
    try {
      return await local.question({ prompt: question, history: false, multiline: false });
    } finally {
      local.dispose();
    }
  });

  const writeOut = (text) => {
    try {
      if (sharedController) sharedController.write(text);
      else output.write(text);
    } catch { /* ignore */ }
  };
  const color = supportsColor(output);

  const handler = async (event) => {
    if (event?.type !== "approval.requested" || disposed) return;
    // Read the geometry per request so a resized window is honoured (P3b-11).
    const width = terminalWidth(output);
    const payload = event.payload ?? {};
    writeOut(renderApprovalRequest({ kind: event.kind, summary: event.summary, payload, width, color }));
    if (payload.before != null || payload.after != null) {
      writeOut(renderDiff({
        filePath: payload.filePath ?? event.summary ?? "(unknown)",
        before: payload.before ?? "",
        after: payload.after ?? "",
        operation: payload.operation,
        colorize: color
      }));
    }
    let decision = "deny";
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      let answer;
      try {
        answer = await askQuestion({ question: approvalQuestion({ kind: event.kind, color }), kind: event.kind });
      } catch {
        session.approve(event.requestId, "deny");
        return;
      }
      if (answer == null) break; // EOF — take the default.
      decision = normalizeApprovalAnswer(answer);
      if (decision !== "invalid") break;
      // A typo used to be a silent deny. Say what went wrong and ask again.
      writeOut(`${paint(`Unrecognised answer "${String(answer).trim()}" — enter y, n, a or e.`, "danger", color)}\n`);
      decision = "deny";
    }
    if (decision === "edit") {
      const handled = await handleEdit({ event, payload, write: writeOut, launchEditor });
      if (handled === "allow") {
        session.approve(event.requestId, "allow");
        return;
      }
      writeOut(`${paint("[edit cancelled — treating as deny]", "muted", color)}\n`);
      session.approve(event.requestId, "deny");
      return;
    }
    session.approve(event.requestId, decision);
  };

  session.events.on("approval.requested", handler);
  return {
    dispose() {
      disposed = true;
      session.events.off("approval.requested", handler);
    }
  };
}

async function handleEdit({ event, payload, write, launchEditor }) {
  const editable = pickEditable(event.kind, payload);
  if (!editable) {
    write("[edit not supported for this approval kind]\n");
    return null;
  }
  const result = await launchEditor({
    initial: editable.initial,
    suffix: editable.suffix
  });
  if (result == null) return null;
  if (typeof result !== "string") return null;
  if (editable.field === "patch" && result.trim() === "") return null;
  payload[editable.field] = result;
  return "allow";
}

function pickEditable(kind, payload) {
  if (kind === "write_file") {
    return { field: "content", initial: payload.content ?? "", suffix: extensionFromPath(payload.filePath) };
  }
  if (kind === "edit") {
    return { field: "newString", initial: payload.newString ?? "", suffix: ".txt" };
  }
  if (kind === "apply_patch") {
    return { field: "patch", initial: payload.patch ?? "", suffix: ".diff" };
  }
  return null;
}

function extensionFromPath(filePath) {
  if (typeof filePath !== "string") return ".txt";
  const ext = path.extname(filePath);
  return ext.length > 0 ? ext : ".txt";
}

async function defaultLaunchEditor({ initial = "", suffix = ".txt" } = {}) {
  const editor = process.env.EDITOR ?? (process.platform === "win32" ? "notepad" : "nano");
  const dir = await mkdtemp(path.join(os.tmpdir(), "procway-edit-"));
  const file = path.join(dir, `approval${suffix}`);
  try {
    await writeFile(file, initial, "utf8");
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(editor, [file], { stdio: "inherit", shell: process.platform === "win32" });
      child.on("exit", (code) => resolve(code ?? 0));
      child.on("error", reject);
    });
    if (exitCode !== 0) return null;
    return await readFile(file, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
