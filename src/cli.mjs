#!/usr/bin/env node
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";
import { installCrashHandlers } from "./telemetry/crash-reporter.mjs";
import { loadSettings } from "./config/load-settings.mjs";
import { applySecretsFromFiles, setSecret } from "./config/load-secrets.mjs";
import { startSettingsHotReload } from "./config/hot-reload.mjs";
import { createUserEnvManager } from "./config/user-env.mjs";
import { validateSettings } from "./config/schema.mjs";
import { initSettings } from "./config/init-settings.mjs";
import { setSetting } from "./config/workspace-settings.mjs";
import { resolveActiveModel } from "./config/active-model.mjs";
import { runAgent } from "./agent/loop.mjs";
import { getSharedShellManager } from "./tools/shell-manager.mjs";
import { invalidateDisplayToolAvailability, primeDisplayToolAvailability } from "./tools/registry.mjs";
import {
  createAgentSession,
  EventBus,
  compactCommand,
  configCommand,
  contextCommand,
  historyCommand,
  modelCommand,
  resumeCommand,
  exitCommand,
  usageCommand,
  planCommand,
  todosCommand,
  memoryCommand,
  branchCommand,
  mcpListCommand,
  addMcpServer,
  removeMcpServer,
  parseMcpAddArgs
} from "./core/index.mjs";
import { migrateLegacyFormatIfNeeded } from "./session/migration.mjs";
import { listSessions, loadSessionState } from "./session/store.mjs";
import { createTimelineRenderer } from "./adapters/tui/timeline-renderer.mjs";
import { pickSession } from "./adapters/tui/session-picker.mjs";
import { renderAssistantContent } from "./adapters/tui/transcript-node-render.mjs";
import { printSessionRecap } from "./adapters/tui/session-recap.mjs";
import { swapActiveSession, disposeSessionRenderers } from "./adapters/tui/session-swap.mjs";
import { attachApprovalPrompt } from "./adapters/tui/approval-prompt.mjs";
import { createStreamingRenderer } from "./adapters/tui/streaming-renderer.mjs";
import { attachInterruptHandler } from "./adapters/tui/interrupt.mjs";
import { createInputController } from "./adapters/tui/input-controller.mjs";
import { createInputHistory } from "./adapters/tui/input-history.mjs";
import { createTurnQueue } from "./adapters/tui/turn-queue.mjs";
import { createWakeInjector, drainTurnQueue, WAKE_NOTICE_LINE } from "./adapters/tui/turn-executor.mjs";
import { createShutdown } from "./adapters/tui/shutdown.mjs";
import { applyTerminalSetup, planTerminalSetup, CTRL_J_ADVICE } from "./adapters/tui/terminal-setup.mjs";
import { sanitizeTerminalText } from "./adapters/tui/sanitize.mjs";
import { renderDiff } from "./adapters/tui/diff.mjs";
import { createReplCompleter } from "./adapters/tui/path-completion.mjs";
import { attachTodoRenderer } from "./adapters/tui/todo-render.mjs";
import { createSlashCompleter, formatMenu, formatSlashHelp, findSkillMd, isBuiltinSlashCommand, slashCommandName } from "./adapters/tui/slash-completion.mjs";
import { createCompletionSource } from "./adapters/tui/completion-menu.mjs";
import { clearTerminal, formatThinkingMode, renderDisabledToolNote, renderPrompt, renderStatus, renderWelcome } from "./adapters/tui/shell.mjs";
import { resolveHyperlinks, style, supportsColor, terminalWidth } from "./adapters/tui/ansi.mjs";
import {
  renderBranch,
  renderCompact,
  renderContext,
  renderMemory,
  renderModel,
  renderPlan,
  renderTodos,
  renderUsage,
  renderMcp
} from "./adapters/tui/command-render.mjs";
import { renderTurnError } from "./adapters/tui/error-render.mjs";
import { renderHeading } from "./adapters/tui/panel.mjs";
import { createReasoningRenderer } from "./adapters/tui/reasoning-render.mjs";
import { readSecretInput } from "./adapters/tui/secret-input.mjs";
import { expandInput } from "./adapters/tui/input-preprocessor.mjs";
import { startServer } from "./adapters/serve/server.mjs";
import { handleAuthCommand } from "./auth/auth-cli.mjs";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = path.resolve(args.cwd ?? process.cwd());
  // --repo-root lets callers (e.g., procway's run-task) point us at the
  // procway repo's `.procway/ai-agent/settings.json` even when cwd is a
  // ticket worktree that has no settings file of its own. Without this,
  // workspace settings effectively fall back to user-level settings and
  // model/provider choices configured in the dashboard UI are ignored.
  const repoRoot = args.repoRoot ? path.resolve(args.repoRoot) : null;

  if (args.initSettings) {
    const result = await initSettings({ cwd, scope: args.initSettings, force: args.force });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  await applySecretsFromFiles({ cwd: repoRoot ?? cwd });

  const { settings, sources } = await loadSettings({ cwd, repoRoot, cliOptions: args });
  const errors = validateSettings(settings);
  if (errors.length > 0) {
    for (const error of errors) console.error(`settings error: ${error}`);
    process.exitCode = 1;
    return;
  }
  if (args.runtimeMode === "plan" || process.env.PROCWAY_MODE === "plan") {
    settings.plan = { ...(settings.plan ?? {}), enabled: true };
  }

  if (args.showConfig) {
    console.log(JSON.stringify({ settings, sources }, null, 2));
    return;
  }

  if (args.command === "config") {
    await handleConfigCommand({ args, cwd, settings, sources });
    return;
  }

  if (args.command === "model") {
    await handleModelCommand({ args, cwd, settings });
    return;
  }

  if (args.command === "resume") {
    await resumeSession({ cwd, settings, sessionId: args.sessionId });
    return;
  }

  if (args.command === "compact") {
    await compactSessionFromCli({ cwd, settings, sessionId: args.sessionId, compactOptions: args.compact });
    return;
  }

  if (args.command === "serve") {
    await runServe({ cwd, repoRoot, settings, port: args.port ?? 7777, host: args.host ?? "127.0.0.1" });
    return;
  }

  if (args.command === "auth") {
    try {
      await handleAuthCommand({
        positional: args.positional,
        options: { profile: args.authProfile, originator: args.authOriginator },
        cwd: repoRoot ?? cwd
      });
    } catch (error) {
      console.error(sanitizeTerminalText(error?.message ?? String(error)));
      process.exitCode = 1;
    }
    // Force exit: undici keeps the global keep-alive socket pool alive after
    // fetch calls, and an OAuth login also leaves the OS browser child
    // process referenced — both pin the Node event loop. We're a one-shot
    // CLI command at this point, so flushing stdio and exiting is correct.
    output.write("");
    process.exit(process.exitCode ?? 0);
  }

  if (args.scanContext) {
    const result = await contextCommand({ cwd, settings });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (args.prompt) {
    await runPrompt({ prompt: args.prompt, cwd, settings });
    return;
  }

  await runRepl({ cwd, settings });
}

function parseArgs(argv) {
  const parsed = { positional: [] };
  if (["config", "model", "resume", "compact", "serve", "auth"].includes(argv[0])) {
    parsed.command = argv.shift();
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cwd") parsed.cwd = argv[++index];
    else if (arg === "--repo-root") parsed.repoRoot = argv[++index];
    else if (arg === "--scope") parsed.scope = argv[++index];
    else if (arg === "--model") parsed.model = argv[++index];
    else if (arg === "--provider") parsed.provider = argv[++index];
    else if (arg === "--approval-mode") parsed.approvalMode = argv[++index];
    else if (arg === "--max-tool-rounds") parsed.maxToolRounds = Number(argv[++index]);
    else if (arg === "--strategy") parsed.compact = { ...(parsed.compact ?? {}), strategy: argv[++index] };
    else if (arg === "--keep-last") parsed.compact = { ...(parsed.compact ?? {}), keepLastMessages: Number(argv[++index]) };
    else if (arg === "--status") parsed.compact = { ...(parsed.compact ?? {}), status: true };
    else if (arg === "--aggressive") parsed.compact = { ...(parsed.compact ?? {}), strategy: "summarize-aggressive" };
    else if (arg === "--compatibility-mode") parsed.compatibilityMode = argv[++index];
    else if (arg === "--show-config") parsed.showConfig = true;
    else if (arg === "--scan-context") parsed.scanContext = true;
    else if (arg === "--mode") parsed.runtimeMode = argv[++index];
    else if (arg === "--port") parsed.port = Number(argv[++index]);
    else if (arg === "--host") parsed.host = argv[++index];
    else if (arg === "--init-settings") {
      const next = argv[index + 1];
      if (next && !next.startsWith("-")) {
        parsed.initSettings = next;
        index += 1;
      } else {
        parsed.initSettings = "user";
      }
    }
    else if (arg === "--force") parsed.force = true;
    else if (arg === "--profile") parsed.authProfile = argv[++index];
    else if (arg === "--originator") parsed.authOriginator = argv[++index];
    else if (arg === "-p" || arg === "--prompt") parsed.prompt = argv[++index];
    else if (arg === "-h" || arg === "--help") parsed.help = true;
    else parsed.positional.push(arg);
  }
  if (parsed.help) {
    printHelp();
    process.exit(0);
  }
  if (!parsed.prompt && parsed.positional.length > 0) {
    if (parsed.command === "resume") {
      parsed.sessionId = parsed.positional[0];
    } else if (parsed.command === "compact") {
      parsed.sessionId = parsed.positional[0];
    } else if (parsed.command === "auth") {
      // Keep positional intact; auth-cli.mjs interprets it as `<sub> [args…]`.
    } else {
      parsed.prompt = parsed.positional.join(" ");
    }
  }
  return parsed;
}

function printHelp() {
  console.log(`procway-code

Usage:
  procway-code [prompt]
  procway-code -p "fix tests"
  procway-code --show-config
  procway-code --scan-context
  procway-code --init-settings user
  procway-code resume [sessionId]
  procway-code compact [sessionId]
  procway-code config
  procway-code config set providers.<id>.defaultModel model-id
  procway-code config set-secret OPENAI_API_KEY
  procway-code model set model-id
  procway-code serve [--port 7777] [--host 127.0.0.1]
    PROCWAY_SERVE_TOKEN=<token> required; bind 0.0.0.0 to expose to LAN.
  procway-code auth login [provider] [--profile <id>] [--originator <name>]
  procway-code auth status [profile]
  procway-code auth logout <profile>

Options:
  --cwd <path>
  --scope <user|workspace>  Write config/model/secrets to user scope by default
  --provider <id>
  --model <model>
  --approval-mode <always-ask|auto-readonly|full-auto>
  --max-tool-rounds <number>  0 means unlimited
  --strategy <drop-tool-results|summarize-context|summarize-aggressive|truncate-oldest>
  --keep-last <number>
  --status
  --compatibility-mode <claude|codex|mixed>
  --init-settings <workspace|user>
  --force
`);
}

async function runPrompt({ prompt, cwd, settings }) {
  const events = new EventBus();
  const streamRenderer = createStreamingRenderer({
    writer: process.stdout,
    width: terminalWidth(process.stdout),
    colorize: supportsColor(process.stdout),
    hyperlinks: resolveHyperlinks(settings?.ui?.hyperlinks, process.stdout)
  });
  streamRenderer.attach(events);
  events.on("assistant.message.completed", (event) => {
    if (streamRenderer.isStreaming() || streamRenderer.hadOutput()) return;
    if (Array.isArray(event.content)) {
      const text = event.content
        .filter((b) => b?.kind === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("");
      // Phase 3e: headless `-p` writes the model's text straight to stdout, so
      // it needs the same escape neutralisation the REPL renderers apply.
      const safe = sanitizeTerminalText(text);
      if (safe) process.stdout.write(`${safe}${safe.endsWith("\n") ? "" : "\n"}`);
    }
  });
  try {
    await runAgent({ settings, prompt, cwd, events });
    process.exitCode = 0;
  } catch (error) {
    // Provider error bodies are external text — neutralise before printing.
    console.error(sanitizeTerminalText(error.message));
    process.exitCode = 1;
  } finally {
    streamRenderer.detach();
    // Background shells spawned by `run_shell { runInBackground:true }` keep
    // child-process pipes open and pin the Node event loop, so a one-shot
    // `-p` invocation never exits even after the agent's final turn. Reap
    // them here so the runner-driven flow can finalize meta.json.
    try { await getSharedShellManager().closeAll({ graceMs: 2000 }) } catch { /* ignore */ }
  }
}

/**
 * Build the one stdin owner for an interactive run (P2-1).
 *
 * Everything that used to create its own readline / raw-mode reader —
 * `runRepl`, `resumeSession`, `approval-prompt.mjs`, `session-picker.mjs`,
 * `secret-input.mjs` — now goes through this controller instead.
 */
async function createReplInput({ cwd }) {
  const history = createInputHistory();
  await history.load();
  const controller = createInputController({
    input,
    output,
    completer: makeReplCompleter({ cwd }),
    history
  }).start();
  return { controller, history };
}

/**
 * Tools the environment could not provide (`web_browser` without a browser,
 * `desktop_action` without an X display). Collected BEFORE the first session so
 * the warning does not console.warn its way above the banner (P3b-3); the
 * banner gets a dim one-liner and `/status` carries the reasons.
 */
let disabledToolNotes = [];

function collectDisabledTools({ settings }) {
  const lines = [];
  const availability = primeDisplayToolAvailability({
    settings,
    logger: (line) => lines.push(line)
  });
  void lines; // the raw log line is replaced by the structured list below
  return Object.entries(availability ?? {})
    .filter(([, entry]) => entry?.available === false)
    .map(([name, entry]) => ({ name, reason: entry?.reason ?? "unavailable" }));
}

async function runRepl({ cwd, settings }) {
  const { controller, history } = await createReplInput({ cwd });
  // Probe before the session so the "[tools] disabled …" warning is ours to
  // place, not console.warn's (P3b-3).
  disabledToolNotes = collectDisabledTools({ settings });
  let session;
  try {
    session = await createReplSession({ cwd, settings, controller });
  } catch (error) {
    // stdin is already in raw mode at this point — hand the terminal back
    // before the error propagates, or the user's shell is left unusable.
    controller.dispose();
    throw error;
  }
  printWelcomeBanner({ session, cwd, settings });
  await runConversationLoop({ controller, history, cwd, settings, session });
}

function printWelcomeBanner({ session, cwd, settings, output = process.stdout }) {
  const color = supportsColor(output);
  const width = terminalWidth(output);
  output.write(renderWelcome({
    sessionId: session.sessionId,
    cwd,
    provider: settings.defaultProvider,
    model: resolveActiveModel(settings),
    approvalMode: settings.approvalMode,
    width,
    color
  }));
  output.write(renderDisabledToolNote(disabledToolNotes, { width, color }));
}

/**
 * True for errors that are really UI events: an aborted prompt (Ctrl+C /
 * Ctrl+D), use of a closed interface, or a cancelled hidden-secret prompt.
 * These must never print a stack trace (P0-2).
 */
function isUiControlError(error) {
  if (!error) return false;
  const code = error.code ?? "";
  const name = error.name ?? "";
  const message = String(error.message ?? "");
  return (
    name === "AbortError" ||
    code === "ABORT_ERR" ||
    code === "ERR_USE_AFTER_CLOSE" ||
    message === "Secret input cancelled" ||
    message.startsWith("Aborted with Ctrl+")
  );
}

async function createReplSession({ cwd, settings, sessionId, messages = [], title = null, controller = null, procwayMeta = null, pendingTaskCompletionReminder = false }) {
  const events = new EventBus();
  // One hyperlink decision per session, shared by the live feed, the
  // non-streaming fallback below and (through `printSessionRecap`) the replay
  // routes — resolving it separately per renderer would let live and replayed
  // output drift apart.
  const hyperlinks = resolveHyperlinks(settings?.ui?.hyperlinks, output);
  const streamRenderer = createStreamingRenderer({
    writer: controller ? controller.writer : output,
    width: terminalWidth(output),
    colorize: supportsColor(output),
    hyperlinks
  });
  // P3b-2: the live feed writes through the input controller, so a spinner
  // frame can never overwrite an approval prompt, and the transient row is
  // cleared before any full line lands on it.
  const colorize = supportsColor(output);
  const renderer = createTimelineRenderer({
    enabled: true,
    writer: controller ? controller.writer : process.stderr,
    isBusy: controller ? () => controller.isOverlay : null,
    colorize,
    width: () => terminalWidth(output)
  });
  // Attach ORDER MATTERS, and the timeline renderer has to go first: both
  // subscribe to `assistant.message.delta`, and its handler is what erases
  // the half-drawn spinner row. Subscribed the other way round, the first
  // Markdown block of a message landed on that row and the terminal showed
  // `⠋ model waiting round=0 (0.0s)見出し`.
  renderer.attach(events);
  streamRenderer.attach(events);
  events.on("assistant.message.completed", (event) => {
    if (streamRenderer.isStreaming() || streamRenderer.hadOutput()) return;
    // Non-streaming providers land here. Render exactly what the streaming
    // path would have written (Markdown, no role label) so live output does
    // not depend on whether the provider streamed.
    // MUST go through the controller writer (not the raw `output` here): the
    // streamRenderer writes via `controller.writer`, and any adapter that
    // prints while the dock is armed has to use the same dock-aware sink or
    // the editor's row bookkeeping desyncs from the terminal — which is what
    // let a mid-turn (long bash / spawn_agent) completion dump its block over
    // the pinned TODO panel / `╭─` header and left the tool rows lingering.
    const sink = controller ? controller.writer : output;
    // A tool-call round's assistant message carries no text, so this renders
    // to "" — and a message that has nothing to show must not reach the sink
    // at all (the dock treats an empty write as a partial line and hides the
    // input). `assistant.message.completed` fires once per round, so this is
    // the common case, not an edge one.
    const rendered = renderAssistantContent(event.content, {
      width: terminalWidth(output),
      colorize: supportsColor(output),
      hyperlinks
    });
    if (rendered !== "") sink.write(rendered);
  });
  // P3b-8: the CLI used to be the only surface that dropped reasoning deltas.
  const reasoningRenderer = createReasoningRenderer({
    writer: controller ? controller.writer : output,
    width: () => terminalWidth(output),
    colorize,
    // P3-14: reasoning is folded to a one-line summary by default so a long
    // chain of thought does not dominate the screen; `/thinking [full|fold|off]`
    // switches it. `settings.ui.thinking === false` hides it outright.
    defaultMode: settings?.ui?.thinking === false ? "hidden" : "folded"
  });
  reasoningRenderer.attach(events);
  const session = await createAgentSession({
    settings,
    cwd,
    sessionId,
    messages,
    title,
    events,
    procwayMeta,
    pendingTaskCompletionReminder
  });
  // Every subscription this function makes is recorded so swapActiveSession()
  // can tear the whole session down on /resume and /checkout (P1-7).
  // The todo renderer is kept on `session.todoRenderer` too so `/todos
  // full|compact|off` can toggle its live display mode at runtime.
  const todoRenderer = attachTodoRenderer({
    session,
    output: controller ? controller.writer : output,
    colorize,
    width: terminalWidth(output),
    mode: settings?.ui?.todoDisplay ?? "full"
  });
  session.todoRenderer = todoRenderer;
  session.tuiDisposables = [
    attachApprovalPrompt({ session, input, output, controller }),
    todoRenderer
  ];
  session.timelineRenderer = renderer;
  session.streamingRenderer = streamRenderer;
  session.reasoningRenderer = reasoningRenderer;
  return session;
}

/**
 * The REPL completer: slash commands plus `@path` file references (P2-7).
 * Lives in adapters/tui/path-completion.mjs so it can be unit-tested without
 * booting the CLI.
 */
function makeReplCompleter({ cwd = process.cwd() } = {}) {
  return createReplCompleter({ cwd, slashCompleter: createSlashCompleter() });
}

async function handleConfigCommand({ args, cwd, settings, sources }) {
  const [subcommand, key, value] = args.positional;
  if (!subcommand) {
    console.log(JSON.stringify({ settings, sources }, null, 2));
    return;
  }
  if (subcommand === "set") {
    if (!key || value == null) throw new Error("Usage: procway-code config set <key> <value>");
    console.log(JSON.stringify(await setSetting({ cwd, scope: configWriteScope(args), key, value }), null, 2));
    return;
  }
  if (subcommand === "set-secret") {
    if (!key || value != null) throw new Error("Usage: procway-code config set-secret <ENV_NAME> (the value is read securely from stdin)");
    const secret = await readSecretInput({ input, output, prompt: `Enter ${key}: ` });
    console.log(JSON.stringify(await setSecret({ cwd, scope: configWriteScope(args), key, value: secret }), null, 2));
    return;
  }
  throw new Error(`Unknown config command: ${subcommand}`);
}

async function handleModelCommand({ args, cwd, settings }) {
  const [subcommand, model] = args.positional;
  if (!subcommand || subcommand === "current") {
    console.log(`${settings.defaultProvider}:${resolveActiveModel(settings) ?? ""}`);
    return;
  }
  if (subcommand === "set") {
    if (!model) throw new Error("Usage: procway-code model set <model>");
    const providerId = settings.defaultProvider;
    if (!providerId) throw new Error("model set requires defaultProvider to be configured");
    const key = `providers.${providerId}.defaultModel`;
    console.log(JSON.stringify(await setSetting({ cwd, scope: configWriteScope(args), key, value: model }), null, 2));
    return;
  }
  throw new Error(`Unknown model command: ${subcommand}`);
}

function configWriteScope(args) {
  const scope = args.scope ?? "user";
  if (scope !== "user" && scope !== "workspace") {
    throw new Error("--scope must be user or workspace");
  }
  return scope;
}

async function resumeSession({ cwd, settings, sessionId }) {
  await migrateLegacyFormatIfNeeded();
  const { sessions } = await listSessions({ cwd, limit: 200 });
  // One controller for the whole command — the picker borrows it instead of
  // flipping raw mode on its own (P2-1).
  const { controller, history } = await createReplInput({ cwd });
  const picked = sessionId
    ? sessions.find((session) => session.sessionId === sessionId)
    : await pickSession({ sessions, input, output, controller });
  const resolvedSessionId = picked?.sessionId ?? sessionId;
  if (!resolvedSessionId) {
    console.log(sessions.length === 0 ? "No sessions found." : "Resume cancelled.");
    controller.dispose();
    return;
  }
  const { state } = await resumeCommand({ cwd, sessionId: resolvedSessionId });
  const session = await createReplSession({
    cwd,
    settings,
    sessionId: resolvedSessionId,
    messages: state.messages ?? [],
    title: state.title,
    controller
  });
  printSessionRecap({ session, output, cwd, settings });
  await runConversationLoop({ controller, history, cwd, settings, session });
}

async function runConversationLoop({ controller, history = null, cwd, settings, session }) {
  let activeSession = session;
  // Single exit path (P2-5): save → reap children → give the terminal back →
  // exit. Ctrl+C, /exit, Ctrl+D, EOF and SIGTERM all land here.
  const shutdown = createShutdown({
    getSession: () => activeSession,
    controller,
    shellManager: getSharedShellManager(),
    output,
    errorOutput: process.stderr,
    onWarn: (message) => process.stderr.write(`[shutdown] ${message}\n`)
  });
  const saveHistory = async () => {
    try { await history?.save?.(); } catch { /* history is best-effort */ }
  };
  const leave = async ({ code = 0, reason }) => {
    await saveHistory();
    await shutdown({ code, reason });
  };
  // getSession, not session: /resume and /checkout replace activeSession, and
  // a value captured here would leave Ctrl+C aborting the session the user
  // just left (P1-7).
  const interruptHandle = attachInterruptHandler({
    getSession: () => activeSession,
    // Write around the prompt: a bare stderr write mid-edit would desync the
    // editor's row bookkeeping from the terminal.
    output: controller.writer,
    isTurnRunning: () => activeSession?.runningTurn === true,
    onIdleFirstPress: () => controller.clearInput(),
    // shutdown() owns the real process.exit — it must save and reap first.
    onExit: () => { void leave({ code: 130, reason: "sigint" }); },
    exit: () => {}
  });
  controller.onInterrupt = () => interruptHandle.trigger();
  controller.onEscape = () => interruptHandle.triggerEscape();
  // EOF while a prompt is up resolves question() with null (handled below);
  // EOF while a turn is running has no pending question, so route it here.
  // shutdown() is idempotent, so the two paths cannot double-exit.
  // EOF while a prompt is up resolves question() with null (handled in the
  // input pump); EOF while a turn is running reaches here. Either way the
  // leave is DEFERRED to the executor so it can drain any queued lines first —
  // a piped `echo "…" | procway-code` must process every line, never stop
  // early. With the always-armed pump there is (nearly) always a pending
  // question, so this is mostly a defensive path.
  let eofDeferred = false;
  let closeQueue = null;
  controller.onEof = () => { eofDeferred = true; closeQueue?.(); };
  const onSigterm = () => { void leave({ code: 143, reason: "sigterm" }); };
  process.on("SIGTERM", onSigterm);
  // P3b-11: a resized window must reflow the Markdown the streaming renderer
  // produces (the prompt, panels and picker read `output.columns` per paint,
  // and the input controller repaints its own region).
  const onResize = () => {
    activeSession?.streamingRenderer?.setWidth?.(terminalWidth(output));
  };
  output.on?.("resize", onResize);
  const width = () => terminalWidth(output);
  const color = () => supportsColor(output);
  // One source for `/command` and `@path` candidates — the menu the prompt
  // shows and the Tab completer agree because they share `createReplCompleter`.
  const completionSource = createCompletionSource({ cwd, completer: makeReplCompleter({ cwd }) });
  const sessionUsage = () => {
    try { return activeSession?.usageTracker?.summary?.() ?? null; } catch { return null; }
  };
  try {
    // Persistent-input queue (turn-queue). The input pump below keeps a level-0
    // prompt armed for the WHOLE REPL, so the user can keep typing and
    // submitting while a turn runs. Every submitted line is pushed onto `queue`
    // and the executor drains it one-at-a-time (FIFO): the current turn always
    // finishes before the next queued line is started. Commands are just items
    // too, so a `/help` typed during a long turn runs after that turn, never in
    // the middle of its streaming.
    //
    // Because the prompt is always on screen, every byte this loop writes must
    // go through the controller so it can erase/redraw the input line around it
    // (a bare process.stdout write would desync the editor's row bookkeeping).
    // `output` below still reports the stream's columns/isTTY (terminalWidth and
    // supportsColor keep working) but routes writes through controller.write.
    const output = {
      write: (text) => controller.write(text),
      writeTransient: (text) => controller.writeTransient(text),
      get isTTY() { return process.stdout.isTTY === true; },
      get columns() { return process.stdout.columns; },
      get rows() { return process.stdout.rows; },
      on: (...args) => process.stdout.on?.(...args),
      removeListener: (...args) => process.stdout.removeListener?.(...args)
    };
    const queue = createTurnQueue();
    // The onEof handler above defers leaving via the queue, but it must reach
    // THIS queue instance (declared inside the try block).
    closeQueue = () => queue.close();

    // event-wake (issue #143). The supervisor's default injector calls
    // session.runTurn() directly, which is exactly what the REPL must not do:
    // turns here are run by ONE serial executor, and a wake starting its own
    // turn would interleave with a queued line (two turns writing the same
    // stream). So the wake becomes a queue item like any other — the FIFO IS
    // the concurrency guard, and a wake pushed mid-turn runs right after the
    // turn that was in flight. Re-bound after /resume and /checkout, because
    // each session owns its own supervisor.
    const wakeInjector = createWakeInjector({ queue });
    const bindWakeInjector = (target) => {
      target?.wakeSupervisor?.setInjector(wakeInjector);
    };
    bindWakeInjector(activeSession);

    // Run one prompt as a fresh turn, verbatim. Split out of runTurnMessage so
    // a wake can reuse the turn plumbing WITHOUT the @/! expansion below: a
    // wake body is machine-written text that may legitimately contain `@` or
    // `!` (a file path in a child agent's result), and expanding it would pop
    // a shell-approval prompt for something the user never typed.
    const sendToModel = async (prompt, options = {}) => {
      try {
        await activeSession.runTurn(prompt, options);
      } catch (error) {
        if (isUiControlError(error)) return;
        printTurnError(error, { output, width: width(), color: color() });
      }
    };

    // Run one user message as a fresh turn. The @/! expansion is done here (in
    // the executor) because it can itself prompt for approval through the
    // controller — never while the input pump is between reads.
    const runTurnMessage = async (prompt) => {
      if (prompt.includes("@") || prompt.includes("!")) {
        try {
          const expanded = await expandInput({
            line: prompt,
            cwd,
            permissions: settings?.permissions ?? null,
            approvalRequester: makeReplShellApprovalRequester({ controller })
          });
          if (expanded.attached.length > 0) {
            prompt = expanded.expanded;
            // Echo what was attached so the user can see it locally — the
            // expanded blocks are otherwise only visible to the LLM.
            for (const item of expanded.attached) {
              if (item.kind === "file") {
                const note = item.error
                  ? `[@${item.ref}: ${item.error}]`
                  : `[@${item.ref} attached (${item.bytes} bytes${item.truncated ? ", truncated" : ""})]`;
                output.write(`${color() ? style("muted", note) : note}\n`);
              } else if (item.kind === "shell") {
                const head = `[!${item.command} → exit ${item.exitCode}]`;
                output.write(`${color() ? style("muted", head) : head}\n`);
                if (item.stdout) {
                  output.write(item.stdout);
                  if (!item.stdout.endsWith("\n")) output.write("\n");
                }
                if (item.stderr) {
                  const text = color() ? style("danger", item.stderr.replace(/\n$/, "")) : item.stderr.replace(/\n$/, "");
                  output.write(`${text}\n`);
                }
              }
            }
          }
        } catch {
          // expansion is best-effort; fall back to raw input
        }
      }
      await sendToModel(prompt);
    };

    // Resolve one submitted line. Returns true if it was consumed as a
    // /command; false if the caller should send it to the model as a message.
    const dispatch = async (trimmed) => {
      if (trimmed === "/terminal-setup") {
        await runTerminalSetupCommand({ controller, output });
        return true;
      }
      if (trimmed === "/help") {
        // One write for the whole panel: with the always-on prompt every write
        // redraws around the input line, so splitting header and body into two
        // writes fragments the panel across repaint boundaries.
        output.write(`${renderHeading("Commands", { color: color() })}\n${formatSlashHelp(undefined, { width: width() })}\n`);
        return true;
      }
      if (trimmed === "/clear") {
        clearTerminal(output);
        // A cleared screen used to take the model name and session id with it
        // (P3b-4) — the banner is what identifies the session, so re-print it.
        printWelcomeBanner({ session: activeSession, cwd, settings: activeSession.settings ?? settings, output });
        return true;
      }
      if (trimmed === "/status") {
        output.write(renderStatus({
          cwd,
          sessionId: activeSession.sessionId,
          provider: activeSession.settings?.defaultProvider,
          model: resolveActiveModel(activeSession.settings),
          approvalMode: activeSession.settings?.approvalMode,
          planMode: activeSession.planMode?.isActive(),
          usage: sessionUsage(),
          disabledTools: disabledToolNotes,
          thinking: activeSession.reasoningRenderer?.getMode?.() ?? null,
          width: width(),
          color: color()
        }));
        return true;
      }
      if (trimmed === "/thinking" || trimmed.startsWith("/thinking ")) {
        const renderer = activeSession.reasoningRenderer;
        const arg = trimmed.split(/\s+/)[1]?.toLowerCase() ?? "";
        if (!renderer) {
          output.write("Reasoning output is not available for this session.\n");
          return true;
        }
        // off|fold|full set a mode; a bare `/thinking` cycles hidden → folded →
        // full. `on` / `off` stay as aliases for `full` / `hidden`.
        let mode;
        if (arg === "on" || arg === "full") mode = renderer.setMode("full");
        else if (arg === "off" || arg === "hidden") mode = renderer.setMode("hidden");
        else if (arg === "fold" || arg === "folded") mode = renderer.setMode("folded");
        else {
          const current = renderer.getMode();
          mode = renderer.setMode(current === "hidden" ? "folded" : current === "folded" ? "full" : "hidden");
        }
        output.write(`Thinking output: ${formatThinkingMode(mode)}.\n`);
        return true;
      }
      if (trimmed === "/config") {
        const result = await configCommand({ session: activeSession });
        output.write(`${JSON.stringify(result.settings, null, 2)}\n`);
        return true;
      }
      if (trimmed === "/config setup") {
        try {
          await configureProviderInTui({ controller, cwd, settings, session: activeSession, output });
        } catch (error) {
          // Ctrl+C inside the hidden token prompt throws "Secret input
          // cancelled" — a user action, not a crash. Stay in the REPL.
          if (!isUiControlError(error)) throw error;
          output.write("Provider setup cancelled.\n");
        }
        return true;
      }
      if (trimmed === "/model") {
        const result = await modelCommand({ session: activeSession });
        output.write(renderModel(result, { color: color() }));
        return true;
      }
      // welcome:false — /history replays the transcript of the session the
      // banner already describes; re-printing the card was noise (P3b-12).
      if (trimmed === "/history") {
        const result = await historyCommand({ session: activeSession });
        printSessionRecap({ session: activeSession, output, cwd, settings, welcome: false });
        void result;
        return true;
      }
      if (trimmed === "/usage") {
        const result = await usageCommand({ session: activeSession });
        output.write(renderUsage(result, { width: width(), color: color() }));
        return true;
      }
      if (trimmed.startsWith("/compact")) {
        const result = await compactCommand({ session: activeSession, args: trimmed.split(/\s+/).slice(1) });
        output.write(renderCompact(result, { width: width(), color: color() }));
        return true;
      }
      if (trimmed === "/resume") {
        // The controller MUST be threaded through: the picker borrows its key
        // stream and the new session's approval prompt asks through it, so
        // stdin keeps exactly one owner across the swap (P2-1).
        const resumed = await pickAndCreateSession({ cwd, settings, controller });
        if (resumed) {
          activeSession = swapActiveSession(activeSession, resumed);
          bindWakeInjector(activeSession);
          printSessionRecap({ session: activeSession, output, cwd, settings });
        }
        return true;
      }
      if (trimmed.startsWith("/checkout")) {
        const targetId = trimmed.split(/\s+/).slice(1).join(" ").trim();
        if (!targetId) {
          output.write("Usage: /checkout <sessionId>\n");
          return true;
        }
        const checkedOut = await checkoutSession({ cwd, settings, sessionId: targetId, controller });
        if (checkedOut) {
          activeSession = swapActiveSession(activeSession, checkedOut);
          bindWakeInjector(activeSession);
          printSessionRecap({ session: activeSession, output, cwd, settings });
        }
        return true;
      }
      if (trimmed === "/context") {
        const result = await contextCommand({ cwd, settings });
        output.write(renderContext(result, { width: width(), color: color(), cwd }));
        return true;
      }
      if (trimmed === "/plan" || trimmed.startsWith("/plan ")) {
        const result = await planCommand({ session: activeSession, args: trimmed.split(/\s+/).slice(1) });
        output.write(renderPlan(result, { width: width(), color: color() }));
        return true;
      }
      if (trimmed === "/todos" || trimmed.startsWith("/todos ")) {
        const arg = trimmed.split(/\s+/)[1];
        if (arg === "full" || arg === "compact" || arg === "off") {
          activeSession.todoRenderer?.setMode?.(arg);
          activeSession.todoRenderer?.rerender?.();
          output.write(`${color() ? style("muted", `Todo display set to ${arg}.`) : `Todo display set to ${arg}.`}\n`);
        } else {
          const result = await todosCommand({ session: activeSession });
          output.write(renderTodos(result, { width: width(), color: color() }));
        }
        return true;
      }
      if (trimmed === "/memory") {
        const result = await memoryCommand({ session: activeSession });
        output.write(renderMemory(result, { width: width(), color: color() }));
        return true;
      }
      if (trimmed.startsWith("/branch")) {
        const result = await branchCommand({ session: activeSession, args: trimmed.split(/\s+/).slice(1) });
        output.write(renderBranch(result, { width: width(), color: color(), cwd }));
        return true;
      }
      if (trimmed === "/mcp" || trimmed.startsWith("/mcp ")) {
        await handleMcpCommand({ controller, session: activeSession, cwd, args: trimmed.split(/\s+/).slice(1), output });
        return true;
      }
      if (trimmed.startsWith("/") && !trimmed.includes(" ")) {
        const skillName = slashCommandName(trimmed);
        if (skillName && !isBuiltinSlashCommand(trimmed)) {
          const skill = await findSkillMd({ cwd, name: skillName });
          if (skill) {
            output.write(`Loaded SKILL.md for "${skill.name}" from ${skill.path}\n`);
            // Inject SKILL.md content into the session's system message (R2)
            const systemMsg = activeSession.messages[0];
            if (systemMsg && systemMsg.role === "system" && Array.isArray(systemMsg.content)) {
              const textBlock = systemMsg.content.find((b) => b?.kind === "text");
              if (textBlock) {
                textBlock.text += `\n\n## Injected Skill: ${skill.name}\n${skill.content}\n`;
              } else {
                systemMsg.content.push({ kind: "text", text: `## Injected Skill: ${skill.name}\n${skill.content}\n` });
              }
            }
            output.write(`Skill "/${skill.name}" is now active. You can ask questions related to this skill.\n`);
            return true;
          }
        }
        const menu = formatMenu(trimmed, { width: width() });
        if (menu) {
          output.write(menu);
          return true;
        }
      }
      // not a command → send to the model as a message
      return false;
    };

    // Executor: drain the queue one-at-a-time (FIFO). It never blocks the
    // input pump, so a message typed mid-turn is processed right after the
    // current turn finishes.
    const executor = (async () => {
      await drainTurnQueue({
        queue,
        dispatch,
        runMessage: runTurnMessage,
        // A wake is not user input (see turn-executor.mjs): it skips dispatch
        // and the @/! expansion, and is labelled on screen so the user can tell
        // an automatic resume from something they typed.
        runWake: async (text) => {
          const notice = WAKE_NOTICE_LINE;
          output.write(`${color() ? style("muted", notice) : notice}\n`);
          await sendToModel(text, { wake: true });
        }
      });
      // The pump closed the queue (EOF). Drain is complete, so now we may
      // actually leave — this is what makes piped input process every line.
      if (eofDeferred) await leave({ code: 0, reason: "eof" });
    })();

    // Input pump: the persistent, always-armed prompt. It only READS and
    // pushes — all turn execution and command output happens in the executor.
    const pump = (async () => {
      try {
        for (;;) {
          let line;
          try {
            line = await controller.question({
              prompt: renderPrompt({
                cwd,
                provider: activeSession.settings?.defaultProvider,
                model: resolveActiveModel(activeSession.settings),
                planMode: activeSession.planMode?.isActive(),
                approvalMode: activeSession.settings?.approvalMode,
                usage: sessionUsage(),
                // P4b-2: renderPrompt has dropped segments from the right since
                // P3b, but this call never passed a width, so its limit was
                // Infinity and nothing was ever dropped — the header wrapped on
                // every narrow terminal and desynced the editor's repaint.
                width: width(),
                color: color(),
                tty: process.stdout.isTTY === true
              }),
              // P3b-7: typing `/` (or `@`) opens the candidate list under the
              // input immediately — no Tab, no blind guessing — and ↑↓/Tab/Enter
              // drive it. The same source serves both, so they feel identical.
              completions: completionSource,
              menuWidth: width()
            });
          } catch (error) {
            // A disposed controller rejects its pending question with an
            // AbortError. That is a normal way to leave the REPL, so exit quietly
            // instead of surfacing a Node stack (P0-2).
            if (isUiControlError(error)) break;
            throw error;
          }
          // null = EOF (Ctrl+D on an empty buffer, or stdin closed). Defer the
          // leave to the executor so it can drain queued lines first (piped
          // input must not drop lines).
          if (line === null) {
            eofDeferred = true;
            break;
          }
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed === "/exit") {
            await exitCommand();
            // Without this the process used to hang after the goodbye line:
            // undici's keep-alive pool and MCP stdio children keep the loop alive.
            await leave({ code: 0, reason: "exit-command" });
            break;
          }
          if (!queue.push(trimmed)) break; // queue already closed (we are leaving)
        }
      } finally {
        queue.close();
      }
    })();

    await Promise.all([pump, executor]);
  } catch (error) {
    // Safety net: anything that reaches here and is really a UI event (an
    // interface closed under us, a cancelled prompt) leaves the loop quietly.
    if (!isUiControlError(error)) throw error;
  } finally {
    interruptHandle.dispose();
    process.removeListener("SIGTERM", onSigterm);
    output.removeListener?.("resize", onResize);
    // The session that survived the loop still holds a spinner interval and
    // event-bus subscriptions; the ones it replaced were torn down by
    // swapActiveSession as they were swapped out.
    disposeSessionRenderers(activeSession);
    // Leaving by ANY route — including an exception on the way out — must give
    // the terminal back: raw mode off, bracketed paste off, listeners removed.
    // (shutdown() already did this on its path; dispose() is idempotent.)
    await saveHistory();
    controller.dispose();
  }
}

function makeReplShellApprovalRequester({ controller }) {
  if (!controller) return null;
  return async ({ summary }) => {
    const answer = await controller.question({
      prompt: `Run shell '${summary}'? [y/N] `,
      level: 1,
      history: false,
      multiline: false
    });
    const normalized = (answer ?? "").trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  };
}

/**
 * `/terminal-setup` (P2-2b) — bind Shift+Enter to `ESC CR` in the host
 * terminal. NOTHING is written before the user has seen the exact diff and
 * answered `y`; existing bindings are left alone and modified files are backed
 * up (see adapters/tui/terminal-setup.mjs).
 */
async function runTerminalSetupCommand({ controller, output = process.stdout }) {
  const plan = await planTerminalSetup();
  if (!plan.supported) {
    output.write(`${plan.note}\n`);
    return;
  }
  const writable = plan.targets.filter((target) => target.action !== "skip");
  if (writable.length === 0) {
    output.write(`${plan.note}\n`);
    return;
  }
  output.write(`Detected terminal: ${plan.terminal}\nThe following changes will be made:\n\n`);
  for (const target of writable) {
    if (target.kind === "command") {
      output.write(`  $ ${target.command.map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(" ")}\n`);
      continue;
    }
    output.write(renderDiff({
      filePath: target.path,
      before: target.before,
      after: target.after,
      operation: target.action === "create" ? "create" : "update",
      colorize: supportsColor(output)
    }));
    if (target.action === "update") output.write(`  (a backup is written to ${target.path}.procway-backup-<timestamp>)\n`);
  }
  let answer;
  try {
    answer = await controller.question({
      prompt: "\nApply these changes? [y/N] ",
      level: 1,
      history: false,
      multiline: false
    });
  } catch {
    answer = null;
  }
  if (!/^y(es)?$/i.test((answer ?? "").trim())) {
    output.write(`Cancelled — nothing was written. ${CTRL_J_ADVICE}\n`);
    return;
  }
  const results = await applyTerminalSetup(plan);
  for (const result of results) {
    if (result.error) output.write(`  failed: ${result.path ?? result.command}: ${result.error}\n`);
    else if (result.applied) output.write(`  wrote ${result.path ?? result.command}${result.backup ? " (backed up)" : ""}\n`);
  }
  output.write(`${plan.note}\n`);
}

/**
 * `/mcp` — REPL dispatch for the MCP list / add / remove / reconnect subcommands.
 * Interactive prompting for `add` (the wizard) lives in `configureMcpInTui`;
 * the direct non-interactive form reuses the same core command and validation.
 */
async function handleMcpCommand({ controller, session, cwd, args = [], output = process.stdout }) {
  const sub = (args[0] ?? "").toLowerCase();
  const renderNow = async () => {
    const result = await mcpListCommand({ session });
    output.write(renderMcp(result, { width: terminalWidth(output), color: supportsColor(output) }));
  };
  if (sub === "" || sub === "list") {
    await renderNow();
    return;
  }
  if (sub === "add") {
    if (args.length === 1) {
      try {
        await configureMcpInTui({ controller, session, cwd });
      } catch (error) {
        // Ctrl+C inside a hidden prompt throws "Secret input cancelled" — a
        // user action, not a crash. Stay in the REPL.
        if (!isUiControlError(error)) throw error;
        output.write("MCP add cancelled.\n");
      }
      return;
    }
    const parsed = parseMcpAddArgs(args.slice(1));
    if (parsed.error) { output.write(`${parsed.error}\n`); return; }
    const result = await addMcpServer({ session, cwd, scope: parsed.scope, serverId: parsed.serverId, config: parsed.config });
    if (!result.ok) { output.write(`Not saved: ${result.errors.join("; ")}\n`); return; }
    output.write(`Added MCP server "${parsed.serverId}" (${parsed.transport}) and reconnected.\n`);
    await renderNow();
    return;
  }
  if (sub === "remove") {
    const id = args[1];
    if (!id) { output.write("Usage: /mcp remove <serverId>\n"); return; }
    const result = await removeMcpServer({ session, cwd, serverId: id });
    if (!result.ok) { output.write(`${result.error ?? "not removed"}\n`); return; }
    output.write(`Removed MCP server "${id}" and reconnected.\n`);
    await renderNow();
    return;
  }
  if (sub === "reconnect") {
    await session?.reconnectMcpTools?.();
    output.write("Reconnected MCP servers.\n");
    await renderNow();
    return;
  }
  output.write(`Unknown /mcp subcommand "${sub}". Try /mcp, /mcp add, /mcp add <id> <transport> [...], /mcp remove <id>, /mcp reconnect\n`);
}

/**
 * `/mcp add` — interactive wizard. Reads a server id, transport and the
 * transport-specific fields through the REPL controller, validates and
 * persists through the core command (which also reconnects the session).
 */
async function configureMcpInTui({ controller, session, cwd, output = process.stdout }) {
  const serverId = (await questionWithDefault(controller, "Server id (e.g. demo)", "demo")).trim();
  if (!serverId) { output.write("Server id cannot be empty.\n"); return; }
  const transport = (await questionWithDefault(controller, "Transport (stdio|http|sse)", "stdio")).trim().toLowerCase();
  const config = { transport };
  if (transport === "stdio") {
    const command = (await questionWithDefault(controller, "Command", "")).trim();
    config.command = command;
    const argsRaw = (await questionWithDefault(controller, "Args (space separated, optional)", "")).trim();
    if (argsRaw) config.args = argsRaw.split(/\s+/).filter(Boolean);
  } else if (transport === "http" || transport === "sse") {
    const baseUrl = (await questionWithDefault(controller, "Base URL", "")).trim();
    config.baseUrl = baseUrl;
    const headersRaw = (await questionWithDefault(controller, "Headers (k=v, comma separated, optional)", "")).trim();
    if (headersRaw) {
      const headers = {};
      for (const pair of headersRaw.split(",")) {
        const idx = pair.indexOf("=");
        if (idx === -1) continue;
        headers[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
      }
      if (Object.keys(headers).length > 0) config.headers = headers;
    }
  } else {
    output.write(`Transport must be one of: stdio, http, sse\n`);
    return;
  }
  const result = await addMcpServer({ session, cwd, scope: "workspace", serverId, config });
  if (!result.ok) {
    output.write(`Not saved:\n${result.errors.map((error) => `- ${error}`).join("\n")}\n`);
    return;
  }
  output.write(`Added MCP server "${serverId}" (${transport}) and reconnected. The next turn can use its tools.\n`);
  const list = await mcpListCommand({ session });
  output.write(renderMcp(list, { width: terminalWidth(output), color: supportsColor(output) }));
}

async function configureProviderInTui({ controller, cwd, settings, session, output: _output = process.stdout }) {
  const currentId = settings.defaultProvider ?? "openai-main";
  const current = settings.providers?.[currentId] ?? {};
  const providerId = (await questionWithDefault(controller, "Provider ID", currentId)).trim();
  const selected = settings.providers?.[providerId] ?? current;
  const type = (await questionWithDefault(controller, "Provider type", selected.type ?? "openai-compatible")).trim();
  const apiKeyEnv = (await questionWithDefault(controller, "API key environment name", selected.apiKeyEnv ?? "OPENAI_API_KEY")).trim();
  const baseUrl = (await questionWithDefault(controller, "Endpoint", selected.baseUrl ?? "https://api.openai.com/v1")).trim();
  const model = (await questionWithDefault(controller, "Model", selected.defaultModel ?? "gpt-5.4")).trim();
  const token = await questionHidden(controller, `API token for ${apiKeyEnv} (blank keeps the existing value): `);

  const provider = { ...selected, type, apiKeyEnv, baseUrl, defaultModel: model };
  const candidate = {
    ...settings,
    defaultProvider: providerId,
    providers: { ...(settings.providers ?? {}), [providerId]: provider }
  };
  const errors = validateSettings(candidate);
  if (errors.length > 0) {
    console.error(`Settings were not saved:\n${errors.map((error) => `- ${error}`).join("\n")}`);
    return;
  }

  await setSetting({ cwd, scope: "user", key: "defaultProvider", value: providerId });
  await setSetting({ cwd, scope: "user", key: `providers.${providerId}`, value: JSON.stringify(provider) });
  if (token) {
    await setSecret({ cwd, scope: "user", key: apiKeyEnv, value: token });
    process.env[apiKeyEnv] = token;
  }
  settings.defaultProvider = providerId;
  settings.providers = candidate.providers;
  if (session.settings !== settings) {
    session.settings.defaultProvider = providerId;
    session.settings.providers = candidate.providers;
  }
  console.log(`Saved ${providerId}:${model}. The next turn will use this provider.`);
}

async function questionWithDefault(controller, label, defaultValue) {
  const answer = await controller.question({
    prompt: `${label} [${defaultValue}]: `,
    level: 1,
    history: false,
    multiline: false
  });
  return (answer ?? "").trim() || defaultValue;
}

/**
 * P2-1: hidden input is a MODE of the one controller, not a second reader.
 * `secret-input.mjs`'s trick of stripping readline's `data` listeners (and
 * putting them back afterwards) exists only for the non-REPL
 * `config set-secret` path now.
 */
async function questionHidden(controller, prompt) {
  return (await controller.readSecret({ prompt })).trim();
}

/**
 * P3b-10: a failed turn now says what to DO. `Missing API key environment
 * variable: OPENROUTER_API_KEY` was true and useless; the panel points at
 * `/config setup`. Rate limits, auth rejections, network failures and the idle
 * watchdog each get their own guidance (adapters/tui/error-render.mjs).
 *
 * It goes to stdout because it is part of the conversation the user is
 * reading — a turn that failed is a turn, and redirecting stdout must not
 * silently swallow the reason.
 */
function printTurnError(error, { output = process.stdout, width = terminalWidth(output), color = supportsColor(output) } = {}) {
  output.write(renderTurnError(error, { width, color }));
}

async function compactSessionFromCli({ cwd, settings, sessionId, compactOptions = {} }) {
  await migrateLegacyFormatIfNeeded();
  const { sessions } = await listSessions({ cwd, limit: 200 });
  const selected = sessionId
    ? sessions.find((session) => session.sessionId === sessionId)
    : sessions[0];
  if (!selected) {
    console.log(sessions.length === 0 ? "No sessions found." : `Session not found: ${sessionId}`);
    return;
  }
  const state = await loadSessionState({ sessionId: selected.sessionId });
  const session = await createAgentSession({
    settings,
    cwd,
    sessionId: selected.sessionId,
    messages: state.messages ?? [],
    title: state.title
  });
  const result = await compactCommand({ session, args: compactOptions });
  console.log(JSON.stringify(result, null, 2));
}

async function checkoutSession({ cwd, settings, sessionId, controller = null }) {
  await migrateLegacyFormatIfNeeded();
  let state;
  try {
    state = await loadSessionState({ sessionId });
  } catch {
    console.log(`Session not found: ${sessionId}`);
    return null;
  }
  return createReplSession({
    cwd,
    settings,
    controller,
    sessionId,
    messages: state.messages ?? [],
    title: state.title,
    procwayMeta: state.procwayMeta ?? null,
    pendingTaskCompletionReminder: Boolean(state.pendingTaskCompletionReminder)
  });
}

async function pickAndCreateSession({ cwd, settings, controller = null }) {
  await migrateLegacyFormatIfNeeded();
  const { sessions } = await listSessions({ cwd, limit: 200 });
  if (sessions.length === 0) {
    console.log("No sessions found.");
    return null;
  }
  const picked = await pickSession({ sessions, input, output, controller });
  if (!picked) {
    console.log("Resume cancelled.");
    return null;
  }
  const state = await loadSessionState({ sessionId: picked.sessionId });
  return createReplSession({
    cwd,
    settings,
    controller,
    sessionId: picked.sessionId,
    messages: state.messages ?? [],
    title: state.title,
    procwayMeta: state.procwayMeta ?? null,
    pendingTaskCompletionReminder: Boolean(state.pendingTaskCompletionReminder)
  });
}

async function runServe({ cwd, repoRoot, settings, port, host }) {
  let handle;
  try {
    handle = await startServer({
      cwd,
      settings,
      port,
      host,
      onWarn: (message) => console.warn(`[WARNING] ${message}`),
      onLog: (message) => console.log(message)
    });
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
    return;
  }
  console.log(`Open http://${handle.host}:${handle.port}/?token=$PROCWAY_SERVE_TOKEN to connect.`);

  // Dashboard-distributed user env vars (issue #30): apply once at startup so
  // the first tool spawn already sees them, then keep them live through the
  // hot-reload watcher below. The manager tracks applied keys so deletions in
  // the snapshot delete from process.env too.
  const userEnv = createUserEnvManager({
    workspaceDir: repoRoot ?? cwd,
    // ADR 0024 Phase 2/3: the active-project marker must be WRITABLE by the agent.
    // The shared workspace (repoRoot) is mounted read-only, so the marker lives in
    // the per-session scratch (PROCWAY_WORKSPACE_DIR, e.g. /workspace).
    markerDir: process.env.PROCWAY_WORKSPACE_DIR || cwd,
    onWarn: (message) => console.warn(`[user-env] ${message}`)
  });
  try {
    const initial = await userEnv.reload();
    if (initial && (initial.applied.length > 0 || initial.removed.length > 0)) {
      console.log(`[user-env] applied ${initial.applied.length} vars from ${userEnv.path}`);
    }
  } catch (error) {
    console.warn(`[user-env] initial apply failed: ${error?.message ?? error}`);
  }

  // Hot-reload settings.json / secrets.json / user-env.json so dashboard edits
  // take effect on the next turn without a process restart. Sessions read
  // settings by reference, so mutating in place is enough.
  const hotReload = startSettingsHotReload({
    cwd,
    repoRoot,
    settings,
    applyUserEnvImpl: () => userEnv.reload(),
    onApplied: ({ keys, appliedSecrets, userEnv: userEnvResult }) => {
      // Settings/secrets may have changed what the display-tool probe would
      // see (settings.tools.browser, AGENT_BROWSER_EXECUTABLE_PATH, DISPLAY
      // via secrets.json) — drop the cached verdict so NEW sessions re-probe
      // (ADR 0030 D5).
      invalidateDisplayToolAvailability();
      const parts = [`settings reloaded (${keys.length} keys)`];
      if (appliedSecrets.length > 0) parts.push(`secrets: ${appliedSecrets.length}`);
      if (userEnvResult && (userEnvResult.applied.length > 0 || userEnvResult.removed.length > 0)) {
        parts.push(`user-env: +${userEnvResult.applied.length}/-${userEnvResult.removed.length}`);
      }
      console.log(`[hot-reload] ${parts.join(", ")}`);
    },
    onWarn: (message) => console.warn(`[hot-reload] ${message}`),
    onError: (error) => console.error(`[hot-reload] failed: ${error?.message ?? error}`)
  });

  await new Promise((resolve) => {
    const shutdown = async (signal) => {
      console.log(`Received ${signal}, closing serve…`);
      try { hotReload.close(); } catch { /* ignore */ }
      try { await handle.close(); } catch { /* ignore */ }
      resolve();
    };
    process.once("SIGINT", () => { shutdown("SIGINT"); });
    process.once("SIGTERM", () => { shutdown("SIGTERM"); });
  });
}

/**
 * Interactive = a human is watching a terminal. Stacks are noise there; they
 * are signal for `serve`, CI and piped runs (where the dashboard relays them).
 * `PROCWAY_DEBUG=1` forces the verbose form back on.
 */
function isDebugMode() {
  const value = process.env.PROCWAY_DEBUG;
  return typeof value === "string" && value !== "" && value !== "0" && value !== "false";
}

function isInteractiveTerminal() {
  return process.stdout.isTTY === true || process.stderr.isTTY === true;
}

// Surface fatal crashes as a structured stderr line the dashboard relays to
// Sentry (ADR 0013 T1-16) — the container itself never talks to Sentry. In an
// interactive TUI the marker line still goes out (relay contract unchanged,
// docs/host-contract.md) but without the stack, so users never see a raw
// Node trace mid-session.
installCrashHandlers({ includeStack: isDebugMode() || !isInteractiveTerminal() });

main().catch((error) => {
  if (isUiControlError(error)) {
    // Ctrl+C / Ctrl+D during a prompt is a normal way to quit.
    process.exitCode = 0;
    return;
  }
  if (isInteractiveTerminal() && !isDebugMode()) {
    console.error(error?.message ?? String(error));
    console.error("Run with PROCWAY_DEBUG=1 for the full stack trace.");
  } else {
    console.error(error?.stack ?? error?.message ?? String(error));
  }
  process.exitCode = 1;
});
