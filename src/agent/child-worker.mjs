#!/usr/bin/env node
/**
 * Phase 6 §2.5 — child agent worker entry point.
 *
 * The parent forks this script with `child_process.fork` and sends a single
 * `{ kind: "run", settings, task, cwd, depth }` message. The worker runs the
 * agent in isolation (its own event loop, OOM domain, and uncaught error
 * boundary), captures the assistant text, and replies with
 * `{ kind: "done", text, exitCode, sessionId }`. Crashes are reported with
 * `{ kind: "failed", error }` so the parent can surface them as `turn.failed`
 * without going down with the worker.
 */

import { AgentSession } from "./conversation.mjs";

if (!process.send) {
  process.exit(1);
}

process.on("message", async (raw) => {
  if (!raw || raw.kind !== "run") return;
  try {
    const session = await new AgentSession({
      settings: raw.settings,
      cwd: raw.cwd,
      depth: raw.depth ?? 0,
      // Forked child agents are programmatic spawns — tag origin="worker" so they
      // stay out of the /ai sidebar (mirrors the inline runAgentFromSession path).
      origin: "worker",
      // No wake supervisor: this process runs exactly one turn and exits, so a
      // wake turn would have nowhere to land (see runAgentFromSession).
      wake: false
    }).initialize();
    const captured = { text: "" };
    session.events.on("assistant.message.completed", (event) => {
      if (Array.isArray(event.content)) {
        const text = event.content
          .filter((block) => block?.kind === "text" && typeof block.text === "string")
          .map((block) => block.text)
          .join("");
        if (text) captured.text = text;
      }
    });
    await session.runTurn(raw.task);
    process.send?.({
      kind: "done",
      text: captured.text,
      exitCode: 0,
      sessionId: session.sessionId
    });
  } catch (error) {
    process.send?.({
      kind: "failed",
      error: { message: error?.message ?? String(error), code: error?.code }
    });
  } finally {
    process.disconnect?.();
  }
});

process.on("uncaughtException", (error) => {
  try {
    process.send?.({ kind: "failed", error: { message: error?.message ?? String(error) } });
  } catch {
    // ignored
  }
  process.exit(1);
});
