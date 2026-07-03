import { transcriptFromMessages } from "../projections/transcript.mjs";

/**
 * Project the session's messages into transcript nodes. Pure: no I/O.
 *
 * @param {{ session: { messages: Array<unknown>, sessionId: string }, args?: { maxMessages?: number } }} input
 */
export async function historyCommand({ session, args = {} } = {}) {
  const opts = (args && !Array.isArray(args) && typeof args === "object") ? args : {};
  return {
    sessionId: session.sessionId,
    transcript: transcriptFromMessages(session.messages ?? [], opts)
  };
}
