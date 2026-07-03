import { createMessage } from "../types/message.mjs";

/**
 * Replay an event stream into a Message[] projection.
 *
 * Phase 3 (phase2_E-1): events without sessionId no longer fall back to a
 * literal sentinel. The projection threads the most recent observed sessionId
 * forward; if a message-producing event arrives before any sessionId has been
 * seen, the event is skipped and the optional `onWarning` callback is invoked
 * so callers can surface diagnostics. AgentSession always emits sessionId on
 * every event, so this only triggers on malformed external streams.
 *
 * @param {Iterable<import("../events/types.mjs").AgentEvent>} events
 * @param {{ onWarning?: (warning: { reason: string, event: import("../events/types.mjs").AgentEvent }) => void }} [options]
 * @returns {import("../types/message.mjs").Message[]}
 */
export function messagesFromEvents(events, { onWarning } = {}) {
  if (!events) return [];
  const messages = [];
  let lastSessionId = null;
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    if (typeof event.sessionId === "string" && event.sessionId.length > 0) {
      lastSessionId = event.sessionId;
    }
    switch (event.type) {
      case "user.prompt.submitted":
        if (!lastSessionId) {
          onWarning?.({ reason: "missing sessionId", event });
          break;
        }
        messages.push(createMessage({
          id: event.messageId,
          role: "user",
          content: Array.isArray(event.content) ? event.content : [],
          sessionId: lastSessionId
        }));
        break;
      case "assistant.message.completed":
        if (!lastSessionId) {
          onWarning?.({ reason: "missing sessionId", event });
          break;
        }
        messages.push(createMessage({
          id: event.messageId,
          role: "assistant",
          content: Array.isArray(event.content) ? event.content : [],
          sessionId: lastSessionId,
          // DeepSeek thinking-mode echo: round-trip the reasoning blob
          // through the event log so that on resume, toOpenAiMessage can
          // re-attach `reasoning_content` to the assistant message and
          // SiliconFlow does not reject the next request with code 20015.
          ...(typeof event.reasoningContent === "string" && event.reasoningContent.length > 0
            ? { meta: { reasoningContent: event.reasoningContent } }
            : {})
        }));
        break;
      case "tool.call.completed":
        if (!lastSessionId) {
          onWarning?.({ reason: "missing sessionId", event });
          break;
        }
        messages.push(createMessage({
          role: "tool",
          toolCallId: event.toolCallId,
          sessionId: lastSessionId,
          content: [{
            kind: "tool_result",
            toolCallId: event.toolCallId,
            result: event.result,
            ok: Boolean(event.ok)
          }]
        }));
        break;
      default:
        break;
    }
  }
  return messages;
}
