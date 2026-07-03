/**
 * @typedef {{ session: { compact: Function, compactStatus: Function, sessionId: string, messages: Array<unknown> }, args?: string[] | { strategy?: string, keepLastMessages?: number, status?: boolean } }} CompactCommandInput
 */

/**
 * Run a compact pass on the current session, or report status when
 * `args.status === true` / `--status` is present. Pure: no I/O.
 *
 * @param {CompactCommandInput} input
 */
export async function compactCommand({ session, args = [] } = {}) {
  const options = parseCompactArgs(args);
  if (options.status) {
    return { sessionId: session.sessionId, status: session.compactStatus() };
  }
  const result = await session.compact(options);
  return {
    sessionId: session.sessionId,
    compacted: result.compacted,
    strategy: result.strategy,
    keepLastMessages: result.keepLastMessages,
    removedMessages: result.removedMessages,
    messageCount: session.messages.length
  };
}

function parseCompactArgs(args) {
  if (args && !Array.isArray(args) && typeof args === "object") return args;
  const list = Array.isArray(args) ? args : [];
  const options = {};
  for (let index = 0; index < list.length; index += 1) {
    const part = list[index];
    if (part === "--status") options.status = true;
    else if (part === "--aggressive") options.strategy = "summarize-aggressive";
    else if (part === "--strategy") options.strategy = list[++index];
    else if (part === "--keep-last") options.keepLastMessages = Number(list[++index]);
  }
  return options;
}
