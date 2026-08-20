import {
  compactCommand,
  historyCommand,
  listSessions,
  transcriptFromMessages
} from "../../core/index.mjs";
import {
  makeReady,
  makeEvent,
  makeResponse,
  makeErrorMessage,
  parseClientMessage,
  validateListSessionsArgs,
  validateLoadSessionArgs,
  normalizeRunTurnAttachments,
  normalizeWakeItems
} from "./protocol.mjs";

/**
 * Bridge a WebSocket connection to an AgentSession. The bridge:
 *   1. forwards every event the session emits to the client as `{ kind: "event", event }`,
 *   2. interprets client commands (`runTurn`, `approve`, `compact`, `history`,
 *      `abort`, `listSessions`, `loadSession`) and replies with
 *      `{ kind: "response", id, ok, ... }`.
 *   3. tears down the subscription on `ws.close`, awaiting in-flight event-log
 *      flushes before resolving.
 *
 * One WebSocket connection owns exactly one AgentSession at a time. The
 * `loadSession` command rebinds the bridge to a different persisted session
 * with the rollback contract specified in ADR-126-02.
 *
 * @param {{
 *   session: any,
 *   ws: any,
 *   cwd?: string,
 *   settings?: object,
 *   sessionFactory?: (input: object) => Promise<any>,
 *   version?: string,
 *   logger?: ((msg: string) => void) | null
 * }} input
 * @returns {{ detach: () => Promise<void> }}
 */
export function attachBridge({
  session,
  ws,
  cwd = process.cwd(),
  settings = null,
  sessionFactory = null,
  version = "0.1.0-alpha.1",
  logger = null
}) {
  if (!session) throw new TypeError("attachBridge: session is required");
  if (!ws || typeof ws.send !== "function") throw new TypeError("attachBridge: ws is required");

  const state = { session };

  const eventForwarder = (event) => {
    try {
      ws.send(JSON.stringify(makeEvent(event)));
    } catch (error) {
      if (logger) logger(`bridge: forward failed ${error?.message ?? error}`);
    }
  };
  state.session.events.on("*", eventForwarder);

  const onMessage = (raw) => {
    handleMessage({ state, ws, raw, cwd, settings, sessionFactory, eventForwarder, logger }).catch((error) => {
      try {
        ws.send(JSON.stringify(makeErrorMessage({ error: error?.message ?? String(error), fatal: false })));
      } catch {
        // socket may have closed before we could report
      }
    });
  };
  ws.on("message", onMessage);

  let detached = false;
  const detach = async () => {
    if (detached) return;
    detached = true;
    try {
      state.session.events.off("*", eventForwarder);
    } catch {
      // ignore
    }
    if (typeof state.session.flushEventLog === "function") {
      try {
        await state.session.flushEventLog();
      } catch {
        // best-effort
      }
    }
  };
  ws.on("close", () => {
    detach();
  });

  try {
    ws.send(JSON.stringify(makeReady({ sessionId: state.session.sessionId, version })));
  } catch {
    // socket may have closed during construction
  }

  // The real session.created / session.resumed event fires inside
  // sessionFactory, before this bridge attaches its event forwarder, so
  // those events never reach the client. When the attached session has
  // any user-visible messages, replay them as a synthetic session.resumed
  // so the UI can render the transcript without an extra round-trip.
  //
  // We must check the *visible* transcript length, not raw messages —
  // even a brand-new session has a system message inserted by
  // AgentSession.initialize, but the projection filters those out. If we
  // broadcast `messages: []` here, the client would replace its in-flight
  // user message (already pushed locally during send()) with the empty
  // array, making the user's first input vanish.
  const initialMessages = Array.isArray(state.session.messages) ? state.session.messages : [];
  if (initialMessages.length > 0) {
    try {
      const transcript = transcriptFromMessages(initialMessages, { maxMessages: Infinity });
      if (transcript.length > 0) {
        ws.send(JSON.stringify(makeEvent({
          type: "session.resumed",
          sessionId: state.session.sessionId,
          messages: transcript,
          messageCount: initialMessages.length,
          eventCount: Number.isFinite(state.session.eventCount) ? state.session.eventCount : 0,
          // Page reload / WS reconnect onto a session whose runTurn is still
          // executing — the UI should re-render the in-progress state (Stop
          // button) so the user can cancel a runaway turn.
          runningTurn: state.session.runningTurn === true
        })));
      }
    } catch (error) {
      if (logger) logger(`bridge: initial session.resumed replay failed ${error?.message ?? error}`);
    }
  }
  // Same timing gap as the transcript above: AgentSession.initialize
  // re-announces the persisted todo list via todos.updated, but that fires
  // before this bridge attaches its forwarder. Replay it here or a page
  // reload leaves the TODO panel empty even though the snapshot has the list.
  replayTodos({ session: state.session, ws, logger });
  // ADR 0037 D5: a page reload / WS reconnect wipes the client's approval cards
  // and UIR widgets (session.resumed above resets them), but the worker may
  // still be blocked on one right now. Replay the live coordinators' pending
  // requests so the client rebuilds them — same timing gap as the transcript.
  replayPendingRequests({ session: state.session, ws, logger });

  return { detach };
}

/**
 * ADR 0037 D5: replay the session's still-pending approval requests to a
 * (re)attached client — a reconnect wipes the client's approval cards, and
 * without a replay a still-blocked worker would be unanswerable. Re-emitting
 * the ORIGINAL event shape (`approval.requested`) lets the client's existing
 * handler rebuild the cards (it dedupes by requestId, so racing a live event
 * is harmless). Best-effort per request.
 *
 * UIR widgets are NOT replayed here any more: ADR 0037 D1 made every UIR
 * record-and-return, so the durable pending_interactions row is the source of
 * truth and the client re-hydrates from it (restorePendingInteractions) on
 * session.resumed — there is no in-memory pending to replay.
 */
function replayPendingRequests({ session, ws, logger }) {
  try {
    // ADR 0037 D1: parked approvals (the checkpointed, snapshot-persisted
    // form — survives Pod restarts) plus any legacy in-memory coordinator
    // pendings (non-turn blocking round-trips). Disjoint sets by construction.
    const parked = typeof session?.listParkedApprovals === "function"
      ? session.listParkedApprovals()
      : [];
    const blocking = typeof session?.approvalCoordinator?.listPending === "function"
      ? session.approvalCoordinator.listPending()
      : [];
    for (const a of [...parked, ...blocking]) {
      ws.send(JSON.stringify(makeEvent({
        type: "approval.requested",
        sessionId: a.sessionId ?? session.sessionId,
        requestId: a.requestId,
        kind: a.kind,
        summary: a.summary,
        payload: a.payload ?? undefined
      })));
    }
  } catch (error) {
    if (logger) logger(`bridge: approval.requested replay failed ${error?.message ?? error}`);
  }
}

function replayTodos({ session, ws, logger }) {
  const todos = typeof session?.todoStore?.list === "function" ? session.todoStore.list() : [];
  if (!Array.isArray(todos) || todos.length === 0) return;
  try {
    ws.send(JSON.stringify(makeEvent({
      type: "todos.updated",
      sessionId: session.sessionId,
      todos: todos.map((todo) => ({ ...todo }))
    })));
  } catch (error) {
    if (logger) logger(`bridge: todos.updated replay failed ${error?.message ?? error}`);
  }
}

async function handleMessage({ state, ws, raw, cwd, settings, sessionFactory, eventForwarder, logger }) {
  const message = parseClientMessage(raw);
  if (!message) {
    ws.send(JSON.stringify(makeErrorMessage({ error: "invalid message", fatal: false })));
    return;
  }
  const id = typeof message.id === "string" ? message.id : null;
  const args = (message.args && typeof message.args === "object") ? message.args : {};
  try {
    switch (message.command) {
      case "runTurn": {
        const prompt = typeof args.prompt === "string" ? args.prompt : "";
        if (prompt.length === 0) throw new Error("runTurn: prompt is required");
        // Reject overlapping turns up front with a structured response the
        // client (dispatchTurn's onResponse) can handle, instead of letting the
        // concurrency throw from conversation.mjs runTurn fall through to the
        // generic error frame. Concurrent turns on the one shared session
        // interleave their deltas on the EventBus and the client renders the
        // garbled/tripled text — see conversation.mjs runTurn for the full why.
        if (state.session.runningTurn === true) {
          ws.send(JSON.stringify(makeResponse({
            id,
            ok: false,
            error: { code: "turn_in_progress", message: "A turn is already in progress for this session." }
          })));
          return;
        }
        const options = (args.options && typeof args.options === "object") ? { ...args.options } : {};
        // Programmatic worker sessions (run-loop runner) have no approval-UI
        // receiver — the ChatPanel is only wired to connected user sessions and
        // Slack/Discord only to their own origin. If such a turn hit an approval
        // gate it would block on the approval bus until the worker's timeout and
        // fail the run. So default worker-origin turns to full-auto (restores the
        // old runner template's `--approval-mode full-auto`). Dangerous ops are
        // still guarded by permissions.deny, which wins regardless of mode
        // (ApprovalCoordinator evaluates deny first). An explicit options.approvalMode
        // from the caller always wins over this default.
        if (state.session?.origin === "worker" && options.approvalMode == null) {
          options.approvalMode = "full-auto";
        }
        // Attachments may arrive at the top level (preferred) or nested in
        // options; normalize + validate either way before handing to runTurn.
        const attachments = normalizeRunTurnAttachments(args.attachments ?? options.attachments);
        if (attachments.length > 0) options.attachments = attachments;
        await state.session.runTurn(prompt, options);
        ws.send(JSON.stringify(makeResponse({ id, ok: true, result: { ok: true } })));
        return;
      }
      case "wake": {
        // event-wake (issue #143): the host observed a run job of THIS
        // conversation reaching a terminal/awaiting status and pushes it in.
        //
        // Deliberately NOT routed through runTurn: runTurn refuses while a turn
        // is in flight (`turn_in_progress` above) and the refusal is non-fatal,
        // so the settle would be dropped on the floor and the caller would
        // still believe it was delivered. A wake is always accepted — the
        // supervisor holds it until the current turn ends, coalesces settles
        // that arrive together, and drops duplicates via its tombstones. The
        // ack means "queued", never "the model has read it": the wake turn is
        // injected later, detached, after the debounce.
        let items;
        try {
          items = normalizeWakeItems(args);
        } catch (error) {
          ws.send(JSON.stringify(makeResponse({ id, ok: false, error: { code: "invalid_args", message: error?.message ?? String(error) } })));
          return;
        }
        const supervisor = state.session?.wakeSupervisor;
        if (!supervisor || typeof supervisor.pushExternal !== "function") {
          ws.send(JSON.stringify(makeResponse({
            id,
            ok: false,
            error: { code: "wake_unavailable", message: "This session has no wake supervisor." }
          })));
          return;
        }
        let accepted = 0;
        let deduped = 0;
        for (const item of items) {
          // null = the supervisor refused it (tombstoned: already collected by
          // a tool call, or already delivered by an earlier wake).
          if (supervisor.pushExternal(item)) accepted += 1;
          else deduped += 1;
        }
        // The ONLY in-Pod evidence that a wake arrived. Without it a delivery
        // could be confirmed solely from the dashboard side (`woken_at`) plus
        // the turn that eventually appeared, which is exactly how the first
        // real-environment check had to be done. One line per wake — a settle
        // pushes once, and its retries are the interesting case anyway.
        if (logger) {
          const jobIds = items.map((item) => item?.jobId).filter(Boolean);
          const which = jobIds.length === 0
            ? ""
            : ` ${jobIds[0]}${jobIds.length > 1 ? ` +${jobIds.length - 1} more` : ""}`;
          logger(`bridge: wake received jobs=${items.length}${which} accepted=${accepted} deduped=${deduped}`);
        }
        ws.send(JSON.stringify(makeResponse({ id, ok: true, result: { queued: accepted > 0, accepted, deduped } })));
        return;
      }
      case "approve": {
        const requestId = typeof args.requestId === "string" ? args.requestId : null;
        const decision = typeof args.decision === "string" ? args.decision : null;
        if (!requestId || !decision) throw new Error("approve: requestId and decision are required");
        const accepted = state.session.approve(requestId, decision);
        ws.send(JSON.stringify(makeResponse({ id, ok: true, result: { accepted: accepted !== false } })));
        return;
      }
      case "interaction.resolve": {
        const requestId = typeof args.requestId === "string" ? args.requestId : null;
        // Response is arbitrary JSON the surface collected — keep it structured
        // (never String() it). undefined means the surface sent nothing.
        const response = args.response;
        if (!requestId || response === undefined) throw new Error("interaction.resolve: requestId and response are required");
        const accepted = state.session.resolveInteraction(requestId, response);
        ws.send(JSON.stringify(makeResponse({ id, ok: true, result: { accepted: accepted !== false } })));
        return;
      }
      case "compact": {
        const result = await compactCommand({ session: state.session, args: args ?? {} });
        ws.send(JSON.stringify(makeResponse({ id, ok: true, result })));
        return;
      }
      case "history": {
        const result = await historyCommand({ session: state.session });
        ws.send(JSON.stringify(makeResponse({ id, ok: true, result })));
        return;
      }
      case "abort": {
        const aborted = typeof state.session.abort === "function" ? state.session.abort() : false;
        ws.send(JSON.stringify(makeResponse({ id, ok: true, result: { aborted } })));
        return;
      }
      case "listSessions": {
        try {
          validateListSessionsArgs(args);
        } catch (error) {
          ws.send(JSON.stringify(makeResponse({ id, ok: false, error: { code: "invalid_args", message: error?.message ?? String(error) } })));
          return;
        }
        try {
          const result = await listSessions({
            cwd,
            limit: args.limit,
            cursor: args.cursor ?? null
          });
          ws.send(JSON.stringify(makeResponse({ id, ok: true, result })));
        } catch (error) {
          if (logger) logger(`bridge: listSessions failed: ${error?.message ?? error}`);
          ws.send(JSON.stringify(makeResponse({ id, ok: false, error: { code: "internal_error", message: error?.message ?? String(error) } })));
        }
        return;
      }
      case "loadSession": {
        try {
          validateLoadSessionArgs(args);
        } catch (error) {
          ws.send(JSON.stringify(makeResponse({ id, ok: false, error: { code: "invalid_args", message: error?.message ?? String(error) } })));
          return;
        }
        if (args.sessionId === state.session.sessionId) {
          ws.send(JSON.stringify(makeResponse({
            id,
            ok: true,
            result: {
              sessionId: state.session.sessionId,
              messageCount: Array.isArray(state.session.messages) ? state.session.messages.length : 0,
              eventCount: Number.isFinite(state.session.eventCount) ? state.session.eventCount : 0
            }
          })));
          return;
        }
        if (typeof sessionFactory !== "function") {
          ws.send(JSON.stringify(makeResponse({ id, ok: false, error: { code: "internal_error", message: "loadSession: sessionFactory is not configured" } })));
          return;
        }
        let next;
        try {
          next = await sessionFactory({ settings, cwd, sessionId: args.sessionId });
        } catch (error) {
          const errMessage = error?.message ?? String(error);
          const code = errMessage.startsWith("No session found") ? "session_not_found" : "initialize_failed";
          if (logger) logger(`bridge: loadSession ${code}: ${errMessage}`);
          ws.send(JSON.stringify(makeResponse({ id, ok: false, error: { code, message: errMessage } })));
          return;
        }
        try {
          state.session.events.off("*", eventForwarder);
        } catch {
          // ignore
        }
        if (typeof state.session.flushEventLog === "function") {
          try {
            await state.session.flushEventLog();
          } catch {
            // best-effort
          }
        }
        state.session = next;
        const messages = Array.isArray(next.messages) ? next.messages : [];
        const eventCount = Number.isFinite(next.eventCount) ? next.eventCount : 0;
        const transcript = transcriptFromMessages(messages, { maxMessages: Infinity });
        try {
          ws.send(JSON.stringify(makeEvent({
            type: "session.resumed",
            sessionId: next.sessionId,
            messages: transcript,
            messageCount: messages.length,
            eventCount,
            runningTurn: next.runningTurn === true
          })));
        } catch (error) {
          if (logger) logger(`bridge: session.resumed broadcast failed ${error?.message ?? error}`);
        }
        // session.resumed wipes the client's todo panel — re-announce the
        // loaded session's persisted list right behind it (see attach-time
        // replay above for the full why).
        replayTodos({ session: next, ws, logger });
        // …and replay the loaded session's still-pending approval / UIR requests
        // (ADR 0037 D5) so a switch-to-another-session keeps its blocked widgets.
        replayPendingRequests({ session: next, ws, logger });
        next.events.on("*", eventForwarder);
        ws.send(JSON.stringify(makeResponse({
          id,
          ok: true,
          result: {
            sessionId: next.sessionId,
            messageCount: messages.length,
            eventCount
          }
        })));
        return;
      }
      default:
        throw new Error(`unknown command: ${message.command}`);
    }
  } catch (error) {
    if (logger) logger(`bridge: command ${message.command} failed: ${error?.message ?? error}`);
    ws.send(JSON.stringify(makeResponse({ id, ok: false, error: error?.message ?? String(error) })));
  }
}
