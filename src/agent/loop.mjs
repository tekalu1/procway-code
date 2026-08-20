import { AgentSession } from "./conversation.mjs";
import {
  drainWakeWork,
  formatWakeDrainAbandonNotice,
  resolveWakeDrainLimits
} from "./wake-drain.mjs";

/**
 * Convenience entry point for running a single-shot turn outside the REPL.
 * Returns `{ sessionId, text, exitCode, drain }` — `text` is the final
 * assistant message text aggregated from `assistant.message.completed`, and
 * `drain` reports how the event-wake drain (below) ended.
 *
 * event-wake (issue #143): the turn returning is NOT the end of the session's
 * work any more. Background children (`spawn_agent runInBackground:true`) and
 * background runs outlive the turn that started them, so after the first turn
 * we wait until the session's wake supervisor reports nothing outstanding,
 * running whatever wake turns it injects in the meantime. Bounded by
 * `PROCWAY_WAKE_DRAIN_TIMEOUT_MS` / `PROCWAY_WAKE_DRAIN_MAX_TURNS` — see
 * wake-drain.mjs. Because the drain is awaited HERE, the caller's teardown
 * (reaping background shells in cli.mjs `runPrompt`) happens strictly after it,
 * never in the middle of a wake turn.
 */
export async function runAgent({
  settings,
  prompt,
  cwd = process.cwd(),
  maxToolRounds = settings.tools?.maxToolRounds ?? 150,
  depth = 0,
  events,
  // Test seam / escape hatch: overrides for the drain's bounds and clock.
  wakeDrain = null
}) {
  const session = await new AgentSession({ settings, cwd, depth, events }).initialize();
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
  let drain;
  try {
    await session.runTurn(prompt, { maxToolRounds });
    drain = await drainWakeWork({
      supervisor: session.wakeSupervisor,
      injectTurn: (text) => session.runTurn(text, { maxToolRounds, wake: true }),
      ...resolveWakeDrainLimits(),
      onAbandon: (info) => {
        try { process.stderr.write(formatWakeDrainAbandonNotice(info)); } catch { /* best-effort */ }
      },
      ...(wakeDrain ?? {})
    });
  } finally {
    // Stop before the caller tears the process down: a wake injected after this
    // point would start a turn nothing is waiting for.
    try { session.wakeSupervisor?.stop(); } catch { /* best-effort */ }
  }
  await session.flushEventLog();
  return { sessionId: session.sessionId, text: captured.text, exitCode: 0, drain };
}
