import { AgentSession } from "./conversation.mjs";

/**
 * Convenience entry point for running a single-shot turn outside the REPL.
 * Returns `{ sessionId, text, exitCode, events }` — `text` is the final
 * assistant message text aggregated from `assistant.message.completed`.
 */
export async function runAgent({
  settings,
  prompt,
  cwd = process.cwd(),
  maxToolRounds = settings.tools?.maxToolRounds ?? 150,
  depth = 0,
  events
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
  await session.runTurn(prompt, { maxToolRounds });
  await session.flushEventLog();
  return { sessionId: session.sessionId, text: captured.text, exitCode: 0 };
}
