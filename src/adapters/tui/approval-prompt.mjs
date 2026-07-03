import readline from "node:readline/promises";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { renderDiff } from "./diff.mjs";

/**
 * Approval adapter — subscribes to `approval.requested` and prompts the user
 * for `y / n / a / e`. Phase 5 adds `e` (edit-then-approve): the proposed
 * payload is written to a temp file, `EDITOR` is launched, and the edited
 * contents replace the payload before resolving "allow".
 *
 * Diff previews: when the payload contains `before` / `after` / `filePath`,
 * a coloured diff is shown above the prompt so the user can see exactly
 * what's about to change.
 *
 * Test hooks:
 * - `launchEditor({ initial, suffix })` lets tests substitute the spawn step.
 * - `prompt({ rl, question })` lets tests intercept the readline question.
 */
export function attachApprovalPrompt({
  session,
  input = process.stdin,
  output = process.stdout,
  rl: sharedRl = null,
  launchEditor = defaultLaunchEditor,
  prompt
} = {}) {
  if (!session?.events || typeof session.approve !== "function") {
    throw new TypeError("attachApprovalPrompt: session with events + approve() is required");
  }
  let disposed = false;
  // CRITICAL: share the caller's readline interface when provided. Creating a
  // second interface that listens on the same stdin caused every keystroke to
  // be echoed twice once an approval prompt had run (the second rl persisted
  // and kept reading even when idle).
  const askQuestion = prompt ?? (async ({ question }) => {
    if (sharedRl) return sharedRl.question(question);
    const localRl = readline.createInterface({ input, output });
    try {
      return await localRl.question(question);
    } finally {
      try { localRl.close(); } catch { /* ignore */ }
    }
  });

  const handler = async (event) => {
    if (event?.type !== "approval.requested" || disposed) return;
    const payload = event.payload ?? {};
    if (payload.before != null || payload.after != null) {
      const banner = renderDiff({
        filePath: payload.filePath ?? event.summary ?? "(unknown)",
        before: payload.before ?? "",
        after: payload.after ?? "",
        operation: payload.operation
      });
      try { output.write(banner); } catch { /* ignore */ }
    }
    let answer;
    try {
      answer = await askQuestion({
        question: `Approve ${event.kind}: ${event.summary} [y/n/a/e]? `
      });
    } catch {
      session.approve(event.requestId, "deny");
      return;
    }
    const trimmed = (answer ?? "").trim().toLowerCase();
    if (trimmed === "e" || trimmed === "edit") {
      const handled = await handleEdit({ event, payload, output, launchEditor });
      if (handled === "allow") {
        session.approve(event.requestId, "allow");
        return;
      }
      try { output.write("[edit cancelled — treating as deny]\n"); } catch { /* ignore */ }
      session.approve(event.requestId, "deny");
      return;
    }
    let decision = "deny";
    if (trimmed === "y" || trimmed === "yes") decision = "allow";
    else if (trimmed === "a" || trimmed === "always") decision = "always-allow";
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

async function handleEdit({ event, payload, output, launchEditor }) {
  const editable = pickEditable(event.kind, payload);
  if (!editable) {
    try { output.write("[edit not supported for this approval kind]\n"); } catch { /* ignore */ }
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
