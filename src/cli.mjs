#!/usr/bin/env node
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";
import { installCrashHandlers } from "./telemetry/crash-reporter.mjs";
import { loadSettings } from "./config/load-settings.mjs";
import { applySecretsFromFiles } from "./config/load-secrets.mjs";
import { startSettingsHotReload } from "./config/hot-reload.mjs";
import { createUserEnvManager } from "./config/user-env.mjs";
import { validateSettings } from "./config/schema.mjs";
import { initSettings } from "./config/init-settings.mjs";
import { setWorkspaceSetting } from "./config/workspace-settings.mjs";
import { resolveActiveModel } from "./config/active-model.mjs";
import { runAgent } from "./agent/loop.mjs";
import { getSharedShellManager } from "./tools/shell-manager.mjs";
import { invalidateDisplayToolAvailability } from "./tools/registry.mjs";
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
  branchCommand
} from "./core/index.mjs";
import { migrateLegacyFormatIfNeeded } from "./session/migration.mjs";
import { listSessions, loadSessionState } from "./session/store.mjs";
import { createTimelineRenderer } from "./adapters/tui/timeline-renderer.mjs";
import { pickSession } from "./adapters/tui/session-picker.mjs";
import { printTranscript, renderTranscript } from "./adapters/tui/markdown-render.mjs";
import { attachApprovalPrompt } from "./adapters/tui/approval-prompt.mjs";
import { createStreamingRenderer } from "./adapters/tui/streaming-renderer.mjs";
import { attachInterruptHandler } from "./adapters/tui/interrupt.mjs";
import { attachTodoRenderer, renderTodoSummary } from "./adapters/tui/todo-render.mjs";
import { createSlashCompleter, formatMenu, findSkillMd, isBuiltinSlashCommand, slashCommandName } from "./adapters/tui/slash-completion.mjs";
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
      console.error(error?.message ?? String(error));
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
        parsed.initSettings = "workspace";
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
  procway-code --init-settings workspace
  procway-code resume [sessionId]
  procway-code compact [sessionId]
  procway-code config
  procway-code config set providers.<id>.defaultModel model-id
  procway-code model set model-id
  procway-code serve [--port 7777] [--host 127.0.0.1]
    PROCWAY_SERVE_TOKEN=<token> required; bind 0.0.0.0 to expose to LAN.
  procway-code auth login [provider] [--profile <id>] [--originator <name>]
  procway-code auth status [profile]
  procway-code auth logout <profile>

Options:
  --cwd <path>
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
    width: process.stdout.columns ?? 80,
    colorize: process.stdout.isTTY === true
  });
  streamRenderer.attach(events);
  events.on("assistant.message.completed", (event) => {
    if (streamRenderer.isStreaming() || streamRenderer.hadOutput()) return;
    if (Array.isArray(event.content)) {
      const text = event.content
        .filter((b) => b?.kind === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("");
      if (text) process.stdout.write(`${text}${text.endsWith("\n") ? "" : "\n"}`);
    }
  });
  try {
    await runAgent({ settings, prompt, cwd, events });
    process.exitCode = 0;
  } catch (error) {
    console.error(error.message);
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

async function runRepl({ cwd, settings }) {
  const rl = readline.createInterface({
    input,
    output,
    completer: makeReplCompleter()
  });
  const session = await createReplSession({ cwd, settings, rl });
  console.log("procway-code TUI");
  console.log(`Session: ${session.sessionId}`);
  if (session.planMode?.isActive()) console.log("Plan mode: ON (write tools will queue for end-of-turn approval)");
  printReplCommands();
  try {
    await runConversationLoop({ rl, cwd, settings, session });
  } finally {
    rl.close();
  }
}

async function createReplSession({ cwd, settings, sessionId, messages = [], title = null, rl = null, procwayMeta = null, pendingTaskCompletionReminder = false }) {
  const events = new EventBus();
  const streamRenderer = createStreamingRenderer({
    writer: output,
    width: output.columns ?? 80,
    colorize: output.isTTY === true
  });
  streamRenderer.attach(events);
  events.on("assistant.message.completed", (event) => {
    if (streamRenderer.isStreaming() || streamRenderer.hadOutput()) return;
    output.write(renderTranscript([{ role: "assistant", content: event.content }], { maxMessages: 1 }));
  });
  const renderer = createTimelineRenderer({ enabled: true });
  renderer.attach(events);
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
  attachApprovalPrompt({ session, input, output, rl });
  attachTodoRenderer({ session, output });
  session.timelineRenderer = renderer;
  session.streamingRenderer = streamRenderer;
  return session;
}

function makeReplCompleter() {
  const slashComplete = createSlashCompleter();
  return function completer(line) {
    if (!line.startsWith("/")) return [[], line];
    const [matches, head] = slashComplete(line);
    if (matches.length === 0) return [[], head];
    return [matches, head];
  };
}

async function handleConfigCommand({ args, cwd, settings, sources }) {
  const [subcommand, key, value] = args.positional;
  if (!subcommand) {
    console.log(JSON.stringify({ settings, sources }, null, 2));
    return;
  }
  if (subcommand === "set") {
    if (!key || value == null) throw new Error("Usage: procway-code config set <key> <value>");
    console.log(JSON.stringify(await setWorkspaceSetting({ cwd, key, value }), null, 2));
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
    console.log(JSON.stringify(await setWorkspaceSetting({ cwd, key, value: model }), null, 2));
    return;
  }
  throw new Error(`Unknown model command: ${subcommand}`);
}

async function resumeSession({ cwd, settings, sessionId }) {
  await migrateLegacyFormatIfNeeded();
  const { sessions } = await listSessions({ cwd, limit: 200 });
  const picked = sessionId ? sessions.find((session) => session.sessionId === sessionId) : await pickSession({ sessions, input, output });
  const resolvedSessionId = picked?.sessionId ?? sessionId;
  if (!resolvedSessionId) {
    console.log(sessions.length === 0 ? "No sessions found." : "Resume cancelled.");
    return;
  }
  const { state } = await resumeCommand({ cwd, sessionId: resolvedSessionId });
  const rl = readline.createInterface({ input, output, completer: makeReplCompleter() });
  const session = await createReplSession({
    cwd,
    settings,
    sessionId: resolvedSessionId,
    messages: state.messages ?? [],
    title: state.title,
    rl
  });
  console.log(`Resumed session: ${resolvedSessionId}`);
  printTranscript({ messages: session.messages, output, markdown: output.isTTY === true });
  printReplCommands();
  try {
    await runConversationLoop({ rl, cwd, settings, session });
  } finally {
    rl.close();
  }
}

async function runConversationLoop({ rl, cwd, settings, session }) {
  let activeSession = session;
  const interruptHandle = attachInterruptHandler({ session: activeSession, output: process.stderr });
  try {
    while (true) {
      const line = await rl.question("> ");
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed === "/exit") {
        await exitCommand();
        break;
      }
      if (trimmed === "/config") {
        const result = await configCommand({ session: activeSession });
        console.log(JSON.stringify(result.settings, null, 2));
        continue;
      }
      if (trimmed === "/model") {
        const result = await modelCommand({ session: activeSession });
        console.log(`${result.provider}:${result.model}`);
        continue;
      }
      if (trimmed === "/history") {
        const result = await historyCommand({ session: activeSession });
        output.write(renderTranscript(messagesForRender(activeSession.messages)));
        void result;
        continue;
      }
      if (trimmed === "/usage") {
        const result = await usageCommand({ session: activeSession });
        console.log(JSON.stringify(result, null, 2));
        continue;
      }
      if (trimmed.startsWith("/compact")) {
        const result = await compactCommand({ session: activeSession, args: trimmed.split(/\s+/).slice(1) });
        console.log(JSON.stringify(result, null, 2));
        continue;
      }
      if (trimmed === "/resume") {
        const resumed = await pickAndCreateSession({ cwd, settings });
        if (resumed) {
          activeSession = resumed;
          console.log(`Resumed session: ${activeSession.sessionId}`);
          printTranscript({ messages: activeSession.messages, output });
        }
        continue;
      }
      if (trimmed.startsWith("/checkout")) {
        const targetId = trimmed.split(/\s+/).slice(1).join(" ").trim();
        if (!targetId) {
          console.log("Usage: /checkout <sessionId>");
          continue;
        }
        const checkedOut = await checkoutSession({ cwd, settings, sessionId: targetId });
        if (checkedOut) {
          activeSession = checkedOut;
          console.log(`Checked out session: ${activeSession.sessionId}`);
          printTranscript({ messages: activeSession.messages, output, markdown: output.isTTY === true });
        }
        continue;
      }
      if (trimmed === "/context") {
        const result = await contextCommand({ cwd, settings });
        console.log(JSON.stringify(result, null, 2));
        continue;
      }
      if (trimmed === "/plan" || trimmed.startsWith("/plan ")) {
        const result = await planCommand({ session: activeSession, args: trimmed.split(/\s+/).slice(1) });
        console.log(JSON.stringify(result, null, 2));
        continue;
      }
      if (trimmed === "/todos") {
        const result = await todosCommand({ session: activeSession });
        const summary = renderTodoSummary(result.todos ?? []);
        if (summary) console.log(summary);
        console.log(JSON.stringify(result, null, 2));
        continue;
      }
      if (trimmed === "/memory") {
        const result = await memoryCommand({ session: activeSession });
        console.log(JSON.stringify(result, null, 2));
        continue;
      }
      if (trimmed.startsWith("/branch")) {
        const result = await branchCommand({ session: activeSession, args: trimmed.split(/\s+/).slice(1) });
        console.log(JSON.stringify(result, null, 2));
        continue;
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
            console.log(`Skill "/${skill.name}" is now active. You can ask questions related to this skill.`);
            continue;
          }
        }
        const menu = formatMenu(trimmed, { width: output.columns ?? 80 });
        if (menu) {
          output.write(menu);
          continue;
        }
      }
      let prompt = trimmed;
      if (prompt.includes("@") || prompt.includes("!")) {
        try {
          const expanded = await expandInput({
            line: prompt,
            cwd,
            permissions: settings?.permissions ?? null,
            approvalRequester: makeReplShellApprovalRequester({ rl })
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
                process.stderr.write(`${note}\n`);
              } else if (item.kind === "shell") {
                process.stderr.write(`[!${item.command} → exit ${item.exitCode}]\n`);
                // Echo the actual command output so the user sees what the
                // LLM is going to read. stdout → stdout, stderr → stderr to
                // mirror normal shell semantics.
                if (item.stdout) {
                  process.stdout.write(item.stdout);
                  if (!item.stdout.endsWith("\n")) process.stdout.write("\n");
                }
                if (item.stderr) {
                  process.stderr.write(item.stderr);
                  if (!item.stderr.endsWith("\n")) process.stderr.write("\n");
                }
              }
            }
          }
        } catch {
          // expansion is best-effort; fall back to raw input
        }
      }
      try {
        await activeSession.runTurn(prompt);
      } catch (error) {
        printTurnError(error);
      }
    }
  } finally {
    interruptHandle.dispose();
  }
}

function messagesForRender(messages) {
  return Array.isArray(messages) ? messages : [];
}

function makeReplShellApprovalRequester({ rl }) {
  if (!rl) return null;
  return async ({ summary }) => {
    const answer = (await rl.question(`Run shell '${summary}'? [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  };
}

function printTurnError(error) {
  const status = error?.status ? ` (${error.status})` : "";
  const retryHint = error?.retryable ? "\nThe request may succeed if you retry shortly or switch models/providers." : "";
  console.error(`Turn failed${status}: ${error?.message ?? String(error)}${retryHint}`);
}

function printReplCommands() {
  console.log("Commands: /branch, /compact, /config, /context, /history, /memory, /model, /plan, /resume, /todos, /usage, /exit");
  console.log("Inline:   @<path> attaches a file, !<command> attaches shell output");
  console.log("Hint:     type / and press Tab to autocomplete a slash command");
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

async function checkoutSession({ cwd, settings, sessionId }) {
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
    sessionId,
    messages: state.messages ?? [],
    title: state.title,
    procwayMeta: state.procwayMeta ?? null,
    pendingTaskCompletionReminder: Boolean(state.pendingTaskCompletionReminder)
  });
}

async function pickAndCreateSession({ cwd, settings }) {
  await migrateLegacyFormatIfNeeded();
  const { sessions } = await listSessions({ cwd, limit: 200 });
  if (sessions.length === 0) {
    console.log("No sessions found.");
    return null;
  }
  const picked = await pickSession({ sessions, input, output });
  if (!picked) {
    console.log("Resume cancelled.");
    return null;
  }
  const state = await loadSessionState({ sessionId: picked.sessionId });
  return createReplSession({
    cwd,
    settings,
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

// Surface fatal crashes as a structured stderr line the dashboard relays to
// Sentry (ADR 0013 T1-16) — the container itself never talks to Sentry.
installCrashHandlers();

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
