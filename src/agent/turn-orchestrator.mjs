import { randomUUID } from "node:crypto";
import { runProvider } from "../providers/index.mjs";
import { isMutationTool, filterToolDefinitionsForSettings, selectToolDefinitions } from "../tools/registry.mjs";
import { stripInvalidToolArgs } from "../providers/format/tool-args.mjs";
import { condenseStaleToolResults, resolveStaleToolResultSettings } from "../providers/stale-tool-results.mjs";
import { isLongRunningCommand, DEFAULT_LONG_RUNNING_SHELL_TIMEOUT_MS } from "../safety/command-classifier.mjs";

/**
 * Scheduler budget for tools that legitimately run long. Mirrors the tool's
 * own deadline plus a grace margin so the scheduler is never the one that
 * fires first (the tool's own timeout produces the more useful error).
 * Null → use the scheduler's shared default.
 *
 * Exported for tests: every branch here exists because the shared 60s tool
 * timeout would otherwise SIGTERM a legitimate multi-minute wait, and losing
 * one is invisible until a long run dies in production. tests/turn-orchestrator
 * pins each branch.
 */
export function toolCallBudgetMs(toolCall, session) {
  const args = toolCall?.args ?? {};
  if (toolCall?.name === "run_shell" && args.runInBackground !== true) {
    // Keep this in lockstep with shell.mjs's effectiveTimeout: a long-running
    // orchestration drive (run loop / run task / run next) gets the relaxed
    // ceiling so the scheduler never SIGTERMs the loop before the shell tool's
    // own (much later) deadline would. shell.mjs derives its base from
    // sandbox.timeoutMs (when set) else args.timeoutMs, then Math.max with the
    // long-running ceiling — mirror ALL THREE here so the budget is never lower
    // than the shell timer even when a tenant configures sandbox.timeoutMs above
    // the ceiling.
    if (isLongRunningCommand(args.command)) {
      const lr = session.settings?.tools?.longRunningShellTimeoutMs ?? DEFAULT_LONG_RUNNING_SHELL_TIMEOUT_MS;
      const sandboxMs = session.settings?.tools?.sandbox?.timeoutMs;
      const candidates = [lr];
      if (Number.isFinite(args.timeoutMs)) candidates.push(args.timeoutMs);
      if (Number.isFinite(sandboxMs)) candidates.push(Number(sandboxMs));
      return Math.max(...candidates) + 30000;
    }
    const base = Number.isFinite(args.timeoutMs)
      ? args.timeoutMs
      : (session.settings?.tools?.shellTimeoutMs ?? 300000);
    return base + 30000;
  }
  if (toolCall?.name === "shell_job" && args.action === "wait") {
    const base = Number.isFinite(args.waitMs) ? args.waitMs : 600000;
    return base + 30000;
  }
  if (toolCall?.name === "agent_job" && args.action === "wait") {
    // Issue #142: the JOIN for a background child (spawn_agent with
    // runInBackground:true). Same deal as shell_job wait — the tool owns its
    // own deadline (waitMs, default 600000) and heartbeats while it blocks, so
    // the scheduler must never be the one that fires first.
    const base = Number.isFinite(args.waitMs) ? args.waitMs : 600000;
    return base + 30000;
  }
  if (toolCall?.name === "start_run" || toolCall?.name === "attach_run"
    || toolCall?.name === "resume_run" || toolCall?.name === "reply_run") {
    // ADR 0029 await-yield: these tools WAIT for the run-loop job to pause for
    // input or finish — minutes, not seconds. Without a budget the shared 60s
    // tool timeout would SIGTERM the await mid-flight. Grant the same relaxed
    // long-running ceiling a `run loop` shell drive gets; the wait's own
    // heartbeat (run-control DEFAULT_JOIN_HEARTBEAT_MS, forwarded to onProgress)
    // keeps the turn-idle watchdog fed.
    //
    // Issue #143 Phase 2 made the wait event-driven (no more 2s poll), which
    // does NOT make this branch redundant: the await is still an await. The
    // tool's own deadline is derived from the SAME `lr` below and set one margin
    // lower (run-control joinTimeoutMsFor), so the tool returns its own honest
    // yield instead of being killed here.
    const lr = session.settings?.tools?.longRunningShellTimeoutMs ?? DEFAULT_LONG_RUNNING_SHELL_TIMEOUT_MS;
    return lr + 30000;
  }
  if (toolCall?.name === "spawn_agent") {
    // ADR 0029 P3: spawn_agent is now an `agent` kind delegated job awaited to
    // completion (await-yield). A child runs many provider rounds = minutes, so
    // the shared 60s tool timeout would SIGTERM the await mid-child. Grant the
    // child's own provider deadline (agents.defaultTimeoutMs) but never below the
    // relaxed long-running ceiling; the driver's onProgress heartbeats keep the
    // turn-idle watchdog fed. (Previously spawn_agent had no budget → 60s.)
    const lr = session.settings?.tools?.longRunningShellTimeoutMs ?? DEFAULT_LONG_RUNNING_SHELL_TIMEOUT_MS;
    const childDeadline = session.settings?.agents?.defaultTimeoutMs;
    const base = Number.isFinite(childDeadline) ? Math.max(lr, Number(childDeadline)) : lr;
    return base + 30000;
  }
  // request_user_action needs no special budget any more: ADR 0037 D1 made it
  // record-and-return (the coordinator emits and resolves immediately; the turn
  // winds down and the user's answer arrives as a NEW turn), so the shared
  // tool timeout never races a human.
  return null;
}
import {
  hasMutationToolResult,
  hasTaskCompletionToolResult,
  buildTaskCompletionRetryPrompt
} from "./intent.mjs";
import { runToolCalls } from "./scheduler.mjs";
import { createEvent } from "../core/events/types.mjs";
import { createMessage } from "../core/types/message.mjs";
import {
  USER_INTERRUPT_CODE,
  USER_INTERRUPT_MESSAGE,
  isAbortError,
  isUserInterruptAbort
} from "./abort.mjs";

export {
  USER_INTERRUPT_CODE,
  USER_INTERRUPT_MESSAGE,
  createUserInterruptAbort,
  isAbortError,
  isUserInterruptAbort
} from "./abort.mjs";

const FILE_MUTATION_RETRY_PROMPT = "You said you would create or update a file, but no file-writing tool call was made. Call write_file, apply_patch, or Edit now. Do not provide a final answer until the file tool succeeds.";

// The file-mutation retry (below) re-injects a "you didn't write the file" nudge
// each round the model ends without a successful write. Left unbounded it could
// spin to maxToolRounds (150) — and if the write fails DETERMINISTICALLY (a
// truncated/invalid write_file that keeps failing the same way) the whole turn
// wedged, holding runningTurn true and blocking every new message on the bridge.
// A low independent cap, plus an early bail-out when the SAME tool fails the
// SAME way twice in a row, ends the turn cleanly instead.
const FILE_MUTATION_RETRY_LIMIT = 3;

// The retry nudge is about FILE writes, so only these tools' failures count as
// a "repeated write failure". A failed read_file/run_shell earlier in the turn
// must not masquerade as one and trip the bail-out.
const FILE_MUTATION_TOOL_NAMES = new Set(["write_file", "apply_patch", "Edit"]);

/**
 * Index just after the most recent injected FILE_MUTATION_RETRY_PROMPT this
 * turn (or turnStartIndex if none injected yet). Failures BEFORE this point are
 * stale — they predate the last nudge and must not be re-counted as a fresh
 * repeat, or a single old write failure would trip the bail-out on two
 * consecutive text-only rounds even when the model never retried the write.
 */
function lastRetryPromptBoundary(messages, turnStartIndex) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= turnStartIndex; i -= 1) {
    const message = list[i];
    if (message?.role !== "user" || !Array.isArray(message.content)) continue;
    if (message.content.some((block) => block?.kind === "text" && block.text === FILE_MUTATION_RETRY_PROMPT)) {
      return i + 1;
    }
  }
  return turnStartIndex;
}

/**
 * Signature (`${tool}:${error}`) of the most recent FAILED file-mutation tool
 * result at or after `sinceIndex`, else null. Used to detect a deterministic
 * write failure the retry nudge can never clear (it would re-fail identically).
 */
function newFileMutationFailureSignature(messages, sinceIndex) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= sinceIndex; i -= 1) {
    const message = list[i];
    if (!message || message.role !== "tool" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.kind !== "tool_result" || block.ok !== false) continue;
      const tool = block.result?.data?.tool;
      if (!FILE_MUTATION_TOOL_NAMES.has(tool)) continue;
      const error = block.result?.data?.error ?? block.result?.summary ?? "error";
      return `${tool}:${error}`;
    }
  }
  return null;
}

const KNOWN_TOOL_KINDS_BY_NAME = new Set([
  "list_files",
  "read_file",
  "search_files",
  "write_file",
  "apply_patch",
  "edit",
  "run_shell",
  "spawn_agent",
  "view_image",
  "ask_image",
  "load_tools"
]);

export async function executeModelRound({ session, round, turnMessageId, signal, runProviderImpl = runProvider }) {
  const activityId = randomUUID();
  session.events.emit(createEvent("activity.started", {
    sessionId: session.sessionId,
    activityId,
    label: "model waiting",
    detail: `round=${round}`
  }));

  const messageId = randomUUID();
  let started = false;
  let partialText = "";

  try {
    // A read-only turn (set via runTurn's toolPolicy option) hides every
    // mutation tool from the model so it never even attempts a write/exec.
    const policyTools = session.activeToolPolicy === "read-only"
      ? session.tools.filter((tool) => !isMutationTool(tool?.function?.name))
      : session.tools;
    // Deferred-tool tier (token reduction): the heavy tail of the catalog is
    // replaced by the `load_tools` meta-tool until the session loads it.
    // Resolved per round so a load that happened in THIS turn's previous
    // round already ships its schema in the next request.
    const deferredShaped = selectToolDefinitions(policyTools, {
      loadedTools: session.loadedTools ?? [],
      enabled: session.settings?.tools?.deferredLoading !== false,
      settings: session.settings
    });
    // Vision-dependent tools resolve PER TURN against the live settings:
    // hot-reload mutates session.settings in place mid-session, so a list
    // computed at session construction would keep offering view_image after
    // the main provider turned text-only (and never expose ask_image).
    const tools = filterToolDefinitionsForSettings(deferredShaped, session.settings);
    const providerResponse = await runProviderImpl({
      settings: session.settings,
      // Egress-only condensation of OLD oversized tool results (the last
      // keepRecent tool messages always ship intact). session.messages /
      // snapshot / events.jsonl keep the full payloads.
      messages: condenseStaleToolResults(
        session.messages,
        resolveStaleToolResultSettings(session.settings)
      ),
      tools,
      cwd: session.cwd,
      signal
    });

    let response;
    if (providerResponse?.deltaStream && typeof providerResponse.finalize === "function") {
      session.events.emit(createEvent("assistant.message.started", {
        sessionId: session.sessionId,
        messageId,
        round
      }));
      started = true;
      for await (const chunk of providerResponse.deltaStream) {
        // Heartbeat chunks (openai-codex keepalive frames during a long
        // reasoning phase) carry no text — surface them as `activity.tick` so
        // the turn-idle watchdog's `events.on("*")` bump fires and a healthy
        // long-thinking turn is not aborted as a false stall. No chat text.
        if (chunk?.kind === "heartbeat") {
          session.events.emit(createEvent("activity.tick", {
            sessionId: session.sessionId,
            messageId,
            round,
            detail: "model reasoning…"
          }));
          continue;
        }
        if (!chunk?.deltaText) continue;
        // Providers that surface chain-of-thought (e.g. openai-codex with
        // reasoning models) tag chunks with `kind: "reasoning"`. Forward
        // those as `assistant.reasoning.delta` so the dashboard can show
        // progress during the "model waiting" window — without this the
        // UI goes silent for the whole reasoning phase, which on gpt-5.5
        // routinely runs into the minutes and looks like a hang.
        if (chunk.kind === "reasoning") {
          session.events.emit(createEvent("assistant.reasoning.delta", {
            sessionId: session.sessionId,
            messageId,
            deltaText: chunk.deltaText
          }));
          continue;
        }
        partialText += chunk.deltaText;
        session.events.emit(createEvent("assistant.message.delta", {
          sessionId: session.sessionId,
          messageId,
          deltaText: chunk.deltaText
        }));
      }
      response = await providerResponse.finalize();
    } else {
      response = providerResponse;
      session.events.emit(createEvent("assistant.message.started", {
        sessionId: session.sessionId,
        messageId,
        round
      }));
      started = true;
    }

    response.messageId = messageId;
    response.round = round;

    session.events.emit(createEvent("activity.stopped", {
      sessionId: session.sessionId,
      activityId,
      outcome: response.toolCalls?.length ? `tool calls=${response.toolCalls.length}` : "response received"
    }));
    return response;
  } catch (error) {
    session.events.emit(createEvent("activity.stopped", {
      sessionId: session.sessionId,
      activityId,
      outcome: "failed"
    }));
    // Emit turn.failed REGARDLESS of `started`. Previously this was gated on
    // `started` (the model produced at least one chunk), so a turn that failed
    // BEFORE the first chunk — e.g. the provider request stalled and timed out
    // (UND_ERR_HEADERS_TIMEOUT / UND_ERR_BODY_TIMEOUT) after exhausting
    // retries, or threw while opening the stream — never told the client the
    // turn ended. The UI then hung at "model waiting" forever. Always emitting
    // turn.failed lets the dashboard clear the thinking/reasoning state and
    // offer a retry. partialContent is only meaningful when we did start.
    const partialContent = started && partialText.length > 0 ? [{ kind: "text", text: partialText }] : [];
    const { message: failMessage, code: failCode } = describeTurnAbort(session, error);
    // S-6: an ABORTED turn commits whatever the assistant already said. The
    // streaming renderer flushes its buffer on turn.failed, so without this the
    // user sees text on screen that session.messages (and therefore the next
    // request + every resume/replay) never had — Claude Code keeps it.
    // Consistency rule: we commit TEXT ONLY. tool_calls are never partially
    // committed here (the aggregated tool_calls only exist after finalize(),
    // which an abort skips), so no tool_call is left without its tool result.
    if (partialContent.length > 0 && isAbortError(error)) {
      commitPartialAssistantMessage({ session, messageId, content: partialContent });
    }
    session.events.emit(createEvent("turn.failed", {
      sessionId: session.sessionId,
      round,
      error: { message: failMessage, code: failCode },
      ...(partialContent.length > 0 ? { partialContent } : {}),
      messageId: turnMessageId ?? messageId
    }));
    try {
      Object.defineProperty(error, "turnFailedEmitted", { value: true, configurable: true });
    } catch { /* primitive errors */ }
    throw error;
  }
}

/**
 * Persist the assistant text streamed before an abort as a real message, and
 * announce it with `assistant.message.completed` so the event-log projection
 * (core/projections/messages.mjs) reconstructs it on resume/replay exactly like
 * a normal message. Emitted BEFORE turn.failed, which is what the TUI streaming
 * renderer needs to flush once (its turn.failed handler then no-ops).
 */
function commitPartialAssistantMessage({ session, messageId, content }) {
  try {
    const assistantMessage = createMessage({
      id: messageId,
      role: "assistant",
      sessionId: session.sessionId,
      content
    });
    session.messages.push(assistantMessage);
    session.events.emit(createEvent("assistant.message.completed", {
      sessionId: session.sessionId,
      messageId: assistantMessage.id,
      content: assistantMessage.content
    }));
  } catch { /* committing the partial must never mask the original failure */ }
}

/**
 * Map a turn abort to a clear message/code. Two tagged reasons matter:
 *   - the turn-idle watchdog ({ name:'IdleWatchdogAbort', idleMs }) → a
 *     retryable "model went silent" message + 'idle_timeout' code;
 *   - a user Stop (createUserInterruptAbort) → the unified
 *     "Interrupted by user" / 'interrupted' pair, regardless of whether the
 *     turn was between rounds, mid-stream, or mid-tool when it landed.
 * Everything else passes through unchanged.
 */
export function describeTurnAbort(session, error) {
  // The watchdog's tagged reason / turnIdleAborted flag is authoritative — the
  // error a provider throws on abort varies (DOMException 'AbortError', undici
  // 'ABORT_ERR', the cli-agent's 'aborted', …), so don't gate on the error code.
  const reason = session?.turnAbortController?.signal?.reason;
  const idleAbort = reason?.name === "IdleWatchdogAbort" || session?.turnIdleAborted === true;
  if (!idleAbort) {
    // A user Stop wins over whatever error the abort surfaced as. Checking the
    // session flag (not just the reason) also covers a provider that swallowed
    // the abort and threw its own error while the interrupt was pending.
    if (isUserInterruptAbort(reason) || isUserInterruptAbort(error) || session?.interruptRequested === true) {
      return { idleAbort: false, userAbort: true, message: USER_INTERRUPT_MESSAGE, code: USER_INTERRUPT_CODE };
    }
    return { idleAbort: false, userAbort: false, message: error?.message ?? String(error), code: error?.code };
  }
  const idleSec = Math.round((reason?.idleMs ?? 0) / 1000);
  return {
    idleAbort: true,
    // English, like every other user-facing string in this CLI (P3b-10).
    message: `The model sent nothing for ${idleSec || "—"}s, so the turn was aborted (a long reasoning phase is the usual cause; tune it with PROCWAY_TURN_IDLE_TIMEOUT_MS, 0 disables).`,
    code: "idle_timeout"
  };
}

export async function handleModelResponseWithoutTools({
  session,
  response,
  needsFileMutation,
  requiresTaskComplete = false,
  procwayMeta = null,
  turnStartIndex,
  round
}) {
  // A-1: prefer the session-level procwayMeta (set on first worker prompt and
  // persisted across turns) over the per-call param. The param remains for
  // backward compat with tests / direct callers; when present it acts as an
  // override but session state still wins if both diverge.
  const effectiveMeta = session?.procwayMeta ?? procwayMeta;
  const effectiveRequires = Boolean(session?.procwayMeta) || requiresTaskComplete;
  const text = extractAssistantTextFromResponse(response);
  const reasoningContent = extractReasoningContentFromResponse(response);
  const assistantMessage = createMessage({
    id: response?.messageId,
    role: "assistant",
    sessionId: session.sessionId,
    content: text ? [{ kind: "text", text }] : [],
    // DeepSeek thinking-mode requires the previous turn's reasoning_content
    // to be echoed on the next request — persist it in meta so toOpenAiMessage
    // can restore it. Other providers ignore unknown meta fields.
    ...(reasoningContent ? { meta: { reasoningContent } } : {})
  });

  // The "you said you'd write a file but didn't call write_file" retry loop
  // only makes sense when the model uses procway's tool-call protocol. cli-agent
  // providers (codex, claude-code, …) execute tools internally and report back
  // via text — there is no procway tool record to find, so the heuristic always
  // fires and traps the turn in a retry loop. Skip the check for cli-agent.
  const activeProvider = session.settings?.providers?.[session.settings?.defaultProvider];
  const isCliAgentProvider = activeProvider?.type === "cli-agent";
  if (!isCliAgentProvider && needsFileMutation && !hasMutationToolResult(session.messages, turnStartIndex)) {
    session.messages.push(assistantMessage);
    session.events.emit(createEvent("assistant.message.completed", {
      sessionId: session.sessionId,
      messageId: assistantMessage.id,
      content: assistantMessage.content,
      // DeepSeek thinking-mode echo (SiliconFlow code 20015): the projection
      // restores this onto Message.meta.reasoningContent during resume so the
      // next outgoing request can include it in toOpenAiMessage().
      ...(reasoningContent ? { reasoningContent } : {})
    }));
    emitUsageRecorded({ session, response, round });

    // Independent, low retry cap + deterministic-failure bail-out (see
    // FILE_MUTATION_RETRY_LIMIT). State lives on the session and is reset per
    // turn in runTurn.
    const retryState = session.fileMutationRetry ?? (session.fileMutationRetry = { count: 0, lastSignature: null });
    // Only consider write failures NEW since the last nudge (see the helpers) so
    // a stale/unrelated failure can't trip the deterministic-failure bail-out.
    const boundary = lastRetryPromptBoundary(session.messages, turnStartIndex);
    const failureSignature = newFileMutationFailureSignature(session.messages, boundary);
    const sameFailureRepeated = failureSignature != null && failureSignature === retryState.lastSignature;
    retryState.count += 1;
    retryState.lastSignature = failureSignature;

    if (retryState.count > FILE_MUTATION_RETRY_LIMIT || sameFailureRepeated) {
      const reason = sameFailureRepeated
        ? `the file-writing tool kept failing the same way (${failureSignature})`
        : `the file write did not succeed after ${FILE_MUTATION_RETRY_LIMIT} attempts`;
      return {
        action: "stop",
        response: {
          error: {
            message: `Stopped the turn: ${reason}. The requested file was not written.`,
            code: "file_mutation_retry_exhausted"
          }
        }
      };
    }

    const retryMessage = createMessage({
      role: "user",
      sessionId: session.sessionId,
      content: [{ kind: "text", text: FILE_MUTATION_RETRY_PROMPT }]
    });
    session.messages.push(retryMessage);
    session.events.emit(createEvent("user.prompt.submitted", {
      sessionId: session.sessionId,
      messageId: retryMessage.id,
      content: retryMessage.content
    }));
    await session.save();
    return { action: "continue" };
  }

  // Procway worker tasks: same retry pattern but for the `task complete`
  // finalization step. Without this, the agent emits "## 完了:" prose and
  // the runner waits forever because no procway CLI was actually called.
  // Interactive (hearing) tasks are exempt: ending a turn without `task
  // complete` is the designed awaiting-user-input hand-off to ChatPanel
  // (Phase 4c) — injecting the retry here forced the worker to self-answer
  // the hearing and complete the task without ever asking the user.
  // The scan starts at 0, NOT turnStartIndex: procwayMeta sticks on the
  // session forever, so follow-up ChatPanel turns AFTER the task completed
  // still run this check. Scoping it to the current turn made every such
  // turn demand a fresh `task complete`, which the server rejects with 400
  // ALREADY_COMPLETED — an unwinnable retry loop that only ended at
  // maxToolRounds. A completion recorded in ANY earlier turn (same sticky
  // ticket/task) is permanent: a task cannot un-complete, so session-wide
  // evidence is always sufficient. (shouldRemindTaskCompletion, the
  // turn-end twin of this check, already scanned from 0.)
  if (!isCliAgentProvider && effectiveRequires && effectiveMeta
      && effectiveMeta.interactive !== true
      && !hasTaskCompletionToolResult(session.messages, effectiveMeta, 0)) {
    session.messages.push(assistantMessage);
    session.events.emit(createEvent("assistant.message.completed", {
      sessionId: session.sessionId,
      messageId: assistantMessage.id,
      content: assistantMessage.content,
      ...(reasoningContent ? { reasoningContent } : {})
    }));
    emitUsageRecorded({ session, response, round });
    const retryMessage = createMessage({
      role: "user",
      sessionId: session.sessionId,
      content: [{ kind: "text", text: buildTaskCompletionRetryPrompt(effectiveMeta) }]
    });
    session.messages.push(retryMessage);
    session.events.emit(createEvent("user.prompt.submitted", {
      sessionId: session.sessionId,
      messageId: retryMessage.id,
      content: retryMessage.content
    }));
    await session.save();
    return { action: "continue" };
  }

  session.messages.push(assistantMessage);
  session.events.emit(createEvent("assistant.message.completed", {
    sessionId: session.sessionId,
    messageId: assistantMessage.id,
    content: assistantMessage.content,
    ...(reasoningContent ? { reasoningContent } : {})
  }));
  emitUsageRecorded({ session, response, round });
  await session.save();
  return { action: "return", response };
}

export async function executeToolsRound({ session, round, toolCalls, messageId, response = null, signal = null }) {
  const reasoningContent = extractReasoningContentFromResponse(response);
  const reasoningMeta = buildReasoningMeta(response);
  // Args recorded in history / emitted to the UI must NOT carry the invalid-args
  // marker — it is an execution-layer signal only. Record `{}` for a marked
  // call (paired with its ok:false tool_result). The ORIGINAL toolCall objects
  // are used unchanged for execution below, so validateToolArgs still sees the
  // marker and returns the clear, retryable error.
  const recordArgs = (toolCall) => stripInvalidToolArgs(toolCall.args ?? {});
  const assistantMessage = createMessage({
    id: messageId,
    role: "assistant",
    sessionId: session.sessionId,
    content: toolCalls.map((toolCall) => ({
      kind: "tool_use",
      toolCallId: toolCall.id,
      name: toolCall.name,
      args: recordArgs(toolCall)
    })),
    ...(reasoningMeta ? { meta: reasoningMeta } : {})
  });
  session.messages.push(assistantMessage);

  // Emit tool.call.scheduled BEFORE assistant.message.completed so the
  // dashboard can attach tool calls to the correct (still-unfinalized)
  // assistant message via ensureOpenAssistantMessage(). Previously these
  // fired after .completed, which caused a spurious empty assistant
  // message to be created for the tools — making tool calls render after
  // the final answer in the chat panel.
  for (const toolCall of toolCalls) {
    const mutation = isMutationTool(toolCall.name) || (session.mcpRegistry?.isMcpTool(toolCall.name) ?? false);
    session.events.emit(createEvent("tool.call.scheduled", {
      sessionId: session.sessionId,
      toolCallId: toolCall.id,
      name: toolCall.name,
      args: recordArgs(toolCall),
      mutation
    }));
  }

  session.events.emit(createEvent("assistant.message.completed", {
    sessionId: session.sessionId,
    messageId: assistantMessage.id,
    content: assistantMessage.content,
    toolCalls: toolCalls.map((toolCall) => ({
      toolCallId: toolCall.id,
      name: toolCall.name,
      args: recordArgs(toolCall)
    })),
    ...(reasoningContent ? { reasoningContent } : {})
  }));
  emitUsageRecorded({ session, response, round });

  const scheduledCalls = toolCalls.map((toolCall, index) => {
    const mutation = isMutationTool(toolCall.name) || (session.mcpRegistry?.isMcpTool(toolCall.name) ?? false);
    return {
      index,
      id: toolCall.id,
      name: toolCall.name,
      args: toolCall.args,
      mutation,
      // Long-running shell work declares its own scheduler budget: the shared
      // 60s default killed every foreground install/build/`task complete`
      // mid-flight ("Tool timed out after 60000ms") even when the tool itself
      // had a longer deadline.
      ...(toolCallBudgetMs(toolCall, session) != null ? { timeoutMs: toolCallBudgetMs(toolCall, session) } : {}),
      run: async () => {
        const activityId = randomUUID();
        const toolStartedAt = Date.now();
        session.events.emit(createEvent("activity.started", {
          sessionId: session.sessionId,
          activityId,
          label: `tool:${toolCall.name}`,
          detail: "running"
        }));
        session.events.emit(createEvent("tool.call.started", {
          sessionId: session.sessionId,
          toolCallId: toolCall.id,
          name: toolCall.name
        }));
        // Live progress channel for long-running tools (foreground run_shell
        // streaming, shell_job wait heartbeats). activity.tick feeds the
        // turn-idle watchdog (any session event bumps it) so a healthy
        // multi-minute command no longer aborts the TURN at 90s of event
        // silence, and gives the ChatPanel something to render meanwhile.
        const onProgress = ({ detail } = {}) => {
          session.events.emit(createEvent("activity.tick", {
            sessionId: session.sessionId,
            activityId,
            elapsedMs: Date.now() - toolStartedAt,
            ...(typeof detail === "string" && detail ? { detail } : {})
          }));
        };
        try {
          const result = await session.executeSingleToolCall(toolCall, { onProgress, signal });
          session.events.emit(createEvent("activity.stopped", {
            sessionId: session.sessionId,
            activityId,
            outcome: "done"
          }));
          return result;
        } catch (error) {
          session.events.emit(createEvent("activity.stopped", {
            sessionId: session.sessionId,
            activityId,
            outcome: "failed"
          }));
          throw error;
        }
      }
    };
  });

  const toolResults = await runToolCalls(scheduledCalls, {
    maxParallel: session.settings.tools?.maxParallelTools ?? 8,
    timeoutMs: session.settings.tools?.toolTimeoutMs ?? 60_000,
    // S-2: a user Stop settles every still-running call as `interrupted` and
    // stops the scheduler from STARTING the queued ones. Every scheduled call
    // still produces a result, so the assistant tool_use blocks pushed above
    // are never left without their paired tool message.
    signal
  });
  for (const toolResult of toolResults) {
    await appendToolResult({ session, round, toolResult });
  }
  await session.save();
  return toolResults;
}

export function hasToolCalls(response) {
  return Boolean(response.toolCalls?.length);
}

export function isToolRoundAllowed(round, maxToolRounds) {
  if (maxToolRounds == null || maxToolRounds === 0) return true;
  return round <= maxToolRounds;
}

export function createToolLoopExceededResponse(maxToolRounds) {
  return {
    error: { message: `Tool loop exceeded maxToolRounds (${maxToolRounds})`, code: "tool_loop_exceeded" }
  };
}

function emitUsageRecorded({ session, response, round }) {
  const usage = response?.usage;
  if (!usage) return;
  session.events.emit(createEvent("usage.recorded", {
    sessionId: session.sessionId,
    round,
    inputTokens: Number(usage.inputTokens ?? 0) || 0,
    outputTokens: Number(usage.outputTokens ?? 0) || 0,
    // Cache accounting (audit ④): persisted to events.jsonl so
    // scripts/measure-token-usage.mjs can report hit rates per session.
    ...(Number(usage.cacheReadTokens) > 0 ? { cacheReadTokens: Number(usage.cacheReadTokens) } : {}),
    ...(Number(usage.cacheWriteTokens) > 0 ? { cacheWriteTokens: Number(usage.cacheWriteTokens) } : {}),
    ...(typeof usage.costUsd === "number" ? { costUsd: usage.costUsd } : {})
  }));
}

async function appendToolResult({ session, round, toolResult }) {
  const toolMessage = buildToolMessage({ session, round, toolResult });
  session.messages.push(toolMessage);
}

/**
 * Build (and event-announce) the tool message for a settled tool call. Split
 * out of appendToolResult so the ADR 0037 approval resume path can REPLACE a
 * parked placeholder tool_result in place with the real execution result —
 * emitting the same tool.call.completed / attachment.produced events — instead
 * of appending a second tool message for the same toolCallId (which providers
 * reject). Exported for conversation.mjs.
 */
export function buildToolMessage({ session, round, toolResult }) {
  void round;
  const toolKind = toolNameToKind(toolResult.name);
  const okPayload = toolResult.ok ? toolResult.result : null;
  const failPayload = toolResult.ok ? null : {
    kind: toolKind,
    summary: `Error: ${toolResult.error}`,
    data: { error: toolResult.error, tool: toolResult.name }
  };
  const payload = okPayload ?? failPayload;

  session.events.emit(createEvent("tool.call.completed", {
    sessionId: session.sessionId,
    toolCallId: toolResult.id,
    ok: toolResult.ok,
    result: payload
  }));

  // A tool may surface images (e.g. view_image) via an `attachments` hint.
  // Persist them as lightweight `file_ref` blocks on the tool message — the
  // provider hydration layer inlines the bytes at request time. Keep the
  // stored tool_result payload free of the hint to avoid duplication.
  const attachments = Array.isArray(payload?.attachments) ? payload.attachments : [];
  // attach_file surfaces an OUTBOUND attachment via `outboundAttachments`: a
  // file the session pushed into the dashboard store (id-addressed). We persist
  // it as an `attachment_ref(direction:"outbound")` block (so resume/replay can
  // reconstruct it) and emit `attachment.produced` so live surfaces deliver it
  // (dashboard thumbnail/download now; bound Slack thread re-upload in Phase 3).
  // Outbound refs are excluded from re-hydration (image-hydration.mjs) — the
  // model produced them and need not re-see them.
  const outboundAttachments = Array.isArray(payload?.outboundAttachments) ? payload.outboundAttachments : [];
  let resultForBlock = payload;
  if ((attachments.length > 0 || outboundAttachments.length > 0) && payload && typeof payload === "object") {
    const { attachments: _omitA, outboundAttachments: _omitB, ...rest } = payload;
    resultForBlock = rest;
  }
  const imageRefBlocks = attachments
    .filter((a) => a && typeof a.path === "string")
    .map((a) => ({ kind: "file_ref", path: a.path, ...(a.mime ? { mime: a.mime } : {}) }));
  const outboundRefBlocks = outboundAttachments
    .filter((a) => a && typeof a.id === "string" && a.id.length > 0)
    .map((a) => ({
      kind: "attachment_ref",
      id: a.id,
      direction: "outbound",
      ...(a.mime ? { mime: a.mime } : {}),
      ...(typeof a.name === "string" && a.name ? { name: a.name } : {})
    }));

  for (const a of outboundRefBlocks) {
    session.events.emit(createEvent("attachment.produced", {
      sessionId: session.sessionId,
      toolCallId: toolResult.id,
      id: a.id,
      direction: "outbound",
      ...(a.mime ? { mime: a.mime } : {}),
      ...(a.name ? { name: a.name } : {}),
      ...(Number.isFinite(payload?.data?.bytes) ? { bytes: payload.data.bytes } : {})
    }));
  }

  return createMessage({
    role: "tool",
    sessionId: session.sessionId,
    toolCallId: toolResult.id,
    content: [
      {
        kind: "tool_result",
        toolCallId: toolResult.id,
        ok: toolResult.ok,
        result: resultForBlock
      },
      ...imageRefBlocks,
      ...outboundRefBlocks
    ]
  });
}

function extractReasoningContentFromResponse(response) {
  if (!response || typeof response !== "object") return null;
  // The provider layer surfaces it as response.reasoningContent; fall back
  // to the raw OpenAI-shaped message.reasoning_content / reasoning fields.
  if (typeof response.reasoningContent === "string" && response.reasoningContent.length > 0) {
    return response.reasoningContent;
  }
  const message = response.message;
  if (message && typeof message === "object") {
    if (typeof message.reasoning_content === "string" && message.reasoning_content.length > 0) {
      return message.reasoning_content;
    }
    if (typeof message.reasoning === "string" && message.reasoning.length > 0) {
      return message.reasoning;
    }
  }
  return null;
}

function extractReasoningSignatureFromResponse(response) {
  // Anthropic extended-thinking blocks carry a cryptographic signature that
  // must be echoed back verbatim when the same assistant turn (with tool_use)
  // is sent on the follow-up request. Other providers leave this unset.
  if (response && typeof response === "object" && typeof response.reasoningSignature === "string" && response.reasoningSignature.length > 0) {
    return response.reasoningSignature;
  }
  return null;
}

function buildReasoningMeta(response) {
  const reasoningContent = extractReasoningContentFromResponse(response);
  const reasoningSignature = extractReasoningSignatureFromResponse(response);
  if (!reasoningContent && !reasoningSignature) return null;
  return {
    ...(reasoningContent ? { reasoningContent } : {}),
    ...(reasoningSignature ? { reasoningSignature } : {})
  };
}

function extractAssistantTextFromResponse(response) {
  const message = response?.message;
  if (message) {
    if (typeof message.content === "string" && message.content.length > 0) return message.content;
    if (Array.isArray(message.content)) {
      const text = message.content
        .filter((block) => block?.kind === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("");
      if (text) return text;
    }
  }
  return "";
}

function toolNameToKind(name) {
  if (typeof name === "string" && name.startsWith("mcp__")) return "mcp";
  if (KNOWN_TOOL_KINDS_BY_NAME.has(name)) return name;
  if (name === "Edit") return "edit";
  if (name === "Glob" || name === "Grep") return "search_files";
  return "run_shell";
}
