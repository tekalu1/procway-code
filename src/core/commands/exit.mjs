/**
 * Sentinel slash command — adapters listen for the `exit` action and tear
 * down their REPL loop. The CLI hooks the actual `process.exit` call.
 */
export async function exitCommand() {
  return { action: "exit" };
}
