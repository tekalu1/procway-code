import { resolveContext } from "../context/context-resolver.mjs";
import { buildSystemMessage, refreshSystemMessageSkills, refreshSystemMessageRules } from "./prompt-builder.mjs";
import { executeToolCall, getToolDefinitions, isMutationTool, DEFERRED_TOOL_NAMES } from "../tools/registry.mjs";
import { createSessionId, saveSessionState } from "../session/store.mjs";
import { EventLog, readEventLog } from "../session/event-log.mjs";
import { writeArchivedSnapshot, readSnapshot, SnapshotThrottle } from "../session/snapshot.mjs";
import { migrateLegacyFormatIfNeeded } from "../session/migration.mjs";
import { createChildAgentManager } from "./child-agent.mjs";
import {
  requiresFileMutation,
  requiresTaskCompletion,
  extractProcwayMeta,
  shouldRemindTaskCompletion,
  buildTaskCompletionRetryPrompt
} from "./intent.mjs";
import { McpToolRegistry } from "../mcp/registry.mjs";
import { ApprovalCoordinator, requestApproval } from "../safety/approval.mjs";
import { InteractionCoordinator } from "../runtime/interaction.mjs";
import { compactMessages, getCompactConfig, getCompactStatus, resolveTailStart, shouldAutoCompact } from "../session/compactor.mjs";
import { combinePatterns } from "../session/redaction.mjs";
import { getEncryptionKey } from "../session/encryption.mjs";
import {
  createToolLoopExceededResponse,
  describeTurnAbort,
  executeModelRound,
  executeToolsRound,
  handleModelResponseWithoutTools,
  hasToolCalls,
  isToolRoundAllowed
} from "./turn-orchestrator.mjs";
import { EventBus } from "../core/events/bus.mjs";
import { createEvent } from "../core/events/types.mjs";
import { createMessage, messageContentToText } from "../core/types/message.mjs";
import { messagesFromEvents } from "../core/projections/messages.mjs";
import { stripSystemReminders } from "../core/projections/transcript.mjs";
import { isToolResult } from "../core/types/tool-result.mjs";
import { createUsageTracker } from "../usage-tracker.mjs";
import { PlanMode, buildDeferredToolResult } from "./plan-mode.mjs";
import { TodoStore } from "../todos/store.mjs";
import { resolveActiveModel } from "../config/active-model.mjs";
import { loadMemoryIndex } from "../memory/store.mjs";
import { HookRunner } from "../hooks/runner.mjs";
import { compactMessagesLlm } from "../compactor/llm-summary.mjs";
import { runProvider } from "../providers/index.mjs";

/**
 * AgentSession — runs a single agent conversation session.
 *
 * Phase 4: events.jsonl is the source of truth. Approval requests now flow
 * through `ApprovalCoordinator` (no stdin in core), `flushEventLog()`
 * drains the append queue before snapshots, and `initialize()` replays
 * trailing events.jsonl entries on resume.
 */
export class AgentSession {
  constructor({
    settings,
    cwd = process.cwd(),
    sessionId = createSessionId(),
    messages = [],
    title = null,
    depth = 0,
    mcpRegistry = null,
    approvalRequester = null,
    approvalCoordinator = null,
    events = new EventBus(),
    // A+B: persisted task-completion enforcement state. Set once from the
    // first worker prompt and survives ChatPanel takeover / dashboard restart.
    procwayMeta = null,
    // Session-origin tag (`null` = user-created, "worker" = programmatic
    // serve-client run). Set once at creation, persisted in meta/index, and
    // used by listSessions to keep worker sessions out of the /ai sidebar.
    origin = null,
    // Whether a UIR (request_user_action) surface can actually answer this
    // session. true only for serve-hosted sessions (chat / Slack); false for
    // one-shot `procway-code -p` run-loop workers and the TUI, which have no
    // interaction surface. When false, request_user_action returns a `skipped`
    // result immediately instead of stalling on the 15-min coordinator fallback
    // (the worker then falls back to prose elicitation per the task SKILLs).
    interactive = false,
    // Run-loop hearing return mode (§6 rework). When true, a `request_user_action`
    // does NOT block the turn on the InteractionCoordinator: it records the
    // request (emits interaction.requested so the dashboard persists it into
    // pending_interactions), then resolves the tool IMMEDIATELY and asks the
    // model to end its turn. Control returns to the run loop, which returns
    // `awaiting-user-input` with the interaction details; the user answers via a
    // widget, the answer is saved, and `run loop resume` re-opens THIS session
    // (resume from the saved transcript) with the answer injected as a message.
    // This replaces the Phase 5 "block + live cross-session resolve" path for
    // run-loop workers. AI CHAT sessions (a human is co-present) keep the
    // blocking behaviour — only run-loop-spawned worker sessions set this.
    hearingReturnMode = false,
    pendingTaskCompletionReminder = false
  }) {
    this.settings = settings;
    this.cwd = cwd;
    this.sessionId = sessionId;
    this.messages = normalizeIncomingMessages(messages, sessionId);
    this.title = title;
    this.depth = depth;
    // Full catalog. Settings-dependent filtering (view_image / ask_image —
    // which depend on the provider's vision config) happens PER TURN in
    // executeModelRound, because settings hot-reload (config/hot-reload.mjs)
    // mutates `this.settings` in place mid-session: a list frozen here would
    // keep offering view_image after the main provider turned text-only.
    // Settings also feed the display-tool availability probe (ADR 0030 D5):
    // settings.tools.browser overrides count toward web_browser availability.
    this.tools = getToolDefinitions({ settings });
    // Deferred-tool tier (token reduction): names the session has loaded via
    // `load_tools` OR by calling a deferred tool directly. Append-only, in
    // load order — executeModelRound appends these schemas after the stable
    // core list, so the tools-array prefix stays byte-identical across
    // rounds (prompt-cache friendly). Persisted in the snapshot.
    this.loadedTools = [];
    this.events = events;
    this.eventLog = null;
    this.eventCount = 0;
    this.eventLogSubscriber = null;
    this.appendQueue = [];
    this.encryptionKey = null;
    this.redactionPatterns = combinePatterns(settings?.session?.redaction?.patterns ?? []);
    this.snapshotThrottle = new SnapshotThrottle({
      intervalEvents: settings?.session?.snapshot?.intervalEvents,
      intervalMs: settings?.session?.snapshot?.intervalMs
    });
    this.childAgentManager = createChildAgentManager({
      settings,
      cwd,
      runAgentImpl: runAgentFromSession
    });
    this.mcpRegistry = mcpRegistry;
    this.mcpStarted = false;
    this.approvalCoordinator = approvalCoordinator
      ?? new ApprovalCoordinator({ events, settings, defaultMode: settings?.approvalMode ?? "auto-readonly" });
    this.approvalRequester = approvalRequester ?? createSessionApprovalRequester({
      coordinator: this.approvalCoordinator,
      settings: this.settings,
      sessionId: this.sessionId
    });
    // UIR (User Interaction Request) coordinator — generic, non-gated round-trip
    // for request_user_action. Separate from approvals (which keep their 3-value
    // gate semantics). Shares the same EventBus.
    this.interactionCoordinator = new InteractionCoordinator({ events });
    this.interactive = interactive === true;
    // §6: run-loop hearing return mode. See constructor doc above. Sticky for
    // the session's life so a resumed worker (run loop resume) keeps it.
    this.hearingReturnMode = hearingReturnMode === true;
    // Set by the request_user_action requester when a UIR was deferred (recorded
    // + turn asked to end) in return mode. runServeWorker reads it off the
    // session via the forwarded interaction.requested event; this field is the
    // in-process mirror so the same-process callers (tests, TUI) can observe it.
    this.pausedForInput = null;
    this.initialized = false;
    this.interruptRequested = false;
    // A+B: procway worker enforcement. `procwayMeta` is set once when the
    // first runTurn prompt carries a `role: "worker"` Meta block; subsequent
    // ChatPanel turns inherit it. `pendingTaskCompletionReminder` is raised
    // whenever a turn ends (success / failure / interrupt / loop-exceeded)
    // without a successful `task complete` tool result, and consumed at the
    // start of the next runTurn to prepend a synthetic reminder.
    this.procwayMeta = procwayMeta && typeof procwayMeta === "object" ? procwayMeta : null;
    this.origin = typeof origin === "string" && origin.length > 0 ? origin : null;
    // Session-context tag (project/ticket) — a filter-only dimension persisted
    // alongside meta (Phase 0). Set once from the first runTurn that carries a
    // `sessionContext` option (dashboard AI sidepanel, AI画面 side variant);
    // sticky thereafter so later turns don't strip it. Stays null for plain
    // chats with no project/ticket context. Has NO behavioural side-effects.
    this.sessionContext = null;
    this.pendingTaskCompletionReminder = Boolean(pendingTaskCompletionReminder);
    // True while runTurn is executing. Surfaced through session.resumed so a
    // page reload / history-load can re-render the in-progress UI (Stop button)
    // for a turn that's still going inside this session.
    this.runningTurn = false;
    // Per-turn tool policy supplied via runTurn options (currently only
    // "read-only"). When set, executeModelRound narrows the tool list it
    // offers the model and #executeUnhookedToolCall skips any mutation tool
    // as defense-in-depth. Reset to null in runTurn's finally.
    this.activeToolPolicy = null;
    // A caller-supplied system-prompt addendum (e.g. the setup wizard's
    // persona) is folded into the session's system message exactly once.
    this.systemPromptAppendApplied = false;
    // Aborts the in-flight provider call (HTTP stream / cli-agent spawn).
    // Recreated each turn so a fresh runTurn isn't pre-aborted by a previous
    // interrupt. abort() flips both interruptRequested (between-round signal
    // checked by the orchestrator) and this controller (mid-call kill switch).
    this.turnAbortController = null;
    this.planMode = new PlanMode({
      session: this,
      active: settings?.plan?.enabled === true || settings?.planMode === true
    });
    this.todoStore = new TodoStore({ session: this });
    this.memorySnapshot = null;
    this.hooksRunner = new HookRunner({ session: this, hooks: settings?.hooks });
    createUsageTracker({ session: this });
  }

  async initialize() {
    if (this.initialized) return this;
    if (this.settings.session?.enabled !== false) {
      await migrateLegacyFormatIfNeeded();
      this.encryptionKey = await getEncryptionKey({ settings: this.settings });
      this.eventLog = new EventLog({
        sessionId: this.sessionId,
        redactionPatterns: this.redactionPatterns,
        encryptionKey: this.encryptionKey
      });
      this.#wireEventLogSubscriber();
    }
    await this.startMcpTools();
    // Even when the bridge pre-loaded `messages` from the snapshot, we still
    // need to walk events.jsonl past `snapshot.eventCount` so a mid-turn
    // crash (snapshot only saw the system message, but the prompt + partial
    // assistant output landed in the event log) recovers the visible
    // transcript. The previous behavior — skipping #restoreFromPersistence
    // entirely when any messages were pre-loaded — left the chat panel
    // blank for any session that died before its first save tick.
    if (this.settings.session?.enabled !== false) {
      const restored = await this.#restoreFromPersistence({ preserveLoadedMessages: this.messages.length > 0 });
      if (restored) {
        this.events.emit(createEvent("session.resumed", {
          sessionId: this.sessionId,
          from: { eventCount: this.eventCount, snapshotId: restored.snapshotId ?? undefined }
        }));
        // The UI clears transient state (todos, plan, usage) on session.resumed,
        // so we must re-announce restored state afterward.
        if (this.todoStore.todos.length > 0) {
          this.events.emit(createEvent("todos.updated", {
            sessionId: this.sessionId,
            todos: this.todoStore.todos.map((t) => ({ ...t }))
          }));
        }
        if (this.planMode.queue.length > 0) {
          for (const entry of this.planMode.queue) {
            this.events.emit(createEvent("plan.queued", {
              sessionId: this.sessionId,
              entryId: entry.entryId,
              kind: entry.name,
              summary: entry.summary
            }));
          }
        }
        await this.#refreshSkillsSection();
        this.initialized = true;
        return this;
      }
    }
    if (this.messages.length === 0) {
      const context = await resolveContext({ cwd: this.cwd, settings: this.settings });
      this.memorySnapshot = await loadAndAnnounceMemory(this);
      this.messages.push(await buildSystemMessage({
        cwd: this.cwd,
        context,
        sessionId: this.sessionId,
        memorySnapshot: this.memorySnapshot
      }));
      this.events.emit(createEvent("session.created", {
        sessionId: this.sessionId,
        cwd: this.cwd,
        provider: this.settings.defaultProvider,
        model: resolveActiveModel(this.settings),
        compatibilityMode: context.compatibilityMode
      }));
      await this.save();
    } else {
      await this.#refreshSkillsSection();
      this.events.emit(createEvent("session.resumed", {
        sessionId: this.sessionId,
        from: { eventCount: this.eventCount }
      }));
    }
    this.initialized = true;
    return this;
  }

  /**
   * Re-scan workspace skills AND re-resolve the dashboard-delivered all-sessions
   * Rules on session resume, swapping the "## Available Skills" and "## Rules"
   * sections inside the restored system message so both reflect the current
   * config (the original sections are frozen at session-creation time).
   * Best-effort: a failed rescan never blocks resume. NOTE: a "## Rules" section
   * that was absent at creation (no rules then) cannot be re-introduced on resume
   * — refreshSystemMessageRules only swaps an existing section; the next fresh
   * spawn renders it. This mirrors the skills section behavior.
   */
  async #refreshSkillsSection() {
    try {
      const systemMessage = this.messages.find((message) => message?.role === "system");
      if (!systemMessage) return;
      const context = await resolveContext({ cwd: this.cwd, settings: this.settings });
      refreshSystemMessageSkills(systemMessage, context.skills);
      refreshSystemMessageRules(systemMessage, context.rules);
    } catch {
      // Skills/rules freshness is an enhancement; resume must not fail because of it.
    }
  }

  /**
   * Phase 4 (E-2): replay snapshot + trailing events.jsonl into messages.
   * Returns null if no snapshot was found, or `{ snapshotId }` on success.
   *
   * When the caller already pre-loaded messages from disk (e.g. the serve
   * bridge's `defaultSessionFactory` passed `messages: state.messages`),
   * pass `preserveLoadedMessages: true` so we don't clobber them with the
   * snapshot's own list before replaying trailing events. Either way we
   * still walk events.jsonl past `snapshot.eventCount` so a mid-turn crash
   * recovers the user prompt + partial assistant output.
   */
  async #restoreFromPersistence({ preserveLoadedMessages = false } = {}) {
    const snapshot = await readSnapshot({ sessionId: this.sessionId, encryptionKey: this.encryptionKey });
    if (!snapshot) return null;
    if (!preserveLoadedMessages) {
      this.messages = Array.isArray(snapshot.messages) ? snapshot.messages.slice() : [];
    }
    const allEvents = await readEventLog({ sessionId: this.sessionId, encryptionKey: this.encryptionKey });
    this.eventCount = allEvents.length;
    const snapshotEventCount = Number.isFinite(snapshot.eventCount) ? Number(snapshot.eventCount) : 0;
    if (allEvents.length > snapshotEventCount) {
      const trailing = allEvents.slice(snapshotEventCount);
      const projected = messagesFromEvents(trailing);
      if (projected.length > 0) {
        this.messages.push(...projected);
      }
    }

    // Restore in-memory state from snapshot (no events emitted yet — the
    // caller in initialize() will re-announce after session.resumed).
    if (Array.isArray(snapshot.todos) && snapshot.todos.length > 0) {
      this.todoStore.todos = snapshot.todos.map((t) => ({ ...t }));
    }
    if (snapshot.planMode && typeof snapshot.planMode === "object") {
      this.planMode.active = snapshot.planMode.active === true;
      this.planMode.queue = Array.isArray(snapshot.planMode.queue)
        ? snapshot.planMode.queue.filter((e) => e && typeof e === "object").map((e) => ({ ...e }))
        : [];
    }
    if (Array.isArray(snapshot.alwaysAllow) && snapshot.alwaysAllow.length > 0) {
      for (const kind of snapshot.alwaysAllow) {
        if (typeof kind === "string") {
          this.approvalCoordinator.alwaysAllow.add(kind);
        }
      }
    }
    if (Array.isArray(snapshot.loadedTools)) {
      // Deferred-tool tier: restore so a resumed session keeps the schemas
      // it had already loaded (otherwise the model would silently lose
      // tools it used before the restart).
      this.loadedTools = snapshot.loadedTools.filter((name) => typeof name === "string");
    }
    if (Array.isArray(snapshot.usageEvents) && snapshot.usageEvents.length > 0) {
      // Re-create usage tracker with saved events so cumulative totals are correct
      if (typeof this.usageTracker?.dispose === "function") {
        this.usageTracker.dispose();
      }
      createUsageTracker({ session: this, initialEvents: snapshot.usageEvents });
    }

    return { snapshotId: snapshot.snapshotId ?? null };
  }

  #wireEventLogSubscriber() {
    if (this.eventLogSubscriber || !this.eventLog) return;
    const handler = (event) => {
      this.eventCount += 1;
      const promise = this.eventLog.append(event).catch(() => {});
      this.appendQueue.push(promise);
      promise.finally(() => {
        const idx = this.appendQueue.indexOf(promise);
        if (idx >= 0) this.appendQueue.splice(idx, 1);
      });
    };
    this.events.on("*", handler);
    this.eventLogSubscriber = handler;
  }

  /**
   * Phase 4 (E-4): drain pending event-log appends. Callers can `await` this
   * before reading the file directly to avoid races. `save()` calls it before
   * writing the snapshot.
   */
  async flushEventLog() {
    while (this.appendQueue.length > 0) {
      const pending = this.appendQueue.slice();
      await Promise.allSettled(pending);
    }
  }

  /**
   * Resolve a pending approval request. Adapters call this in response to
   * `approval.requested`. Decision is one of "allow" | "deny" | "always-allow".
   */
  resolveInteraction(requestId, response) {
    return this.interactionCoordinator.resolveInteraction(requestId, response, { sessionId: this.sessionId });
  }

  approve(requestId, decision) {
    return this.approvalCoordinator.resolve(requestId, decision, { sessionId: this.sessionId });
  }

  /**
   * Cancel the current turn. Fires both:
   *   - `interruptRequested = true` so the orchestrator stops between rounds
   *   - `turnAbortController.abort()` so any in-flight HTTP stream or
   *     cli-agent spawn that received the signal terminates immediately.
   * Returns true when an abort was registered.
   */
  abort() {
    if (this.interruptRequested) return false;
    this.interruptRequested = true;
    try {
      this.turnAbortController?.abort();
    } catch { /* ignore double-aborts */ }
    return true;
  }

  resetInterrupt() {
    this.interruptRequested = false;
    this.turnAbortController = null;
  }

  async startMcpTools() {
    if (!this.mcpRegistry) {
      this.mcpRegistry = new McpToolRegistry({ settings: this.settings, cwd: this.cwd });
    }
    if (!this.mcpStarted && typeof this.mcpRegistry.start === "function") {
      await this.mcpRegistry.start();
      this.mcpStarted = true;
    }
    const internalNames = new Set(getToolDefinitions({ settings: this.settings }).map((tool) => tool.function.name));
    const mcpDefs = this.mcpRegistry.getToolDefinitions();
    this.tools = [
      ...this.tools.filter((tool) => internalNames.has(tool.function.name)),
      ...mcpDefs
    ];
  }

  /**
   * Deferred-tool auto-load: any sighting of a deferred name — via
   * `load_tools` args or a direct call (the model knows the names from the
   * load_tools summary list even without the schema) — marks it loaded so
   * executeModelRound ships the full schema from the next round. Execution
   * itself never depends on this; dispatch accepts every known name.
   */
  #noteDeferredTools(toolCall) {
    const add = (name) => {
      if (DEFERRED_TOOL_NAMES.has(name) && !this.loadedTools.includes(name)) {
        this.loadedTools.push(name);
      }
    };
    if (toolCall?.name === "load_tools") {
      const names = Array.isArray(toolCall.args?.names) ? toolCall.args.names : [];
      for (const name of names) add(name);
    } else if (toolCall?.name) {
      add(toolCall.name);
    }
  }

  async executeSingleToolCall(toolCall, { onProgress = null } = {}) {
    this.#noteDeferredTools(toolCall);
    if (this.planMode?.shouldDefer(toolCall.name, toolCall.args)) {
      const summary = describeToolForPlan(toolCall);
      this.planMode.enqueue({
        name: toolCall.name,
        args: toolCall.args ?? {},
        summary,
        payload: { args: toolCall.args ?? {} }
      });
      return buildDeferredToolResult({ name: toolCall.name, args: toolCall.args, summary });
    }
    if (this.hooksRunner) {
      const preOutcome = await this.hooksRunner.runPreToolUse({ toolName: toolCall.name, args: toolCall.args ?? {} }).catch(() => ({ blocked: false }));
      if (preOutcome?.blocked) {
        return {
          kind: "run_shell",
          summary: `Blocked by hook (exit ${preOutcome.exitCode}): ${toolCall.name}`,
          data: { skipped: true, reason: "hook-blocked", phase: "preToolUse", exitCode: preOutcome.exitCode, tool: toolCall.name }
        };
      }
    }
    const result = await this.#executeUnhookedToolCall(toolCall, { onProgress });
    if (this.hooksRunner) {
      await this.hooksRunner.runPostToolUse({
        toolName: toolCall.name,
        args: toolCall.args ?? {},
        result,
        ok: !result?.data?.skipped
      }).catch(() => {});
    }
    return result;
  }

  async #executeUnhookedToolCall(toolCall, { onProgress = null } = {}) {
    // Read-only turns (e.g. the setup wizard's repo-analysis phase) must not
    // run mutation tools even if the model tries. executeModelRound already
    // hides them from the tool list; this is the enforcement backstop and
    // also covers MCP tools (which are treated as mutating).
    if (this.activeToolPolicy === "read-only" && isMutationTool(toolCall.name)) {
      return {
        kind: toolCall.name === "run_shell" ? "run_shell" : "write_file",
        summary: `Skipped (read-only turn): ${toolCall.name}`,
        data: { skipped: true, reason: "read-only-policy", tool: toolCall.name }
      };
    }
    if (this.mcpRegistry?.isMcpTool(toolCall.name)) {
      const allowed = await this.approvalRequester({
        kind: "mcp",
        summary: toolCall.name,
        mutation: true,
        approvalMode: this.settings?.approvalMode,
        permissions: this.settings?.permissions,
        payload: { tool: toolCall.name, args: toolCall.args }
      });
      if (!allowed) {
        return {
          kind: "mcp",
          summary: `Skipped MCP tool: ${toolCall.name}`,
          data: { skipped: true, error: "User denied approval", tool: toolCall.name }
        };
      }
      const raw = await this.mcpRegistry.callTool(toolCall.name, toolCall.args);
      const ok = !raw?.isError;
      return {
        kind: "mcp",
        summary: `${toolCall.name} ${ok ? "ok" : "failed"}`,
        data: { tool: toolCall.name, response: raw }
      };
    }
    const result = await executeToolCall({
      cwd: this.cwd,
      settings: this.settings,
      name: toolCall.name,
      args: toolCall.args,
      approvalRequester: this.approvalRequester,
      // Only wire the requester when a surface can answer (serve: chat/Slack).
      // For non-interactive sessions (`-p` run-loop worker, TUI) leave it null
      // so the registry returns a `skipped` result at once instead of blocking
      // the turn on a UIR that nobody will ever resolve.
      //
      // §6 return mode: a run-loop worker session DOES have a surface (the
      // ticket-scoped side panel) but it answers ASYNCHRONOUSLY — the worker
      // must NOT block. We record the request (non-blocking emit → the
      // dashboard persists it) and return a non-blocking marker so the registry
      // resolves the tool at once and instructs the model to end the turn.
      interactionRequester: this.interactive
        ? ({ kind, summary, spec, blocking }) => {
            if (this.hearingReturnMode) {
              // Force non-blocking: emit interaction.requested for the surface to
              // record, capture the requestId, mark the session paused so the
              // turn winds down. The model gets a result telling it to stop.
              const res = this.interactionCoordinator.request({
                kind, summary, spec, blocking: false, sessionId: this.sessionId
              });
              return Promise.resolve(res).then((r) => {
                const requestId = r && typeof r === "object" ? r.requestId : null;
                this.pausedForInput = {
                  requestId,
                  kind,
                  ...(summary ? { summary } : {}),
                  ...(spec && typeof spec === "object" ? { spec } : {})
                };
                return { requestId, blocking: false, deferred: true };
              });
            }
            return this.interactionCoordinator.request({ kind, summary, spec, blocking, sessionId: this.sessionId });
          }
        : null,
      childAgentRunner: (childArgs) => this.childAgentManager.run({ ...childArgs, depth: this.depth }),
      todoStore: this.todoStore,
      onProgress
    });
    if (!isToolResult(result)) {
      throw new TypeError(`executeSingleToolCall: tool "${toolCall.name}" did not return a ToolResult`);
    }
    return result;
  }

  async runTurn(prompt, {
    maxToolRounds = this.settings.tools?.maxToolRounds ?? 150,
    systemPromptAppend = null,
    toolPolicy = null,
    attachments = [],
    sessionContext = null
  } = {}) {
    // Reject re-entrant turns. A single AgentSession instance is shared across
    // every WS connection to the same conversation (serve liveSessions cache),
    // and a dropped socket does NOT abort an in-flight turn. Without this guard
    // a second runTurn — a reconnect-resend, a double-submit, or a worker+viewer
    // both driving the session — would run CONCURRENTLY on the one instance:
    // both turns stream and emit assistant.message.delta onto the one shared
    // EventBus, the bridge forwards both, and the client concatenates the
    // interleaved copies (msg.content += delta), surfacing as tripled/garbled
    // text ("修修修正正正…") and the same tool firing repeatedly. Fail fast —
    // BEFORE touching turnAbortController / runningTurn below — so the in-flight
    // turn's state is untouched and the caller (bridge → client) can surface
    // "turn already in progress".
    if (this.runningTurn) {
      const error = new Error("A turn is already in progress for this session.");
      error.code = "TURN_IN_PROGRESS";
      throw error;
    }
    if (!this.initialized) await this.initialize();
    // Per-turn knobs threaded from the serve bridge's runTurn args.options.
    // `toolPolicy: "read-only"` and a `systemPromptAppend` persona are how the
    // dashboard's project-setup wizard runs a dedicated, write-disabled
    // analysis session without changing the global agent settings.
    this.activeToolPolicy = toolPolicy === "read-only" ? "read-only" : null;
    if (typeof systemPromptAppend === "string" && systemPromptAppend.trim() && !this.systemPromptAppendApplied) {
      this.#applySystemPromptAppend(systemPromptAppend.trim());
    }
    // Sticky session-context tag (filter-only). Accept the first non-empty
    // {project?,ticket?} the caller threads through runTurn options and keep it
    // for the rest of the session so saveSessionState persists it (Phase 2).
    if (this.sessionContext == null && sessionContext && typeof sessionContext === "object") {
      const project = typeof sessionContext.project === "string" && sessionContext.project.trim()
        ? sessionContext.project.trim() : undefined;
      const ticket = typeof sessionContext.ticket === "string" && sessionContext.ticket.trim()
        ? sessionContext.ticket.trim() : undefined;
      if (project || ticket) {
        this.sessionContext = { ...(project ? { project } : {}), ...(ticket ? { ticket } : {}) };
      }
    }
    // Title from the VISIBLE prompt only — a leading <system-reminder> preamble
    // (task-completion retry / Phase-2 sidepanel hidden context) is runtime-only
    // and must not become the human-readable session title shown in the sidebar.
    if (!this.title) {
      const visible = stripSystemReminders(prompt).trim();
      this.title = (visible || prompt).slice(0, 80);
    }
    this.resetInterrupt();
    // Fresh per-turn controller. abort() flips this so providers that received
    // the signal can short-circuit their in-flight work mid-call.
    this.turnAbortController = new AbortController();
    this.runningTurn = true;
    this.turnIdleAborted = false;
    // Idle watchdog. A turn that emits NO agent event for a stretch is stalled:
    // e.g. an upstream that keeps the HTTP stream alive with keep-alive comments
    // (so llm-fetch's inter-chunk bodyTimeout never trips) yet never produces a
    // token, or a hung tool. Real progress — reasoning/message deltas, tool and
    // activity events — bumps `lastProgress`, so a healthy turn (even a long
    // agentic one with many tool rounds) never fires this; only a truly idle one
    // does. On fire we abort the turn so it surfaces as turn.failed (retryable)
    // instead of hanging "model waiting" forever. Tunable; 0 disables.
    // Default 180s (was 90s): a reasoning model's keepalive frames now bump this
    // (openai-codex forwards them as activity.tick heartbeats), so the old 90s
    // no longer false-fires on a healthy long-thinking turn. We also keep the
    // default >= llm-fetch's 120s body timeout so a genuine stream stall is
    // surfaced by the body timeout (clearer "stream died" semantics) before this
    // coarser watchdog — this stays the backstop for non-stream hangs (a wedged
    // tool emitting no events). Tunable via PROCWAY_TURN_IDLE_TIMEOUT_MS; 0 disables.
    const rawIdle = Number(process.env.PROCWAY_TURN_IDLE_TIMEOUT_MS);
    const idleMs = Number.isFinite(rawIdle) && rawIdle >= 0 ? rawIdle : 180_000;
    let lastProgress = Date.now();
    const bumpProgress = () => { lastProgress = Date.now(); };
    let idleTimer = null;
    if (idleMs > 0) {
      this.events.on("*", bumpProgress);
      idleTimer = setInterval(() => {
        // Pause the watchdog while a UIR / approval is awaiting a human: those
        // go silent (no events) by design until the user responds, which is not
        // a stall. Bumping keeps the turn alive; the coordinators carry their
        // own fallback timeout so a vanished surface can't hang forever.
        if (this.interactionCoordinator?.hasPending?.() || this.approvalCoordinator?.hasPending?.()) {
          lastProgress = Date.now();
          return;
        }
        if (Date.now() - lastProgress > idleMs) {
          // Abort WITH a typed reason so the catch path can render a clear
          // message ("model went silent") instead of the raw DOMException
          // "This operation was aborted", and can distinguish this from a user
          // Stop. signal.reason carries it through to the provider's fetch abort.
          this.turnIdleAborted = true;
          try { this.turnAbortController?.abort({ name: "IdleWatchdogAbort", idleMs }); }
          catch { /* ignore double-abort */ }
        }
      }, Math.max(1000, Math.floor(idleMs / 4)));
      if (typeof idleTimer.unref === "function") idleTimer.unref();
    }
    const clearIdleWatchdog = () => {
      if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
      try { this.events.off("*", bumpProgress); } catch { /* ignore */ }
    };
    const turnStartIndex = this.messages.length;
    const needsFileMutation = requiresFileMutation(prompt);
    // A: seed session-level procwayMeta from the first worker prompt that
    // arrives. Subsequent ChatPanel messages have no Meta block but still
    // inherit the enforcement because this.procwayMeta sticks.
    if (this.procwayMeta == null && requiresTaskCompletion(prompt)) {
      this.procwayMeta = extractProcwayMeta(prompt);
    }
    const requiresTaskComplete = this.procwayMeta != null;
    const procwayMeta = this.procwayMeta;
    // B: if the previous turn ended without `task complete`, prepend a
    // synthetic reminder so the model addresses it before whatever new
    // question came in. Re-confirm the condition (user may have run the CLI
    // manually between turns) so we don't spam the reminder after the fact.
    let effectivePrompt = prompt;
    if (this.pendingTaskCompletionReminder) {
      const stillNeedsReminder = shouldRemindTaskCompletion(this);
      if (stillNeedsReminder) {
        effectivePrompt = `<system-reminder>\nprocway runner: the previous turn ended without invoking \`task complete\`. ${buildTaskCompletionRetryPrompt(this.procwayMeta)}\n</system-reminder>\n\n${prompt}`;
      }
      this.pendingTaskCompletionReminder = false;
    }
    // Attachments (dashboard uploads, referenced by id) ride alongside the
    // prompt text. They stay lightweight here — the provider hydration layer
    // fetches + base64-inlines the bytes over HTTP only at request time (the
    // single attachment transport; sessions have no shared-volume path).
    const cleanAttachments = Array.isArray(attachments)
      ? attachments.filter((a) => a && typeof a.id === "string" && a.id.length > 0)
      : [];
    const attachmentBlocks = cleanAttachments.map(
      (a) => ({ kind: "attachment_ref", id: a.id, ...(a.mime ? { mime: a.mime } : {}), ...(typeof a.name === "string" && a.name ? { name: a.name } : {}) })
    );
    // Surface the attachment ids to the MODEL: hydration replaces the refs
    // with inline images (or nothing it can touch), so without this note the
    // model can SEE an attachment but has no handle to fetch the actual file
    // (save_attachment needs the id). One text block after the refs.
    const attachmentNoteBlocks = cleanAttachments.length > 0
      ? [{ kind: "text", text: buildAttachmentNote(cleanAttachments) }]
      : [];
    const userMessage = createMessage({
      role: "user",
      sessionId: this.sessionId,
      content: [{ kind: "text", text: effectivePrompt }, ...attachmentBlocks, ...attachmentNoteBlocks]
    });
    this.messages.push(userMessage);
    const turnUserMessageId = userMessage.id;
    if (this.hooksRunner) {
      const promptHookOutcome = await this.hooksRunner.runUserPromptSubmit({ messageId: turnUserMessageId, prompt }).catch(() => ({ blocked: false }));
      if (promptHookOutcome?.blocked) {
        this.messages.pop();
        this.events.emit(createEvent("turn.failed", {
          sessionId: this.sessionId,
          round: 0,
          messageId: turnUserMessageId,
          error: { message: `User prompt blocked by hook (exit ${promptHookOutcome.exitCode})`, code: "hook_blocked" }
        }));
        return { error: { message: "User prompt blocked by hook", code: "hook_blocked" } };
      }
    }
    this.events.emit(createEvent("user.prompt.submitted", {
      sessionId: this.sessionId,
      messageId: turnUserMessageId,
      content: userMessage.content
    }));
    await this.save();

    let lastRound = 0;
    try {
      for (let round = 0; isToolRoundAllowed(round, maxToolRounds); round += 1) {
        lastRound = round;
        if (this.interruptRequested) {
          this.events.emit(createEvent("turn.failed", {
            sessionId: this.sessionId,
            round,
            messageId: turnUserMessageId,
            error: { message: "Turn interrupted by user", code: "interrupted" }
          }));
          this.resetInterrupt();
          this.raisePendingTaskCompletionIfNeeded();
          await this.save({ force: true });
          return { error: { message: "Turn interrupted by user", code: "interrupted" } };
        }
        const response = await executeModelRound({
          session: this,
          round,
          turnMessageId: turnUserMessageId,
          signal: this.turnAbortController?.signal
        });

        if (!hasToolCalls(response)) {
          const outcome = await handleModelResponseWithoutTools({
            session: this,
            response,
            needsFileMutation,
            requiresTaskComplete,
            procwayMeta,
            turnStartIndex,
            round
          });
          if (outcome.action === "continue") continue;
          await this.maybeAutoCompact();
          if (this.planMode?.isActive() && this.planMode.hasPending()) {
            await this.planMode.promptApply({
              approvalRequester: this.approvalRequester,
              executeImpl: async (entry) => this.executeSingleToolCall({
                id: entry.entryId,
                name: entry.name,
                args: entry.args
              })
            });
          }
          this.events.emit(createEvent("turn.completed", {
            sessionId: this.sessionId,
            round,
            exitCode: 0,
            messageId: turnUserMessageId
          }));
          this.raisePendingTaskCompletionIfNeeded();
          await this.save({ force: true });
          return outcome.response;
        }

        await executeToolsRound({
          session: this,
          round,
          toolCalls: response.toolCalls,
          messageId: response.messageId,
          response
        });

        // §6 return mode: when a run-loop worker called request_user_action it
        // recorded the hearing and `pausedForInput` was stamped (non-blocking
        // deferral). DETERMINISTICALLY end the turn here instead of relying on
        // the model obeying the tool-result `note` ("end your turn now / do NOT
        // call task complete"): a model that ignored the note and kept calling
        // tools or invoked `task complete` would defeat the return-mode hand-off
        // (the run loop returns awaiting-user-input expecting a saved session to
        // resume). The note remains as a model-side hint; this is the guarantee.
        // Only fires for return-mode workers (hearingReturnMode) — a normal chat
        // UIR blocks inside the tool and never reaches here with pausedForInput.
        if (this.hearingReturnMode && this.pausedForInput) {
          await this.maybeAutoCompact();
          this.events.emit(createEvent("turn.completed", {
            sessionId: this.sessionId,
            round,
            exitCode: 0,
            messageId: turnUserMessageId
          }));
          // A returned hearing is the natural hand-off — it is NOT a missing
          // `task complete`, so do not raise the completion reminder (that would
          // make the next resume turn nag about a task the user just deferred).
          await this.save({ force: true });
          return { paused: true, pausedForInput: this.pausedForInput };
        }
      }

      this.events.emit(createEvent("turn.failed", {
        sessionId: this.sessionId,
        round: lastRound,
        messageId: turnUserMessageId,
        error: { message: `Tool loop exceeded maxToolRounds (${maxToolRounds})`, code: "tool_loop_exceeded" }
      }));
      this.raisePendingTaskCompletionIfNeeded();
      await this.save({ force: true });
      return createToolLoopExceededResponse(maxToolRounds);
    } catch (error) {
      // Map a turn-idle watchdog abort to a clear, retryable message instead of
      // the raw DOMException "This operation was aborted" (shared with the
      // orchestrator's turn.failed mapping). Distinct from a user Stop
      // (interruptRequested path → "Turn interrupted by user").
      const mapped = describeTurnAbort(this, error);
      if (error?.turnFailedEmitted !== true) {
        this.events.emit(createEvent("turn.failed", {
          sessionId: this.sessionId,
          round: lastRound,
          messageId: turnUserMessageId,
          error: { message: mapped.message, code: mapped.code }
        }));
      }
      this.raisePendingTaskCompletionIfNeeded();
      // best-effort: don't mask the original error if save() also throws
      try { await this.save({ force: true }); } catch { /* swallow */ }
      if (mapped.idleAbort) {
        // Surface the mapped message to callers too, so no path leaks the raw
        // DOMException. turnFailedEmitted prevents an upstream re-emit.
        const mappedErr = new Error(mapped.message);
        mappedErr.code = "idle_timeout";
        mappedErr.turnFailedEmitted = true;
        throw mappedErr;
      }
      throw error;
    } finally {
      clearIdleWatchdog();
      this.runningTurn = false;
      this.activeToolPolicy = null;
    }
  }

  /**
   * Fold a caller-supplied directive into the session's system message,
   * once. Used by the setup wizard to install its persona/output contract
   * as a true system-level instruction (the global agent has no per-session
   * system-prompt knob, but runTurn options reach here).
   */
  #applySystemPromptAppend(text) {
    const sys = this.messages.find((m) => m.role === "system");
    if (!sys || !Array.isArray(sys.content)) return;
    const textPart = sys.content.find((c) => c.kind === "text");
    if (!textPart) return;
    // The applied flag lives only in memory — a session restored in a fresh
    // process (Pod restart, ADR 0020 resume) starts with it false while the
    // snapshot's system message already carries the directive. Re-detect from
    // the persisted text so recurring callers (e.g. Slack inbound, which sends
    // the same append every turn) don't stack duplicate blocks.
    if (!textPart.text.includes(`## Caller Directive (highest priority)\n${text}`)) {
      textPart.text += `\n\n## Caller Directive (highest priority)\n${text}\n`;
    }
    this.systemPromptAppendApplied = true;
  }

  async compact(options = {}) {
    // getCompactConfig applies defaults and migrates the legacy
    // "drop-tool-results" strategy to summarize-context + dropToolResults.
    const config = getCompactConfig(this.settings);
    const beforeMessages = this.messages.slice();
    const strategy = options.strategy ?? config.strategy;
    const keepLastMessages = options.keepLastMessages ?? config.keepLastMessages;
    const dropToolResults = options.dropToolResults ?? config.dropToolResults ?? false;
    let archivedSnapshotId = null;
    if (this.eventLog && this.settings.session?.enabled !== false) {
      const archived = await writeArchivedSnapshot({
        sessionId: this.sessionId,
        name: `pre-compact-${this.eventCount}`,
        snapshot: { eventCount: this.eventCount, messages: beforeMessages },
        encryptionKey: this.encryptionKey
      });
      archivedSnapshotId = archived.snapshot.snapshotId;
    }
    const raw = beforeMessages.map(messageToRawShape);
    let result;
    if (strategy === "llm-summary") {
      const fallback = options.fallbackStrategy ?? config.fallbackStrategy ?? "summarize-context";
      // Wire the real provider as the default so `llm-summary` actually calls the
      // model. None of the production callers (compactCommand / serve bridge /
      // cli / maybeAutoCompact) pass `runProviderImpl`, and neither `settings`
      // (static JSON config) nor the instance ever hold one — so without this
      // default the resolution collapsed to `null` and compactMessagesLlm
      // silently fell back to the deterministic `summarize-context` summary on
      // every compact (observed as fallbackReason "no-provider"). Provider
      // misconfig / network errors still fall back safely via its try/catch.
      const runProviderImpl = options.runProviderImpl ?? this.settings?.runProviderImpl ?? this.runProviderImpl ?? runProvider;
      result = await compactMessagesLlm({
        messages: raw,
        keepLastMessages,
        runProviderImpl,
        settings: this.settings,
        cwd: this.cwd,
        dropToolResults,
        fallbackStrategy: fallback
      });
    } else {
      result = compactMessages({
        messages: raw,
        strategy,
        keepLastMessages,
        dropToolResults
      });
    }
    if (!result.compacted) return result;
    this.messages = mergeCompactedMessages({
      before: beforeMessages,
      result,
      sessionId: this.sessionId
    });
    const afterIds = new Set(this.messages.map((message) => message?.id).filter(Boolean));
    const removedMessageIds = beforeMessages
      .map((message) => message?.id)
      .filter((id) => Boolean(id) && !afterIds.has(id));
    const summaryMessage = this.messages.find((message) => message?.role === "system" && message?.compacted === true);
    // Persist fallback provenance on the summary message itself so the resumed
    // transcript (projected from messages, not from the live event stream) can
    // label it the same way the live notification does. See
    // projections/transcript.mjs (compact-summary) and preservedExtras().
    if (summaryMessage && result.llmFallback === true) {
      summaryMessage.llmFallback = true;
      if (result.fallbackStrategy) summaryMessage.fallbackStrategy = result.fallbackStrategy;
      if (result.fallbackReason) summaryMessage.fallbackReason = result.fallbackReason;
    }
    // Observability: when an llm-summary request silently falls back to the
    // deterministic compactor (provider down / unconfigured / empty reply), log
    // it and carry the flag on the event so the dashboard can label the result
    // and operators can spot it after the fact in events.jsonl.
    if (result.llmFallback === true) {
      // eslint-disable-next-line no-console
      console.warn(
        `[compact] llm-summary fell back to ${result.fallbackStrategy ?? "summarize-context"} `
        + `(reason: ${result.fallbackReason ?? "unknown"}, session: ${this.sessionId})`
      );
    }
    this.events.emit(createEvent("compact.applied", {
      sessionId: this.sessionId,
      strategy: result.strategy,
      removedMessageIds,
      removedMessages: result.removedMessages,
      snapshotId: archivedSnapshotId ?? undefined,
      summaryMessageId: summaryMessage?.id,
      // 方針A: the actual summary text so the chat panel can show it inline.
      // result.summary is the plain string (the merged Message stores content
      // as a block array, so read it from the result instead).
      summary: typeof result.summary === "string" && result.summary.length > 0 ? result.summary : undefined,
      llmFallback: result.llmFallback === true ? true : undefined,
      fallbackStrategy: result.llmFallback === true ? result.fallbackStrategy : undefined,
      fallbackReason: result.llmFallback === true ? result.fallbackReason : undefined
    }));
    await this.save({ force: true });
    return result;
  }

  compactStatus() {
    const raw = this.messages.map(messageToRawShape);
    return getCompactStatus({ messages: raw, settings: this.settings });
  }

  async maybeAutoCompact() {
    const raw = this.messages.map(messageToRawShape);
    if (!shouldAutoCompact({ messages: raw, settings: this.settings })) return null;
    return this.compact();
  }

  async save({ force = false } = {}) {
    if (this.settings.session?.enabled === false) return;
    await this.flushEventLog();
    if (!this.snapshotThrottle.shouldWrite({ eventCount: this.eventCount, force })) return;
    await saveSessionState({
      sessionId: this.sessionId,
      state: {
        sessionId: this.sessionId,
        title: this.title,
        cwd: this.cwd,
        provider: this.settings.defaultProvider,
        model: resolveActiveModel(this.settings),
        updatedAt: new Date().toISOString(),
        eventCount: this.eventCount,
        messages: this.messages,
        todos: this.todoStore.todos,
        planMode: { active: this.planMode.active, queue: this.planMode.queue },
        usageEvents: typeof this.usageTracker?.raw === "function" ? this.usageTracker.raw() : [],
        loadedTools: this.loadedTools,
        alwaysAllow: [...this.approvalCoordinator.alwaysAllow],
        // A+B: persist worker enforcement state so dashboard restart / page
        // reload doesn't drop the reminder.
        procwayMeta: this.procwayMeta,
        origin: this.origin,
        // Filter-only context tag (Phase 2). Only emit when explicitly set so
        // saveSessionState keeps its sticky/derive fallback for everything else.
        ...(this.sessionContext ? { sessionContext: this.sessionContext } : {}),
        pendingTaskCompletionReminder: this.pendingTaskCompletionReminder
      },
      encryptionKey: this.encryptionKey
    });
    this.snapshotThrottle.recordWrite({ eventCount: this.eventCount });
  }

  /**
   * B: turn-end hook. Raises pendingTaskCompletionReminder when the session
   * is a procway worker that hasn't called `task complete` yet. Idempotent.
   * Call at every termination path (success / failure / interrupt /
   * tool-loop-exceeded / error) so the next runTurn re-asks for completion.
   */
  raisePendingTaskCompletionIfNeeded() {
    if (shouldRemindTaskCompletion(this)) {
      this.pendingTaskCompletionReminder = true;
    }
  }
}

async function loadAndAnnounceMemory(session) {
  try {
    const { retrieveRelevantMemory } = await import("../memory/retriever.mjs");
    const homeDir = session.settings?.memory?.homeDir;
    const snapshot = await retrieveRelevantMemory({
      homeDir,
      cwd: session.cwd,
      signals: []
    });
    if (snapshot) {
      session.events.emit(createEvent("memory.loaded", {
        sessionId: session.sessionId,
        count: snapshot.selected?.length ?? 0,
        types: snapshot.types ?? { user: 0, feedback: 0, project: 0, reference: 0 }
      }));
    }
    return snapshot;
  } catch {
    return null;
  }
}

async function runAgentFromSession({ settings, prompt, cwd, depth, onEvent, signal }) {
  // Child agents are programmatic spawns (spawn_agent), not user-created chats —
  // tag them origin="worker" so listSessions keeps them out of the /ai sidebar
  // (which allowlists origin user/slack). Without this they default to
  // origin=null = "user" and surface as phantom history entries.
  const session = await new AgentSession({ settings, cwd, depth, origin: "worker" }).initialize();
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
  // ADR 0029 P3: forward the inline child's own progress as best-effort,
  // throttled events so the delegated-job driver can stream them. Absent
  // onEvent → no subscription, byte-identical to before.
  if (typeof onEvent === "function") {
    let lastForwardAt = 0;
    const PROGRESS_THROTTLE_MS = 2000;
    const forward = (type) => (event) => {
      const now = Date.now();
      if (now - lastForwardAt < PROGRESS_THROTTLE_MS) return;
      lastForwardAt = now;
      try { onEvent({ source: "inline", type, detail: event?.detail ?? event?.label }); } catch { /* best-effort */ }
    };
    session.events.on("activity.started", forward("activity.started"));
    session.events.on("assistant.message.completed", forward("assistant.message.completed"));
  }
  // kill() on the registry handle aborts via this signal → cancel the child turn.
  // Remove the listener once the turn settles so the (registry-retained, ~30min
  // TTL) AbortController doesn't keep the finished child session alive via the
  // closed-over `session` — restores immediate GC, mirroring the fork cleanup.
  let onAbort = null;
  if (signal) {
    onAbort = () => { try { session.abort(); } catch { /* ignore */ } };
    if (signal.aborted) onAbort();
    else signal.addEventListener?.("abort", onAbort, { once: true });
  }
  try {
    await session.runTurn(prompt);
    return { sessionId: session.sessionId, text: captured.text, exitCode: 0 };
  } finally {
    if (signal && onAbort) signal.removeEventListener?.("abort", onAbort);
  }
}

/**
 * Model-visible note listing a turn's attachments. Hydration turns the
 * attachment_ref blocks into inline images (visible) or text stubs, neither
 * of which carries a usable handle — this note is how the model learns the
 * attachment ids it can pass to save_attachment when it needs the real file.
 */
export function buildAttachmentNote(attachments) {
  const lines = attachments.map((a) => {
    const label = typeof a.name === "string" && a.name ? a.name : "(名称不明)";
    return `- ${label}${a.mime ? ` (${a.mime})` : ""} — attachment id: ${a.id}`;
  });
  return [
    `[このメッセージには添付ファイルが ${attachments.length} 件あります:`,
    ...lines,
    "画像はそのままメッセージに表示されています。画像以外のファイル（テキスト・コード・ログ・CSV など）の中身を読むには、save_attachment tool に attachment id を渡してワークスペースへ保存し、返ってきたパスを read_file tool で開いてください。再アップロード・編集・変換が必要な場合も save_attachment で保存できます。]"
  ].join("\n");
}

function createSessionApprovalRequester({ coordinator, settings, sessionId }) {
  return async (args) => requestApproval({
    ...args,
    approvalMode: args.approvalMode ?? settings?.approvalMode,
    permissions: args.permissions ?? settings?.permissions,
    coordinator,
    sessionId: args.sessionId ?? sessionId
  });
}

function normalizeIncomingMessages(messages, sessionId) {
  if (!Array.isArray(messages)) return [];
  return messages.map((message) => {
    if (isAlreadyMessage(message)) return message;
    return convertLegacyToMessage(message, sessionId);
  });
}

function isAlreadyMessage(message) {
  return Boolean(
    message
    && typeof message === "object"
    && typeof message.id === "string"
    && Array.isArray(message.content)
  );
}

function convertLegacyToMessage(legacy, sessionId) {
  if (!legacy || typeof legacy !== "object") {
    return createMessage({ role: "user", sessionId, content: [] });
  }
  const role = legacy.role ?? "user";
  const meta = {};
  if (legacy.compacted) {
    meta.compacted = true;
    if (legacy.compactedAt) meta.compactedAt = legacy.compactedAt;
    if (legacy.compactStrategy) meta.compactStrategy = legacy.compactStrategy;
    if (legacy.originalMessageCount) meta.originalMessageCount = legacy.originalMessageCount;
  }
  const base = {
    role,
    sessionId,
    content: legacyContentToBlocks(legacy)
  };
  if (legacy.tool_call_id) base.toolCallId = legacy.tool_call_id;
  if (Object.keys(meta).length > 0) base.meta = meta;
  const message = createMessage(base);
  if (legacy.compacted) message.compacted = legacy.compacted;
  if (legacy.compactedAt) message.compactedAt = legacy.compactedAt;
  if (legacy.compactStrategy) message.compactStrategy = legacy.compactStrategy;
  if (legacy.originalMessageCount != null) message.originalMessageCount = legacy.originalMessageCount;
  if (legacy.llmFallback) message.llmFallback = true;
  if (legacy.fallbackStrategy) message.fallbackStrategy = legacy.fallbackStrategy;
  if (legacy.fallbackReason) message.fallbackReason = legacy.fallbackReason;
  return message;
}

function legacyContentToBlocks(legacy) {
  if (Array.isArray(legacy.content)) {
    if (legacy.content.every(isContentBlock)) return legacy.content;
    return legacy.content.map((part) => {
      if (isContentBlock(part)) return part;
      if (typeof part === "string") return { kind: "text", text: part };
      if (typeof part?.text === "string") return { kind: "text", text: part.text };
      return { kind: "text", text: JSON.stringify(part) };
    });
  }
  if (typeof legacy.content === "string") {
    return [{ kind: "text", text: legacy.content }];
  }
  if (legacy.content == null && Array.isArray(legacy.tool_calls)) {
    return legacy.tool_calls.map((toolCall) => ({
      kind: "tool_use",
      toolCallId: toolCall.id,
      name: toolCall.function?.name ?? toolCall.name,
      args: parseToolCallArgs(toolCall)
    }));
  }
  return [];
}

function isContentBlock(value) {
  return Boolean(value && typeof value === "object" && typeof value.kind === "string");
}

function parseToolCallArgs(toolCall) {
  const raw = toolCall.function?.arguments ?? toolCall.args;
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function messageToRawShape(message) {
  if (!message || typeof message !== "object") return message;
  const role = message.role;
  if (typeof message.content === "string") return cloneRawMessage(message);
  if (Array.isArray(message.content)) {
    if (role === "tool") {
      const block = message.content.find((entry) => entry?.kind === "tool_result");
      const payload = block
        ? (block.ok === false ? { error: block.result?.error ?? block.result } : block.result)
        : null;
      return {
        role: "tool",
        tool_call_id: message.toolCallId ?? block?.toolCallId,
        content: JSON.stringify(payload ?? null)
      };
    }
    if (role === "assistant") {
      const toolUses = message.content.filter((block) => block?.kind === "tool_use");
      if (toolUses.length > 0) {
        return {
          role: "assistant",
          content: null,
          tool_calls: toolUses.map((block) => ({
            id: block.toolCallId,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.args ?? {})
            }
          }))
        };
      }
      return {
        role: "assistant",
        content: messageContentToText(message)
      };
    }
    return {
      role,
      content: messageContentToText(message),
      ...preservedExtras(message)
    };
  }
  return cloneRawMessage(message);
}

function cloneRawMessage(message) {
  const clone = { ...message };
  delete clone.id;
  delete clone.sessionId;
  delete clone.toolCallId;
  delete clone.meta;
  return clone;
}

function preservedExtras(message) {
  const extras = {};
  if (message.compacted) extras.compacted = message.compacted;
  if (message.compactedAt) extras.compactedAt = message.compactedAt;
  if (message.compactStrategy) extras.compactStrategy = message.compactStrategy;
  if (message.originalMessageCount != null) extras.originalMessageCount = message.originalMessageCount;
  if (message.llmFallback) extras.llmFallback = true;
  if (message.fallbackStrategy) extras.fallbackStrategy = message.fallbackStrategy;
  if (message.fallbackReason) extras.fallbackReason = message.fallbackReason;
  return extras;
}

function rawShapeToMessage(raw, sessionId) {
  if (raw && typeof raw === "object" && typeof raw.id === "string" && Array.isArray(raw.content)) {
    return raw;
  }
  return convertLegacyToMessage(raw, sessionId);
}

/**
 * Re-attach original Message objects (with stable IDs) to the positions that
 * were untouched by `compactMessages`, and only mint a fresh Message for the
 * new summary entry.
 */
function describeToolForPlan(toolCall) {
  const args = toolCall?.args ?? {};
  if (toolCall.name === "write_file" || toolCall.name === "Edit" || toolCall.name === "edit") {
    return args.filePath ?? "";
  }
  if (toolCall.name === "apply_patch") {
    const patch = typeof args.patch === "string" ? args.patch : "";
    const firstFile = patch.match(/^\+{3} [ab]\/(.+)$/m)?.[1];
    return firstFile ?? "patch";
  }
  if (toolCall.name === "run_shell") {
    return typeof args.command === "string" ? args.command.slice(0, 80) : "";
  }
  if (toolCall.name === "shell_job") {
    return `${args.action ?? "?"} ${typeof args.shellId === "string" ? args.shellId : ""}`.trim();
  }
  if (toolCall.name === "spawn_agent") {
    return typeof args.task === "string" ? args.task.slice(0, 80) : "";
  }
  return toolCall.name;
}

function mergeCompactedMessages({ before, result, sessionId }) {
  const firstSystemCount = before[0]?.role === "system" ? 1 : 0;
  const head = before.slice(0, firstSystemCount);
  const keepLast = Math.max(1, Number(result.keepLastMessages) || 1);
  // Must match compactor.splitMessages exactly: the boundary is walked back
  // off any leading tool-result so a tool_use/tool_result pair is never split
  // (which would orphan a function_call_output -> provider 400). See
  // resolveTailStart for the full rationale.
  const tailStart = resolveTailStart(before, keepLast, firstSystemCount);
  const middle = before.slice(firstSystemCount, tailStart);
  const tail = before.slice(tailStart);

  if (result.strategy === "truncate-oldest") {
    return [...head, ...tail];
  }
  // llm-summary and the summarize-* strategies (incl. the llm-summary
  // fallback) replace the compactable middle with a single summary message.
  const summaryRaw = result.messages[firstSystemCount];
  const summaryMessage = rawShapeToMessage(summaryRaw, sessionId);
  return [...head, summaryMessage, ...tail];
}
