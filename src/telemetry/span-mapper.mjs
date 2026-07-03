/**
 * Phase 6 §2.8 — translate AgentEvent stream into span lifecycle calls.
 *
 * The mapper subscribes to the events bus and forwards `start* / end*` calls
 * to a `SpanController` (see `otel.mjs`). Returns a detach function that
 * removes the listeners — useful for `shutdown()` and unit tests.
 *
 * Decoupling the mapping from the OTel SDK lets us unit-test the mapper with
 * a fake controller that records calls.
 */

const SUBSCRIPTIONS = [
  ["session.created", "sessionStarted"],
  ["session.resumed", "sessionStarted"],
  ["user.prompt.submitted", "turnStarted"],
  ["assistant.message.completed", "turnEnded"],
  ["turn.failed", "turnFailed"],
  ["turn.completed", "turnEnded"],
  ["tool.call.started", "toolCallStarted"],
  ["tool.call.completed", "toolCallEnded"]
];

export function spanMapForBus(events, controller) {
  if (!events || typeof events.on !== "function" || !controller) {
    return () => {};
  }
  const handlers = [];
  const wire = (type, fn) => {
    events.on(type, fn);
    handlers.push({ type, fn });
  };

  wire("session.created", (event) => controller.sessionStarted?.({
    sessionId: event.sessionId,
    attributes: pickAttributes(event, ["provider", "model", "compatibilityMode", "cwd"])
  }));
  wire("session.resumed", (event) => controller.sessionStarted?.({
    sessionId: event.sessionId,
    attributes: { resumed: true }
  }));
  wire("user.prompt.submitted", (event) => controller.turnStarted?.({
    sessionId: event.sessionId,
    messageId: event.messageId,
    attributes: { content_length: contentLength(event?.content) }
  }));
  wire("assistant.message.completed", (event) => controller.turnEnded?.({
    messageId: event.messageId,
    attributes: { tool_calls: Array.isArray(event.toolCalls) ? event.toolCalls.length : 0 }
  }));
  wire("turn.completed", (event) => controller.turnEnded?.({
    messageId: event.messageId,
    attributes: { round: event.round, exit_code: event.exitCode }
  }));
  wire("turn.failed", (event) => controller.turnEnded?.({
    messageId: event.messageId,
    attributes: { round: event.round, error: event.error?.message ?? "" }
  }));
  wire("tool.call.started", (event) => controller.toolCallStarted?.({
    toolCallId: event.toolCallId,
    name: event.name,
    sessionId: event.sessionId
  }));
  wire("tool.call.completed", (event) => controller.toolCallEnded?.({
    toolCallId: event.toolCallId,
    attributes: { ok: event.ok === true }
  }));

  return () => {
    for (const { type, fn } of handlers) {
      try { events.off?.(type, fn); } catch { /* ignored */ }
    }
    handlers.length = 0;
  };
}

function pickAttributes(event, keys) {
  const out = {};
  for (const key of keys) {
    if (event[key] != null) out[key] = event[key];
  }
  return out;
}

function contentLength(content) {
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content) {
    if (block?.kind === "text" && typeof block.text === "string") total += block.text.length;
  }
  return total;
}
