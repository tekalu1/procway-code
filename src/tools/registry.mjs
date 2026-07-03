import { applyUnifiedPatch, listFiles, readTextFile, searchFiles, writeTextFile } from "./filesystem.mjs";
import { editFile } from "./edit.mjs";
import { runGlob } from "./glob.mjs";
import { runGrep } from "./grep.mjs";
import { runShell, runShellKill, runShellLogs, runShellStatus, runShellWait } from "./shell.mjs";
import { getSharedJobRegistry } from "../jobs/delegated-jobs.mjs";
import { createAgentDriver } from "../jobs/agent-driver.mjs";
import { runWebFetch, runWebSearch } from "./web-search.mjs";
import { loadProjectEnv } from "./project-env.mjs";
import { runWebBrowserAction, isWebBrowserMutationStep, getWebBrowserAvailability } from "./web-browser.mjs";
import { runDesktopAction, getDesktopActionAvailability } from "./desktop.mjs";
import { viewImage } from "./view-image.mjs";
import { saveAttachment } from "./save-attachment.mjs";
import { attachFile } from "./attach-file.mjs";
import { startRun, getRunStatus, resumeRun, replyRun } from "./run-control.mjs";
import { askImage } from "./ask-image.mjs";
import { providerSupportsVision, resolveVisionProviderId } from "../providers/vision.mjs";
import * as jiraTools from "./integrations/jira.mjs";
import * as confluenceTools from "./integrations/confluence.mjs";
import * as slackTools from "./integrations/slack.mjs";
import { IntegrationApiError, IntegrationNotConnectedError } from "./integrations/_auth.mjs";
import { classifyCommand } from "../safety/command-classifier.mjs";
import { requestApproval } from "../safety/approval.mjs";
import { createSafeFetch } from "../safety/safe-fetch.mjs";
import { getProxyAwareFetch } from "../safety/proxy-fetch.mjs";
import { isToolResult } from "../core/types/tool-result.mjs";
import { writeMemory as writeMemoryFile, loadMemoryIndex } from "../memory/store.mjs";
import { readFile } from "node:fs/promises";
import path from "node:path";

async function readPriorContent(cwd, filePath) {
  if (!filePath) return null;
  try {
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
    return await readFile(resolved, "utf8");
  } catch {
    return null;
  }
}

function simulateEdit(before, oldString, newString, replaceAll) {
  if (typeof before !== "string" || typeof oldString !== "string" || typeof newString !== "string") return null;
  if (replaceAll) return before.split(oldString).join(newString);
  const idx = before.indexOf(oldString);
  if (idx === -1) return before;
  return `${before.slice(0, idx)}${newString}${before.slice(idx + oldString.length)}`;
}

/**
 * Deferred tool tier — token-cost reduction (2026-06-07 audit).
 *
 * The full 33-tool catalog serializes to ~19KB of JSON and is re-sent to the
 * provider on EVERY round of EVERY session. The heavy, rarely-used tail
 * (browser/desktop/background jobs/Atlassian, ~9.8KB combined) is therefore
 * NOT sent by default: the model sees only a one-line summary per tool inside
 * the `load_tools` meta-tool description, and full schemas are appended to
 * the tool list only after the session loads them.
 *
 * Robustness: deferral only shapes what schemas are SENT — dispatch in
 * `executeToolCall` never checks it. A model that calls a deferred tool
 * directly (it knows the name from the summary list) is executed normally
 * and the tool is auto-loaded for subsequent rounds (conversation.mjs
 * `#noteDeferredTools`), so a model that skips `load_tools` loses nothing.
 *
 * Prompt-cache stability: loaded schemas are APPENDED in load order after
 * the `load_tools` definition, and the summary list inside `load_tools` is
 * static — the tools-array prefix stays byte-identical across rounds, which
 * is what DeepSeek auto-caching / future cache_control breakpoints key on.
 * Kill switch: `settings.tools.deferredLoading = false` restores the full
 * catalog.
 */
const DEFERRED_TOOL_SUMMARIES = Object.freeze({
  web_browser: "drive a persistent HEADED browser visible in the noVNC desktop — renders real pixels, the right tool for 'open this page in a browser' / viewing rendered web pages (navigate/click/fill/snapshot/screenshot)",
  desktop_action: "control the OS-level virtual desktop via xdotool/scrot (raw mouse/keyboard/screenshot) — NOT a browser",
  shell_job: "manage long-running background shell jobs (start/status/logs/wait/kill)",
  jira_list_projects: "list Jira projects",
  jira_search_issues: "search Jira issues with JQL",
  jira_get_issue: "get a Jira issue",
  jira_list_transitions: "list transitions for a Jira issue",
  jira_create_issue: "create a Jira issue",
  jira_update_issue: "update a Jira issue",
  jira_add_comment: "comment on a Jira issue",
  jira_transition_issue: "transition a Jira issue",
  confluence_list_spaces: "list Confluence spaces",
  confluence_search: "search Confluence with CQL",
  confluence_get_page: "get a Confluence page",
  confluence_create_page: "create a Confluence page",
  confluence_update_page: "update a Confluence page",
  slack_list_channels: "list Slack public channels",
  slack_read_channel: "read recent messages in a Slack channel",
  slack_read_thread: "read a Slack thread",
  slack_post_message: "post a Slack message",
  save_attachment: "save a message attachment (by attachment id) into the workspace as a file",
  attach_file: "attach a workspace file to the conversation (renders in chat; reflected to connected surfaces)",
  load_project_env: "switch the ACTIVE project whose env vars are loaded into your shell (for multi-project sessions, e.g. Slack) — pass a project name; the project's env vars become available to subsequent run_shell commands. Returns the now-available env var NAMES (values, especially secrets, are never shown)"
});

export const DEFERRED_TOOL_NAMES = new Set(Object.keys(DEFERRED_TOOL_SUMMARIES));

/**
 * Optional display-dependent tools (ADR 0030 D5). `web_browser` /
 * `desktop_action` require an X display plus backing binaries that only the
 * reference runtime image guarantees; a self-hosted procway-code on a bare
 * host must degrade cleanly. Availability is probed once and cached (probing
 * per call would stat PATH on every model round): unavailable tools are
 * dropped from the catalog AND from the `load_tools` summary, so the model
 * never sees them. One warn line reports what was disabled and why, so
 * self-hosters can diagnose (install xdotool/scrot/agent-browser/chromium
 * or export DISPLAY to re-enable). The cache is dropped on settings/secrets
 * hot-reload via invalidateDisplayToolAvailability (serve wires it), so a
 * fix applied through secrets.json — e.g. AGENT_BROWSER_EXECUTABLE_PATH —
 * re-enables the tools for NEW sessions without a process restart; embedding
 * hosts that mutate process.env after startup can call it directly. The
 * web_browser probe also honors settings.tools.browser overrides
 * (binary/executablePath/display/headed), mirroring what execution-time
 * buildEnv resolves. Detectors + logger are injectable for tests; the cached
 * default path is what production consumers hit.
 */
let displayToolAvailabilityCache = null;
export function detectDisplayToolAvailability({
  settings,
  desktopAvailability = getDesktopActionAvailability,
  webBrowserAvailability = getWebBrowserAvailability,
  logger = (line) => console.warn(line)
} = {}) {
  const availability = {
    web_browser: webBrowserAvailability({ settings }),
    desktop_action: desktopAvailability()
  };
  const disabled = Object.entries(availability).filter(([, entry]) => entry?.available === false);
  if (disabled.length > 0) {
    logger(`[tools] disabled (unsupported environment): ${disabled.map(([name, entry]) => `${name} — ${entry.reason}`).join("; ")} — re-probed on settings/secrets hot-reload, otherwise restart to re-enable`);
  }
  return availability;
}

function resolveDisplayToolAvailability(settings) {
  if (!displayToolAvailabilityCache) displayToolAvailabilityCache = detectDisplayToolAvailability({ settings });
  return displayToolAvailabilityCache;
}

/**
 * Drop the cached availability so the next registration re-probes the
 * environment. Called by the serve hot-reload after secrets/user-env are
 * re-applied to process.env; exported for embedding hosts too.
 */
export function invalidateDisplayToolAvailability() {
  displayToolAvailabilityCache = null;
}

// The summary list only names AVAILABLE deferred tools (availability is
// cached, changing only on hot-reload re-probe, so the description — and with
// it the tools-array prefix the prompt cache keys on — stays byte-identical
// across rounds).
function buildLoadToolsDefinition(availability) {
  return {
    type: "function",
    function: {
      name: "load_tools",
      description: "Load additional tools into this session. These tools exist but their full schemas are withheld to save context: "
        + Object.entries(DEFERRED_TOOL_SUMMARIES)
          .filter(([name]) => availability?.[name]?.available !== false)
          .map(([name, summary]) => `${name} (${summary})`).join("; ")
        + ". Call load_tools with the names you need and their full schemas become available from the next round. Calling a listed tool directly also works — it is auto-loaded on first use.",
      parameters: {
        type: "object",
        properties: {
          names: {
            type: "array",
            items: { type: "string" },
            description: "Deferred tool names to load (from the list in this description)."
          }
        },
        required: ["names"]
      }
    }
  };
}

/**
 * Shape the tool list for one model round: core tools (schemas always sent)
 * + `load_tools` + any deferred tools the session has loaded, appended in
 * load order. Pass-through when disabled. Unknown names in `loadedTools`
 * (e.g. a tool removed in a newer build) are ignored.
 */
export function selectToolDefinitions(definitions, { loadedTools = [], enabled = true, settings, availability = resolveDisplayToolAvailability(settings) } = {}) {
  if (!enabled) return definitions ?? [];
  const all = definitions ?? [];
  const core = all.filter((tool) => !DEFERRED_TOOL_NAMES.has(tool?.function?.name));
  const byName = new Map(all.map((tool) => [tool?.function?.name, tool]));
  const loaded = [];
  const seen = new Set();
  for (const name of loadedTools) {
    if (!DEFERRED_TOOL_NAMES.has(name) || seen.has(name)) continue;
    seen.add(name);
    const def = byName.get(name);
    if (def) loaded.push(def);
  }
  return [...core, buildLoadToolsDefinition(availability), ...loaded];
}

export function getToolDefinitions({ settings, availability = resolveDisplayToolAvailability(settings) } = {}) {
  return [
    {
      type: "function",
      function: {
        name: "request_user_action",
        description: "Ask the user for structured input and (when blocking) wait for their response. This is NOT an approval gate — use it to have the user fill a form, pick an option, set values, or confirm a choice. The user's answer is returned as JSON in the tool result. Supported kinds: 'survey' (ask one or more questions at once, each option may be marked recommended — use this to elicit requirements instead of asking in plain prose), 'env_vars' (ask the user to set env vars/secrets — you receive only which keys were set, never their values), 'approval' (ask the user to approve something for the current ticket task — records worker-proof evidence the checkAgent trusts).",
        parameters: {
          type: "object",
          properties: {
            kind: { type: "string", description: "Interaction kind: 'survey' | 'env_vars' | 'approval'." },
            summary: { type: "string", description: "One-line, human-readable description of what you are asking for and why." },
            spec: {
              type: "object",
              description: "Kind-specific UI descriptor. survey: { questions: [{ id, prompt, type: 'single'|'multi'|'text', options?: [{ label, value, recommended?, description? }], allowFreeText?, required? }] } — questions are OPTIONAL by default; set required:true only on the answers you truly need (the user can submit leaving optional ones blank). env_vars: { keys: [{ key, label?, isSecret?, scope: 'tenant'|'project', scopeId? }] }. approval: { subject, detail?, project, ticket, taskId, checklistItemId? } (project/ticket/taskId are required to record the approval)."
            },
            blocking: { type: "boolean", description: "Wait for the user's response before continuing (default true). When false, fire-and-forget." }
          },
          required: ["kind"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "list_files",
        description: "List files and directories on the agent's filesystem (read-only access; tickets often need to list ../ or knowledge/ from the ticket dir above cwd).",
        parameters: {
          type: "object",
          properties: {
            dirPath: { type: "string", description: "Workspace-relative directory path. Defaults to ." }
          },
          required: []
        }
      }
    },
    {
      type: "function",
      function: {
        name: "view_image",
        description: "Load an image file from the workspace so you can actually SEE it (vision). Use this to inspect screenshots, diagrams, design mockups, or any image evidence — e.g. after web_browser/desktop_action saves a screenshot, view_image the saved path to read what's on screen. Supported formats: png, jpeg, gif, webp.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path to the image file (workspace-relative or absolute)." }
          },
          required: ["path"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "ask_image",
        description: "Ask a vision-capable AI a specific question about an image file and get its answer as text (the image itself never enters this conversation). Use this to inspect screenshots, diagrams, design mockups, or any image evidence — e.g. after web_browser/desktop_action saves a screenshot, ask_image the saved path with a focused question like 'read the error message' or 'which button is highlighted and where is it?'. Be specific in the prompt: the vision AI sees only the image and your question. Supported formats: png, jpeg, gif, webp.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path to the image file (workspace-relative or absolute)." },
            prompt: { type: "string", description: "The question to ask about the image. Include all context the vision AI needs — it cannot see this conversation." }
          },
          required: ["path", "prompt"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "spawn_agent",
        description: "Run a bounded child coding agent task. The child can inspect the workspace and returns its final text result.",
        parameters: {
          type: "object",
          properties: {
            task: { type: "string", description: "Concrete task for the child agent." },
            cwd: { type: "string", description: "Optional workspace-relative cwd for the child agent." }
          },
          required: ["task"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Write a UTF-8 text file inside the workspace. Requires approval.",
        parameters: {
          type: "object",
          properties: {
            filePath: { type: "string", description: "Workspace-relative file path." },
            content: { type: "string", description: "Full file content to write." }
          },
          required: ["filePath", "content"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "apply_patch",
        description: "Apply a unified diff patch to existing text files inside the workspace. Requires approval.",
        parameters: {
          type: "object",
          properties: {
            patch: { type: "string", description: "Unified diff patch." }
          },
          required: ["patch"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "Edit",
        description: "Replace exactly one occurrence (or all occurrences with replace_all) of old_string in a workspace file. The match is exact and case-sensitive.",
        parameters: {
          type: "object",
          properties: {
            filePath: { type: "string", description: "Workspace-relative file path." },
            oldString: { type: "string", description: "The exact substring to replace." },
            newString: { type: "string", description: "The replacement substring. Must differ from oldString." },
            replaceAll: { type: "boolean", description: "Replace every occurrence instead of requiring exactly one." }
          },
          required: ["filePath", "oldString", "newString"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a UTF-8 text file on the agent's filesystem (read-only access; tickets often need to read ../memo.md or knowledge/ from the ticket dir above cwd). Large files are windowed: a truncated result tells you the offset to continue from.",
        parameters: {
          type: "object",
          properties: {
            filePath: { type: "string", description: "Workspace-relative file path." },
            maxBytes: { type: "number", description: "Maximum content length to return (default 64000)." },
            offset: { type: "number", description: "Character offset to start reading from (for paging large files)." }
          },
          required: ["filePath"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "search_files",
        description: "Search text files on the agent's filesystem for an exact substring (read-only access; tickets often need to search ../ or knowledge/ from the ticket dir above cwd).",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Exact substring to search for." },
            dirPath: { type: "string", description: "Workspace-relative directory path. Defaults to ." },
            maxResults: { type: "number", description: "Maximum number of matches to return." }
          },
          required: ["query"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "Glob",
        description: "Find workspace files by glob pattern (*, **, ?, {a,b}). Honours .gitignore via ripgrep when available.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Glob pattern, e.g. **/*.mjs" },
            dirPath: { type: "string", description: "Workspace-relative directory path. Defaults to ." },
            maxResults: { type: "number", description: "Maximum number of paths to return." }
          },
          required: ["pattern"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "Grep",
        description: "Search workspace text files with a JavaScript regex. Honours .gitignore via ripgrep when available.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Regex pattern. JS regex syntax (`new RegExp`)." },
            dirPath: { type: "string", description: "Workspace-relative directory path. Defaults to ." },
            glob: { type: "string", description: "Optional glob filter applied to file names." },
            maxResults: { type: "number", description: "Maximum number of matching lines to return." },
            contextLines: { type: "number", description: "Lines of context to include with ripgrep." },
            caseInsensitive: { type: "boolean", description: "Match case-insensitively." }
          },
          required: ["pattern"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "run_shell",
        description: "Run a non-interactive shell command in the workspace and wait for it to finish (default — finite commands like installs, builds, tests, and `procway task complete` should run in the FOREGROUND; output streams as progress so long commands are safe). Destructive, network, install, and redirection commands require user approval. Set runInBackground:true ONLY for processes that never exit (dev servers, watchers) or are expected to outlast ~25 minutes; manage those via shell_job (status/logs/wait/kill).",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "Shell command to run." },
            timeoutMs: { type: "number", description: "Foreground timeout in milliseconds (default 300000). Raise for known-slow commands. (procway `run loop` / `run task` drives auto-extend to a multi-hour ceiling — no need to set this for them.)" },
            runInBackground: { type: "boolean", description: "Detach and return a shellId immediately. ONLY for never-exiting / very long processes." }
          },
          required: ["command"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "shell_job",
        description: "Manage a background shell started by run_shell with runInBackground:true. action=status: inspect liveness/exit code. action=logs: read accumulated stdout/stderr. action=wait: BLOCK until the job exits (preferred over polling status in a loop — one call instead of many). action=kill: send a signal.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["status", "logs", "wait", "kill"], description: "Operation to perform on the job." },
            shellId: { type: "string", description: "ID returned from run_shell." },
            stream: { type: "string", description: "logs only: stdout | stderr | both." },
            tail: { type: "number", description: "logs only: return only the last N lines." },
            waitMs: { type: "number", description: "wait only: max wait in milliseconds (default 600000). Returns with timedOut:true if still running." },
            signal: { type: "string", description: "kill only: POSIX signal name (SIGTERM/SIGKILL/SIGINT)." },
            graceMs: { type: "number", description: "kill only: wait this long for graceful exit before SIGKILL." }
          },
          required: ["action", "shellId"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "TodoWrite",
        description: "Replace the agent's running todo list. Provide the full list each call (Claude Code semantics). Use this to track multi-step work.",
        parameters: {
          type: "object",
          properties: {
            todos: {
              type: "array",
              description: "Full new todo list. Each todo: { content, activeForm, status: pending|in_progress|completed }.",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  content: { type: "string" },
                  activeForm: { type: "string" },
                  status: { type: "string" }
                },
                required: ["content", "status", "activeForm"]
              }
            }
          },
          required: ["todos"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "WriteMemory",
        description: "Persist a memory entry to ~/.procway/ai-agent/memory/. Use sparingly for facts the user wants remembered across sessions.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Short memory title." },
            description: { type: "string", description: "One-line description." },
            type: { type: "string", description: "user | feedback | project | reference" },
            body: { type: "string", description: "Memory body (markdown)." }
          },
          required: ["name", "description", "type", "body"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "ReadMemory",
        description: "List the user's memory entries (titles + descriptions) so the agent can pick which to recall.",
        parameters: {
          type: "object",
          properties: {
            type: { type: "string", description: "Optional filter: user | feedback | project | reference" }
          },
          required: []
        }
      }
    },
    {
      type: "function",
      function: {
        name: "WebSearch",
        description: "Search the web. Returns a list of { title, url, snippet }. Backend (tavily, brave, serper, google-cse, duckduckgo) and credentials are configured in settings.tools.webSearch. Egress is gated by PROCWAY_NET_ALLOW.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query." },
            maxResults: { type: "number", description: "Max number of results (1-20). Defaults to settings.tools.webSearch.defaultMaxResults." }
          },
          required: ["query"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "WebFetch",
        description: "Fetch a URL over HTTPS and return the (truncated) response body as text. Egress is gated by PROCWAY_NET_ALLOW. Use this to inspect a page found via WebSearch.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "Absolute URL to fetch." },
            maxBytes: { type: "number", description: "Maximum number of body bytes to return." }
          },
          required: ["url"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "load_project_env",
        description: "Switch the ACTIVE project whose env vars are injected into your shell, then report the now-available env var NAMES. Use this in a multi-project session (e.g. Slack, or working across projects on the AI screen) BEFORE running commands/tests that need a specific project's credentials or config — pass that project's name and its env vars (DATABASE_URL, API keys, …) become available to subsequent run_shell commands as $NAME. Values are injected directly and are NEVER returned (especially secrets) — reference them via $NAME and never print them. Only this tenant's projects can be loaded. Pass an empty project to clear back to the default. A session that was already started for one project usually does NOT need this.",
        parameters: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name to make active (one of this tenant's projects). Empty string clears the active project." }
          },
          required: ["project"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "web_browser",
        description: "Drive a persistent browser (agent-browser, headed and visible in the noVNC desktop) for web automation. The browser stays alive across calls, so the workflow is: navigate -> snapshot (returns the page's interactive elements as @refs like @e2) -> click/fill the @ref you just saw -> snapshot again. Prefer @refs from a fresh snapshot over CSS selectors. Screenshots use workspace-relative paths (view_image them to actually see the page).",
        parameters: {
          type: "object",
          properties: {
            steps: {
              type: "array",
              description: "Ordered steps run against the live browser. Actions: navigate, snapshot, click, fill, type, press, get_text, screenshot, wait, scroll, back, reload.",
              items: {
                type: "object",
                properties: {
                  action: { type: "string", description: "navigate | snapshot | click | fill | type | press | get_text | screenshot | wait | scroll | back | reload" },
                  url: { type: "string", description: "URL for navigate steps." },
                  ref: { type: "string", description: "Element ref from a prior snapshot, e.g. \"@e2\" (preferred for click/fill/get_text)." },
                  selector: { type: "string", description: "CSS selector alternative to ref for click/fill/get_text/wait." },
                  text: { type: "string", description: "Text to fill (fill: clear+type into a ref) or type as keystrokes (type: into the focused element)." },
                  keys: { type: "string", description: "Key for press steps, e.g. \"Enter\", \"Tab\", \"Control+a\"." },
                  interactiveOnly: { type: "boolean", description: "snapshot: only interactive elements (buttons/inputs/links). Defaults true." },
                  compact: { type: "boolean", description: "snapshot: compact format. Defaults true." },
                  path: { type: "string", description: "Workspace-relative screenshot output path." },
                  fullPage: { type: "boolean", description: "screenshot: capture the full page. Defaults false (viewport only)." },
                  annotate: { type: "boolean", description: "screenshot: overlay numbered labels on interactive elements (helpful for vision)." },
                  ms: { type: "number", description: "wait: milliseconds to wait (or pass selector to wait for an element)." },
                  direction: { type: "string", description: "scroll: up | down | left | right. Defaults down." },
                  px: { type: "number", description: "scroll: pixels to scroll." }
                },
                required: ["action"]
              }
            }
          },
          required: ["steps"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "desktop_action",
        description: "Operate the runtime container's virtual desktop (Xvfb, visible in noVNC). Run an ordered sequence of OS-level actions: screenshot of the whole desktop, mouse_move, mouse_click, type (keyboard text), key (key combo like 'Return' or 'ctrl+c'). Backed by xdotool + scrot.",
        parameters: {
          type: "object",
          properties: {
            steps: {
              type: "array",
              description: "Ordered desktop steps. Supported actions: screenshot, mouse_move, mouse_click, type, key.",
              items: {
                type: "object",
                properties: {
                  action: { type: "string", description: "screenshot | mouse_move | mouse_click | type | key" },
                  x: { type: "integer", description: "Absolute X coordinate for mouse_move / mouse_click." },
                  y: { type: "integer", description: "Absolute Y coordinate for mouse_move / mouse_click." },
                  button: { type: "string", description: "Mouse button for mouse_click: left | middle | right. Defaults to left." },
                  text: { type: "string", description: "Text to type for the type action." },
                  keys: { type: "string", description: "Key combo for the key action, xdotool syntax (e.g. 'Return', 'ctrl+c', 'alt+Tab'). Space separates chained combos." },
                  path: { type: "string", description: "Workspace-relative output path for screenshot." },
                  delayMs: { type: "number", description: "Optional delay between keystrokes (type) or pre-shot wait (screenshot) in milliseconds." }
                },
                required: ["action"]
              }
            }
          },
          required: ["steps"]
        }
      }
    },
    // ---- Jira (Phase G1 C-1) ----
    {
      type: "function",
      function: {
        name: "jira_list_projects",
        description: "List Jira projects the connected user can see. Returns id/key/name (max 100, ordered by name).",
        parameters: { type: "object", properties: {}, required: [] }
      }
    },
    {
      type: "function",
      function: {
        name: "jira_search_issues",
        description: "Search Jira with JQL. Returns at most `maxResults` (default 20, max 100) summaries with key/summary/status/assignee/updated/url.",
        parameters: {
          type: "object",
          properties: {
            jql: { type: "string", description: "JQL expression, e.g. `project = PROJ AND status = \"To Do\"`." },
            maxResults: { type: "number", description: "Cap on returned rows (1-100)." }
          },
          required: ["jql"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "jira_get_issue",
        description: "Fetch one Jira issue with summary, description (ADF + flattened text), status, labels, etc.",
        parameters: {
          type: "object",
          properties: { key: { type: "string", description: "Issue key, e.g. PROJ-123." } },
          required: ["key"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "jira_list_transitions",
        description: "List available workflow transitions for an issue (returns id/name/to for each).",
        parameters: {
          type: "object",
          properties: { key: { type: "string" } },
          required: ["key"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "jira_create_issue",
        description: "Create a Jira issue. Requires `projectKey`, `summary`, and one of `issueTypeName` / `issueTypeId`. Description accepts plain text (wrapped as a single ADF paragraph) or a pre-built ADF doc. Requires approval.",
        parameters: {
          type: "object",
          properties: {
            projectKey: { type: "string" },
            summary: { type: "string" },
            description: { type: "string", description: "Plain text or ADF JSON-stringifiable object." },
            issueTypeName: { type: "string" },
            issueTypeId: { type: "string" },
            labels: { type: "array", items: { type: "string" } }
          },
          required: ["projectKey", "summary"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "jira_update_issue",
        description: "Update summary / description / labels on an existing Jira issue. Requires approval.",
        parameters: {
          type: "object",
          properties: {
            key: { type: "string" },
            summary: { type: "string" },
            description: { type: "string" },
            labels: { type: "array", items: { type: "string" } }
          },
          required: ["key"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "jira_add_comment",
        description: "Post a comment on a Jira issue. Plain text is auto-wrapped as ADF. Requires approval.",
        parameters: {
          type: "object",
          properties: {
            key: { type: "string" },
            body: { type: "string", description: "Comment body (plain text)." }
          },
          required: ["key", "body"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "jira_transition_issue",
        description: "Move a Jira issue through a workflow transition. Call jira_list_transitions first to discover the valid transitionId. Requires approval.",
        parameters: {
          type: "object",
          properties: {
            key: { type: "string" },
            transitionId: { type: "string" }
          },
          required: ["key", "transitionId"]
        }
      }
    },
    // ---- Confluence (Phase G1 C-1) ----
    {
      type: "function",
      function: {
        name: "confluence_list_spaces",
        description: "List Confluence spaces the connected user can see (max 50).",
        parameters: { type: "object", properties: {}, required: [] }
      }
    },
    {
      type: "function",
      function: {
        name: "confluence_search",
        description: "Search Confluence pages by CQL or free text. Pass either `cql` (raw CQL) or `query` (auto-wrapped as `text ~ \"<term>\" AND type = page`). Max 50 results.",
        parameters: {
          type: "object",
          properties: {
            cql: { type: "string", description: "Raw CQL — overrides `query` if both supplied." },
            query: { type: "string", description: "Free text; expanded to a text-match CQL." },
            limit: { type: "number", description: "Max rows (1-50)." }
          },
          required: []
        }
      }
    },
    {
      type: "function",
      function: {
        name: "confluence_get_page",
        description: "Fetch a Confluence page by id; returns the body as `bodyStorage` (Confluence storage XHTML) plus title/space/version.",
        parameters: {
          type: "object",
          properties: { pageId: { type: "string" } },
          required: ["pageId"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "confluence_create_page",
        description: "Create a Confluence page. `bodyText` (plain text → <p>-wrapped) OR `bodyStorage` (raw storage XHTML). Requires approval.",
        parameters: {
          type: "object",
          properties: {
            spaceKey: { type: "string" },
            title: { type: "string" },
            bodyText: { type: "string", description: "Plain text body. Double newlines split paragraphs." },
            bodyStorage: { type: "string", description: "Raw Confluence storage XHTML. Overrides bodyText." },
            parentId: { type: "string" }
          },
          required: ["spaceKey", "title"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "confluence_update_page",
        description: "Update a Confluence page; the current version is fetched internally so the caller does not need to pass `version`. Requires approval.",
        parameters: {
          type: "object",
          properties: {
            pageId: { type: "string" },
            title: { type: "string" },
            bodyText: { type: "string" },
            bodyStorage: { type: "string" }
          },
          required: ["pageId"]
        }
      }
    },
    // ---- Slack (integration Phase 1 — workspace bot token) ----
    {
      type: "function",
      function: {
        name: "slack_list_channels",
        description: "List public Slack channels in the connected workspace (id/name/topic/member count, max 200).",
        parameters: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Cap on returned channels (1-200, default 100)." }
          },
          required: []
        }
      }
    },
    {
      type: "function",
      function: {
        name: "slack_read_channel",
        description: "Read recent messages in a Slack channel, oldest first. `channel` accepts a channel id (C...) or a #name.",
        parameters: {
          type: "object",
          properties: {
            channel: { type: "string", description: "Channel id (C...) or #name." },
            limit: { type: "number", description: "Cap on returned messages (1-100, default 20)." }
          },
          required: ["channel"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "slack_read_thread",
        description: "Read the replies of a Slack thread. `threadTs` is the parent message ts (see slack_read_channel output).",
        parameters: {
          type: "object",
          properties: {
            channel: { type: "string", description: "Channel id (C...) or #name." },
            threadTs: { type: "string", description: "Parent message ts, e.g. \"1717987200.000100\"." },
            limit: { type: "number", description: "Cap on returned messages (1-200, default 50)." }
          },
          required: ["channel", "threadTs"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "slack_post_message",
        description: "Post a message to a Slack channel (optionally as a thread reply via `threadTs`). Requires approval.",
        parameters: {
          type: "object",
          properties: {
            channel: { type: "string", description: "Channel id (C...) or #name." },
            text: { type: "string", description: "Message text (Slack mrkdwn)." },
            threadTs: { type: "string", description: "Parent ts to reply in-thread instead of posting to the channel." }
          },
          required: ["channel", "text"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "save_attachment",
        description: "Save a message attachment into the workspace as a real file. Attachments (images/files the user attached in chat or Slack) are referenced by an attachment id shown in the message; hydrated images are visible but have no file on disk — use this when you need the actual bytes (re-upload, edit, convert, archive).",
        parameters: {
          type: "object",
          properties: {
            attachmentId: { type: "string", description: "Attachment id from the message's attachment note." },
            filePath: { type: "string", description: "Destination path, relative to the workspace (or absolute inside it)." }
          },
          required: ["attachmentId", "filePath"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "attach_file",
        description: "Attach a workspace file to THIS conversation. The file renders in the chat (image thumbnail / download link) and is reflected to any connected surface (e.g. the Slack thread this conversation is bound to) — you do NOT name a channel or surface. Use this to send a file back to the user: a generated report, a converted/edited file, a screenshot, an export. Surface-agnostic counterpart of save_attachment.",
        parameters: {
          type: "object",
          properties: {
            filePath: { type: "string", description: "Path of the file to attach — relative to the workspace, or absolute inside it." },
            name: { type: "string", description: "Display name for the attachment (defaults to the file name)." },
            comment: { type: "string", description: "Optional message posted alongside the file." }
          },
          required: ["filePath"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "start_run",
        description: "Start a ticket's run loop (the project's process flow) and AWAIT it like a sub-agent. This is the ONLY correct way to run a ticket from this chat — do NOT shell out to the procway CLI (e.g. `node \"$PROCWAY_CLI\" run loop`) via run_shell; that lets you impersonate the worker. This call RETURNS only when the run pauses for input or finishes (it may run for minutes — live progress streams into the side panel meanwhile). Inspect the returned `status`: if `awaiting-user-input` with a `hearing` (inputKind 'conversational'), relay the `hearing` text to the user, get their answer, and call reply_run with that answer + the returned `sessionId`; if it returns a structured `interaction` (inputKind 'structured'), tell the user to answer the widget, then call resume_run; otherwise it finished — report the result.",
        parameters: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name the ticket belongs to." },
            ticket: { type: "string", description: "Ticket id to run." },
            autoApprove: { type: "boolean", description: "Run without pausing for step approvals (optional)." }
          },
          required: ["project", "ticket"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "get_run_status",
        description: "Fetch the current state of a run-loop job started by start_run: status (running / awaiting input / done / error), the terminal result, or an awaiting-user-input interaction. Progress already streams into the side panel, so use this only for a one-off explicit check (e.g. to see whether the loop is paused awaiting the user's widget answer, after which you call resume_run) — not as a polling loop.",
        parameters: {
          type: "object",
          properties: {
            jobId: { type: "string", description: "jobId returned by start_run." }
          },
          required: ["jobId"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "resume_run",
        description: "Resume a STRUCTURED (widget) hearing: call this ONLY after the user answered the run's pending UIR via the input widget (the answer is already saved). It re-opens the saved worker session, continues the flow, and AWAITS the run like start_run — returning when it next pauses or finishes (handle the returned status the same way as start_run). Do NOT shell out to the procway CLI (e.g. `node \"$PROCWAY_CLI\" run loop resume`) via run_shell. Use reply_run instead for a plain-text (conversational) hearing.",
        parameters: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name the ticket belongs to." },
            ticket: { type: "string", description: "Ticket id whose paused run loop should resume." }
          },
          required: ["project", "ticket"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "reply_run",
        description: "Reply to a CONVERSATIONAL (plain-text) hearing and resume the run. Call this when start_run/reply_run returned `awaiting-user-input` with a `hearing` (inputKind 'conversational'): pass the user's answer plus the `sessionId` from that yield. It re-opens the paused worker session, injects the answer, continues the flow, and AWAITS the run like start_run — returning when it next pauses or finishes (handle the returned status the same way). For a structured widget hearing use resume_run instead, NOT this.",
        parameters: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name the ticket belongs to." },
            ticket: { type: "string", description: "Ticket id whose paused run loop should resume." },
            sessionId: { type: "string", description: "Worker session id from the awaiting-user-input yield (the paused worker to resume)." },
            answer: { type: "string", description: "The user's answer to the conversational hearing, in their own words." }
          },
          required: ["project", "ticket", "sessionId", "answer"]
        }
      }
    }
    // ADR 0030 D5: display-dependent tools are registered only where they can
    // actually run (see detectDisplayToolAvailability above).
  ].filter((tool) => availability?.[tool.function.name]?.available !== false);
}

/**
 * Drop image tools that cannot work under the active settings:
 *  - `view_image` requires a vision-capable MAIN provider (it routes the image
 *    into the conversation itself); exposing it to a text-only model is a trap
 *    that 400s the turn.
 *  - `ask_image` requires a configured vision delegate (settings.visionProvider).
 * Everything else passes through. Sessions apply this to getToolDefinitions()
 * output before handing tools to the model.
 */
export function filterToolDefinitionsForSettings(definitions, settings) {
  const mainProvider = settings?.providers?.[settings?.defaultProvider];
  const mainHasVision = providerSupportsVision(mainProvider);
  const hasVisionDelegate = resolveVisionProviderId(settings) != null;
  return (definitions ?? [])
    .filter((tool) => {
      const name = tool?.function?.name;
      if (name === "view_image") return mainHasVision;
      if (name === "ask_image") return hasVisionDelegate;
      return true;
    })
    .map((tool) => {
      // web_browser's description steers the model to view_image for reading
      // screenshots; when view_image is hidden (text-only main), point at
      // ask_image instead so the guidance doesn't reference a missing tool.
      if (!mainHasVision && tool?.function?.name === "web_browser" && typeof tool.function.description === "string") {
        const replacement = hasVisionDelegate
          ? "ask_image the saved path with a focused question to read what's on screen"
          : "the current model cannot view screenshots; prefer snapshot/get_text";
        const description = tool.function.description.replace(
          "view_image them to actually see the page",
          replacement
        );
        return { ...tool, function: { ...tool.function, description } };
      }
      return tool;
    });
}

const READ_ONLY_TOOLS = new Set([
  "list_files", "read_file", "search_files", "Glob", "Grep",
  // load_tools only widens the SENT schema list (dispatch is unaffected);
  // read-only turns still need it to reach the deferred read tools
  // (jira_search_issues etc.), and the mutation backstop in conversation.mjs
  // keeps anything it loads from actually writing.
  "load_tools",
  // shell_job: status/logs/wait are reads; the kill action is still gated as
  // a mutation per-call inside the dispatch (the name-level classification
  // only drives scheduling + read-only tool filtering, where exposing
  // shell_job is safe — a read-only session can't start a shell to kill).
  "shell_job", "TodoWrite", "ReadMemory",
  // request_user_action asks the user for input — benign, so it stays available
  // even in read-only turns and is not classified as a mutation.
  "request_user_action",
  // get_run_status is a read-only poll of a run-loop job (start_run / resume_run
  // have side effects and stay mutations).
  "get_run_status",
  "WebSearch", "WebFetch",
  "jira_list_projects", "jira_search_issues", "jira_get_issue", "jira_list_transitions",
  "confluence_list_spaces", "confluence_search", "confluence_get_page",
  "slack_list_channels", "slack_read_channel", "slack_read_thread"
]);

export function isMutationTool(name) {
  return !READ_ONLY_TOOLS.has(name);
}

function makeSkippedResult(kind, summary, extra = {}) {
  return {
    kind,
    summary,
    data: { skipped: true, error: "User denied approval", ...extra }
  };
}

/**
 * Execute a tool call with approval gating.
 *
 * Phase 4: the approval gate is now keyed by `{ kind, summary, mutation }`
 * (no more `{ required, message }`). `approvalRequester` evaluates
 * `settings.permissions` and may emit `approval.requested` via an
 * ApprovalCoordinator if a coordinator is wired through `requestApproval`.
 */
export async function executeToolCall({
  name,
  args,
  cwd,
  settings,
  approvalRequester = requestApproval,
  // UIR (User Interaction Request): a generic, NON-gated round-trip that asks
  // the user for structured input. Distinct from approvalRequester (a gate).
  // Null when no surface is wired → request_user_action returns a skipped result.
  interactionRequester = null,
  shellRunner = runShell,
  childAgentRunner,
  // Delegated-job registry the spawn_agent path routes through (ADR 0029 P3).
  // Injectable for tests; defaults to the process-wide shared registry.
  jobRegistry,
  todoStore = null,
  webSearchRunner = runWebSearch,
  webFetchRunner = runWebFetch,
  fetchImpl,
  webBrowserActionRunner = runWebBrowserAction,
  desktopActionRunner = runDesktopAction,
  // Forwarded into long-running tools (run_shell foreground streaming,
  // shell_job wait): each call surfaces as an `activity.tick` on the session
  // bus — feeding the turn-idle watchdog and the ChatPanel live view.
  onProgress = null
}) {
  async function gate({ kind, summary, mutation, payload }) {
    return approvalRequester({
      kind,
      summary,
      mutation,
      approvalMode: settings?.approvalMode,
      permissions: settings?.permissions,
      payload
    });
  }

  let result;

  if (name === "list_files") {
    const dirPath = args.dirPath ?? ".";
    const allowed = await gate({ kind: "list_files", summary: dirPath, mutation: false });
    result = allowed
      ? await listFiles({ cwd, dirPath })
      : makeSkippedResult("list_files", `Skipped listing: ${dirPath}`, { dirPath });
  } else if (name === "read_file") {
    const allowed = await gate({ kind: "read_file", summary: args.filePath, mutation: false });
    result = allowed
      ? await readTextFile({ cwd, filePath: args.filePath, maxBytes: args.maxBytes, offset: args.offset })
      : makeSkippedResult("read_file", `Skipped reading: ${args.filePath}`, { filePath: args.filePath });
  } else if (name === "view_image") {
    const allowed = await gate({ kind: "view_image", summary: args.path, mutation: false });
    result = allowed
      ? await viewImage({ cwd, filePath: args.path })
      : makeSkippedResult("view_image", `Skipped image: ${args.path}`, { path: args.path });
  } else if (name === "save_attachment") {
    // Writes a file into the workspace → gated as a mutation like write_file.
    const summary = `${args.attachmentId} → ${args.filePath}`;
    const allowed = await gate({ kind: "save_attachment", summary, mutation: true });
    result = allowed
      ? await saveAttachment({ cwd, attachmentId: args.attachmentId, filePath: args.filePath })
      : makeSkippedResult("save_attachment", `Skipped saving attachment: ${summary}`, { attachmentId: args.attachmentId });
  } else if (name === "attach_file") {
    // Pushes a workspace file to the conversation → reflected to connected
    // surfaces (external publish), so gated as a mutation.
    const summary = args.name ? `${args.name} (${args.filePath})` : args.filePath;
    const allowed = await gate({ kind: "attach_file", summary, mutation: true });
    result = allowed
      ? await attachFile({ cwd, filePath: args.filePath, name: args.name, comment: args.comment })
      : makeSkippedResult("attach_file", `Skipped attaching file: ${summary}`, { filePath: args.filePath });
  } else if (name === "start_run") {
    // Typed facade over POST /api/run/jobs — starts a ticket's run loop as a
    // background job (replaces the run_shell `node "$PROCWAY_CLI" run loop`
    // delegation, #122 層2b). Has a side effect (kicks off a run) → gated as a
    // mutation. The flat run-control result is wrapped into a ToolResult.
    const summary = `${args.project ?? ""}#${args.ticket ?? ""}`;
    const allowed = await gate({ kind: "start_run", summary, mutation: true });
    if (!allowed) {
      result = makeSkippedResult("start_run", `Skipped start_run: ${summary}`, { project: args.project, ticket: args.ticket });
    } else {
      // ADR 0029 await-yield: startRun polls internally until the run pauses or
      // finishes (minutes). onProgress feeds the turn-idle watchdog meanwhile.
      const r = await startRun({ project: args.project, ticket: args.ticket, autoApprove: args.autoApprove, onProgress });
      result = { kind: "start_run", summary: `Run ${r.jobId ?? "?"} ${r.status ?? "?"} (${summary})`, data: r };
    }
  } else if (name === "get_run_status") {
    // Read-only poll of GET /api/run/jobs/:jobId.
    const allowed = await gate({ kind: "get_run_status", summary: args.jobId ?? "", mutation: false });
    if (!allowed) {
      result = makeSkippedResult("get_run_status", `Skipped get_run_status: ${args.jobId}`, { jobId: args.jobId });
    } else {
      const r = await getRunStatus({ jobId: args.jobId });
      result = { kind: "get_run_status", summary: `Run ${r.jobId ?? args.jobId}: ${r.status ?? "unknown"}`, data: r };
    }
  } else if (name === "resume_run") {
    // Typed facade over POST /api/run/jobs/resume — resumes a paused run loop as
    // a fresh background job (replaces the run_shell `... run loop resume`
    // delegation). Side effect → gated as a mutation.
    const summary = `${args.project ?? ""}#${args.ticket ?? ""}`;
    const allowed = await gate({ kind: "resume_run", summary, mutation: true });
    if (!allowed) {
      result = makeSkippedResult("resume_run", `Skipped resume_run: ${summary}`, { project: args.project, ticket: args.ticket });
    } else {
      // ADR 0029 await-yield: resumeRun polls internally until the next pause/finish.
      const r = await resumeRun({ project: args.project, ticket: args.ticket, onProgress });
      result = { kind: "resume_run", summary: `Run ${r.jobId ?? "?"} ${r.status ?? "?"} (${summary})`, data: r };
    }
  } else if (name === "reply_run") {
    // ADR 0029 Phase 1: conversational (plain-text) hearing resume — POST
    // /api/run/jobs/conversational-resume, then await-yield. Side effect →
    // gated as a mutation. NO pending_interactions row (no widget answer).
    const summary = `${args.project ?? ""}#${args.ticket ?? ""}`;
    const allowed = await gate({ kind: "reply_run", summary, mutation: true });
    if (!allowed) {
      result = makeSkippedResult("reply_run", `Skipped reply_run: ${summary}`, { project: args.project, ticket: args.ticket });
    } else {
      const r = await replyRun({ project: args.project, ticket: args.ticket, sessionId: args.sessionId, answer: args.answer, onProgress });
      result = { kind: "reply_run", summary: `Run ${r.jobId ?? "?"} ${r.status ?? "?"} (${summary})`, data: r };
    }
  } else if (name === "ask_image") {
    const summary = `${args.path}: ${`${args.prompt ?? ""}`.slice(0, 60)}`;
    const allowed = await gate({ kind: "ask_image", summary, mutation: false });
    result = allowed
      ? await askImage({ cwd, filePath: args.path, prompt: args.prompt, settings })
      : makeSkippedResult("ask_image", `Skipped image question: ${args.path}`, { path: args.path });
  } else if (name === "search_files") {
    const allowed = await gate({ kind: "search_files", summary: args.query, mutation: false });
    result = allowed
      ? await searchFiles({ cwd, query: args.query, dirPath: args.dirPath ?? ".", maxResults: args.maxResults ?? 50 })
      : makeSkippedResult("search_files", `Skipped search for: ${args.query}`, { query: args.query });
  } else if (name === "Glob") {
    const allowed = await gate({ kind: "search_files", summary: args.pattern, mutation: false });
    result = allowed
      ? await runGlob({ cwd, pattern: args.pattern, dirPath: args.dirPath ?? ".", maxResults: args.maxResults ?? 1000 })
      : makeSkippedResult("search_files", `Skipped glob: ${args.pattern}`, { pattern: args.pattern });
  } else if (name === "Grep") {
    const allowed = await gate({ kind: "search_files", summary: args.pattern, mutation: false });
    result = allowed
      ? await runGrep({
          cwd,
          pattern: args.pattern,
          dirPath: args.dirPath ?? ".",
          glob: args.glob,
          maxResults: args.maxResults ?? 200,
          contextLines: args.contextLines ?? 0,
          caseInsensitive: args.caseInsensitive === true
        })
      : makeSkippedResult("search_files", `Skipped grep: ${args.pattern}`, { pattern: args.pattern });
  } else if (name === "write_file") {
    const before = await readPriorContent(cwd, args.filePath);
    const editable = { content: args.content, filePath: args.filePath, before, after: args.content, operation: before == null ? "create" : "modify" };
    const allowed = await gate({ kind: "write_file", summary: args.filePath, mutation: true, payload: editable });
    result = allowed
      ? await writeTextFile({ cwd, filePath: args.filePath, content: editable.content })
      : makeSkippedResult("write_file", `Skipped writing: ${args.filePath}`, { path: args.filePath });
  } else if (name === "apply_patch") {
    const editable = { patch: args.patch };
    const allowed = await gate({ kind: "apply_patch", summary: "patch", mutation: true, payload: editable });
    result = allowed
      ? await applyUnifiedPatch({ cwd, patch: editable.patch })
      : makeSkippedResult("apply_patch", "Skipped patch application");
  } else if (name === "Edit") {
    const before = await readPriorContent(cwd, args.filePath);
    const after = before != null ? simulateEdit(before, args.oldString, args.newString, args.replaceAll === true) : null;
    const editable = {
      oldString: args.oldString,
      newString: args.newString,
      replaceAll: args.replaceAll === true,
      filePath: args.filePath,
      before,
      after,
      operation: "modify"
    };
    const allowed = await gate({ kind: "edit", summary: args.filePath, mutation: true, payload: editable });
    result = allowed
      ? await editFile({ cwd, filePath: args.filePath, oldString: editable.oldString, newString: editable.newString, replaceAll: editable.replaceAll === true })
      : makeSkippedResult("edit", `Skipped edit: ${args.filePath}`, { path: args.filePath });
  } else if (name === "run_shell") {
    const classification = classifyCommand(args.command);
    const shellMutation = classification.approvalRequired;
    const summary = `${args.command} (${classification.reasons.join(", ") || "safe"})`;
    const allowed = await gate({ kind: "run_shell", summary, mutation: shellMutation, payload: { classification } });
    if (!allowed) {
      result = {
        kind: "run_shell",
        summary: `Skipped shell: ${args.command}`,
        data: {
          command: args.command,
          skipped: true,
          classification,
          error: "User denied approval"
        }
      };
    } else {
      result = await shellRunner({
        cwd,
        command: args.command,
        timeoutMs: args.timeoutMs ?? settings?.tools?.shellTimeoutMs ?? 300000,
        runInBackground: args.runInBackground === true,
        settings,
        onProgress
      });
    }
  } else if (name === "shell_job") {
    // One management tool, four actions. Approval-gate kinds keep the legacy
    // per-action names (shell_status/shell_logs/shell_kill + new shell_wait)
    // so existing settings.permissions entries keep matching.
    const action = typeof args.action === "string" ? args.action : "";
    if (action === "status") {
      const allowed = await gate({ kind: "shell_status", summary: args.shellId ?? "", mutation: false });
      result = allowed
        ? await runShellStatus({ shellId: args.shellId })
        : makeSkippedResult("run_shell", `Skipped status: ${args.shellId}`, { tool: "shell_status", shellId: args.shellId });
    } else if (action === "logs") {
      const allowed = await gate({ kind: "shell_logs", summary: args.shellId ?? "", mutation: false });
      result = allowed
        ? await runShellLogs({ shellId: args.shellId, stream: args.stream, tail: args.tail })
        : makeSkippedResult("run_shell", `Skipped logs: ${args.shellId}`, { tool: "shell_logs", shellId: args.shellId });
    } else if (action === "wait") {
      const allowed = await gate({ kind: "shell_wait", summary: args.shellId ?? "", mutation: false });
      result = allowed
        ? await runShellWait({ shellId: args.shellId, waitMs: args.waitMs, onProgress })
        : makeSkippedResult("run_shell", `Skipped wait: ${args.shellId}`, { tool: "shell_wait", shellId: args.shellId });
    } else if (action === "kill") {
      const allowed = await gate({ kind: "shell_kill", summary: args.shellId ?? "", mutation: true });
      result = allowed
        ? await runShellKill({ shellId: args.shellId, signal: args.signal, graceMs: args.graceMs })
        : makeSkippedResult("run_shell", `Skipped kill: ${args.shellId}`, { tool: "shell_kill", shellId: args.shellId });
    } else {
      result = {
        kind: "run_shell",
        summary: `shell_job: unknown action "${action}"`,
        data: { tool: "shell_job", error: `action must be one of status|logs|wait|kill, got "${action}"` }
      };
    }
  } else if (name === "TodoWrite") {
    if (!todoStore) {
      result = {
        kind: "run_shell",
        summary: "TodoWrite skipped (no store wired)",
        data: { skipped: true, reason: "no-todo-store" }
      };
    } else {
      const todos = Array.isArray(args?.todos) ? args.todos : [];
      const stored = todoStore.set(todos);
      const summary = todoStore.summary();
      result = {
        kind: "run_shell",
        summary: `Updated ${stored.length} todos (${summary.inProgress} in progress, ${summary.pending} pending, ${summary.completed} completed)`,
        data: { todos: stored, summary }
      };
    }
  } else if (name === "WriteMemory") {
    const allowed = await gate({ kind: "write_memory", summary: args.name ?? "", mutation: true, payload: { name: args.name, type: args.type } });
    if (!allowed) {
      result = makeSkippedResult("write_file", "Skipped memory write", { name: args.name });
    } else {
      const written = await writeMemoryFile({
        homeDir: settings?.memory?.homeDir,
        name: args.name,
        description: args.description ?? "",
        type: args.type,
        body: args.body ?? ""
      });
      result = {
        kind: "write_file",
        summary: `${written.action === "create" ? "Created" : "Updated"} memory: ${args.name}`,
        data: { path: written.path, action: written.action, fileName: written.fileName }
      };
    }
  } else if (name === "ReadMemory") {
    const allowed = await gate({ kind: "read_file", summary: "memory index", mutation: false });
    if (!allowed) {
      result = makeSkippedResult("read_file", "Skipped memory read");
    } else {
      const index = await loadMemoryIndex({ homeDir: settings?.memory?.homeDir });
      const memories = (index?.memories ?? []).filter((entry) => !args?.type || entry.type === args.type);
      result = {
        kind: "read_file",
        summary: `Memory: ${memories.length} entries`,
        data: {
          path: index?.dir ?? "",
          bytes: memories.reduce((total, entry) => total + (entry.body?.length ?? 0), 0),
          entries: memories.map((entry) => ({
            file: entry.file,
            name: entry.name,
            description: entry.description,
            type: entry.type
          }))
        }
      };
    }
  } else if (name === "WebSearch") {
    const summary = `${args?.query ?? ""}`.slice(0, 80);
    const allowed = await gate({ kind: "web_search", summary, mutation: false, payload: { query: args?.query, maxResults: args?.maxResults } });
    if (!allowed) {
      result = makeSkippedResult("web_search", `Skipped web search: ${summary}`, { query: args?.query });
    } else {
      const safeFetchImpl = resolveFetch(fetchImpl, approvalRequester, settings);
      result = await webSearchRunner({
        query: args?.query,
        maxResults: args?.maxResults,
        settings,
        fetchImpl: safeFetchImpl
      });
    }
  } else if (name === "WebFetch") {
    const summary = `${args?.url ?? ""}`.slice(0, 80);
    const allowed = await gate({ kind: "web_fetch", summary, mutation: false, payload: { url: args?.url } });
    if (!allowed) {
      result = makeSkippedResult("web_fetch", `Skipped web fetch: ${summary}`, { url: args?.url });
    } else {
      const safeFetchImpl = resolveFetch(fetchImpl, approvalRequester, settings);
      result = await webFetchRunner({
        url: args?.url,
        maxBytes: args?.maxBytes,
        fetchImpl: safeFetchImpl,
        timeoutMs: settings?.tools?.webSearch?.timeoutMs
      });
    }
  } else if (name === "load_project_env") {
    // ADR 0024 Phase 3: effectful selector switch — writes the active-project
    // marker and re-applies env. Ungated (benign, tenant-scoped; like TodoWrite).
    // Values never returned — only env-var key names.
    result = await loadProjectEnv({ project: args?.project });
  } else if (name === "web_browser") {
    const summary = Array.isArray(args?.steps) ? `${args.steps.length} web step(s)` : "web browser action";
    const hasMutation = (Array.isArray(args?.steps) ? args.steps : []).some((step) => {
      try {
        return isWebBrowserMutationStep(step?.action);
      } catch {
        return false;
      }
    });
    const allowed = await gate({ kind: "browser_action", summary, mutation: hasMutation, payload: { steps: args?.steps } });
    if (!allowed) {
      result = makeSkippedResult("browser_action", `Skipped web browser action: ${summary}`);
    } else {
      result = await webBrowserActionRunner({ cwd, steps: args?.steps, settings });
    }
  } else if (name === "desktop_action") {
    const summary = Array.isArray(args?.steps) ? `${args.steps.length} desktop step(s)` : "desktop action";
    const hasMutation = (Array.isArray(args?.steps) ? args.steps : []).some((step) => {
      const action = `${step?.action ?? ""}`.toLowerCase();
      return ["mouse_move", "mouse_click", "click", "move", "type", "key", "press", "hotkey"].includes(action);
    });
    const allowed = await gate({ kind: "desktop_action", summary, mutation: hasMutation, payload: { steps: args?.steps } });
    if (!allowed) {
      result = makeSkippedResult("desktop_action", `Skipped desktop action: ${summary}`);
    } else {
      result = await desktopActionRunner({ cwd, steps: args?.steps });
    }
  } else if (name === "spawn_agent") {
    const allowed = await gate({ kind: "spawn_agent", summary: args.task ?? "", mutation: true });
    if (!allowed) {
      result = makeSkippedResult("spawn_agent", "Skipped child agent");
    } else if (!childAgentRunner) {
      throw new Error("spawn_agent is not available in this execution context");
    } else {
      // ADR 0029 P3: re-express spawn_agent as an `agent` kind delegated job. The
      // child runs DETACHED through the registry (unified lifecycle + progress
      // streaming + kill), but spawn_agent keeps its synchronous observable
      // contract by awaiting the first yield (run-to-completion — children are
      // interactive=false in P3). childAgentRunner stays the injection point; the
      // driver wraps it as the manager so concurrency/depth stay in child-agent.
      const registry = jobRegistry ?? getSharedJobRegistry();
      const driver = createAgentDriver({ childAgentManager: { run: (a) => childAgentRunner(a) } });
      const { jobId } = registry.spawnJob({
        kind: "agent",
        driver,
        spec: { task: args.task, childCwd: args.cwd ?? "." }
      });
      // Forward the job's progress events as turn heartbeats so the parent turn's
      // idle watchdog stays fed while a long child runs (mirrors how run_shell /
      // run-control thread onProgress).
      const unsubscribe = registry.subscribeJob(jobId, (env) => {
        if (env?.type !== "event" || typeof onProgress !== "function") return;
        const e = env.data ?? {};
        const detail = e.type === "agent.progress"
          ? `child agent running (${e.runningSec ?? 0}s)`
          : e.type === "agent.started"
            ? `child agent started${e.task ? `: ${e.task}` : ""}`
            : `child agent: ${e.type ?? "activity"}`;
        try { onProgress({ detail }); } catch { /* best-effort */ }
      });
      let yld;
      try {
        yld = await registry.awaitJobYield(jobId);
      } finally {
        unsubscribe();
      }
      if (yld?.status === "failed") {
        // Preserve the prior contract: a child failure propagated as a throw
        // (surfacing as turn.failed), NOT a normal tool result.
        throw new Error(yld.error || "Child agent failed");
      }
      const childResult = yld?.result ?? {};
      const text = childResult.text ?? "";
      result = {
        kind: "spawn_agent",
        summary: text ? truncateSummary(text) : `Child agent exited (${childResult.exitCode ?? 0})`,
        data: { ...childResult, text }
      };
    }
  } else if (name.startsWith("jira_") || name.startsWith("confluence_") || name.startsWith("slack_")) {
    result = await runIntegrationTool({ name, args, cwd, gate });
  } else if (name === "request_user_action") {
    // NOT an approval gate — a generic UIR round-trip. Resolves to whatever
    // JSON the surface (chat / Slack) collects from the user. When no surface
    // is wired (headless / no coordinator) it returns a skipped result so the
    // turn continues rather than hanging.
    const kind = typeof args?.kind === "string" ? args.kind : "input";
    if (typeof interactionRequester !== "function") {
      result = {
        kind: "interaction",
        summary: `No surface to request user action: ${kind}`,
        data: { kind, skipped: true, reason: "no-interaction-requester" }
      };
    } else {
      const blocking = args?.blocking !== false;
      const response = await interactionRequester({
        kind,
        summary: typeof args?.summary === "string" ? args.summary : "",
        spec: (args?.spec && typeof args.spec === "object") ? args.spec : undefined,
        blocking
      });
      // §6 run-loop hearing RETURN mode: the requester recorded the request and
      // returned `{ deferred: true }` instead of waiting. The user answers
      // asynchronously (via the side panel), and `run loop resume` re-opens this
      // session with the answer injected. The worker must NOT keep working or
      // self-answer — instruct it to END the turn now so control returns to the
      // run loop (which surfaces awaiting-user-input).
      if (response && typeof response === "object" && response.deferred === true) {
        result = {
          kind: "interaction",
          summary: `User action requested (awaiting reply): ${kind}`,
          data: {
            kind,
            blocking: false,
            deferred: true,
            requestId: response.requestId ?? null,
            note: "Your request has been recorded and is awaiting the user's reply. Do NOT answer it yourself and do NOT call `task complete`. End your turn now with a brief note that you are waiting for the user — the run loop will resume this session once the user responds."
          }
        };
      } else {
        result = {
          kind: "interaction",
          summary: `Requested user action: ${kind}`,
          data: { kind, blocking, response }
        };
      }
    }
  } else if (name === "load_tools") {
    // No approval gate: loading schemas is harmless. The session marks the
    // names as loaded via conversation.mjs#noteDeferredTools (which observes
    // every tool call, including this one); from the next round the full
    // schemas ride along in the tool list.
    const requested = Array.isArray(args?.names) ? args.names.filter((n) => typeof n === "string") : [];
    const loaded = requested.filter((n) => DEFERRED_TOOL_NAMES.has(n));
    const unknown = requested.filter((n) => !DEFERRED_TOOL_NAMES.has(n));
    result = {
      kind: "load_tools",
      summary: loaded.length > 0 ? `Loaded tools: ${loaded.join(", ")}` : "No deferred tools matched",
      data: {
        loaded,
        ...(unknown.length > 0 ? { unknown, hint: "Unknown names are ignored; see the load_tools description for the available list." } : {}),
        note: loaded.length > 0 ? "Full schemas are available from the next round." : undefined
      }
    };
  } else {
    throw new Error(`Unknown tool: ${name}`);
  }

  if (!isToolResult(result)) {
    throw new TypeError(`Tool "${name}" returned a non-ToolResult value`);
  }
  return result;
}

function truncateSummary(text, max = 80) {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= max ? single : `${single.slice(0, max - 3)}...`;
}

/**
 * Dispatch jira_* / confluence_* tools through the approval gate and
 * the matching client function. Read tools use mutation:false; write
 * tools use mutation:true so the existing pocApprovalRequester
 * (settings.permissions allow/deny) governs them like every other
 * mutation in the host.
 */
async function runIntegrationTool({ name, args = {}, cwd, gate }) {
  const writeTools = new Set([
    "jira_create_issue", "jira_update_issue", "jira_add_comment", "jira_transition_issue",
    "confluence_create_page", "confluence_update_page",
    "slack_post_message"
  ]);
  const mutation = writeTools.has(name);

  // Build a short, human-readable summary per tool so the approval
  // dialog (when wired) shows what we're about to do.
  const summary = summarizeIntegrationCall(name, args);
  const allowed = await gate({ kind: name, summary, mutation, payload: args });
  if (!allowed) {
    return makeSkippedResult("mcp", `Skipped ${name}: ${summary}`, { tool: name });
  }

  try {
    const raw = await dispatchIntegrationCall(name, args, cwd);
    // Tool-result `data` must be an object — wrap arrays + scalars.
    const data = Array.isArray(raw)
      ? { tool: name, results: raw, count: raw.length }
      : (raw && typeof raw === "object") ? { tool: name, ...raw } : { tool: name, value: raw };
    return {
      kind: "mcp",
      summary: integrationResultSummary(name, args, raw),
      data
    };
  } catch (e) {
    // Surface NOT_CONNECTED with a hint rather than a raw error so the
    // model can recover by telling the user to open Settings > Connections.
    if (e instanceof IntegrationNotConnectedError) {
      return {
        kind: "mcp",
        summary: e.message,
        data: { tool: name, error: e.message, code: "NOT_CONNECTED", connectionId: e.connectionId, skipped: true }
      };
    }
    if (e instanceof IntegrationApiError) {
      return {
        kind: "mcp",
        summary: `${name} failed (${e.status})`,
        data: { tool: name, error: e.message, code: "PROVIDER_ERROR", providerStatus: e.status, skipped: true }
      };
    }
    throw e;
  }
}

function summarizeIntegrationCall(name, args) {
  switch (name) {
    case "jira_search_issues":     return args.jql ?? "";
    case "jira_get_issue":
    case "jira_list_transitions":  return args.key ?? "";
    case "jira_create_issue":      return `${args.projectKey}: ${args.summary ?? ""}`.slice(0, 80);
    case "jira_update_issue":      return `${args.key} (${Object.keys(args).filter(k => k !== "key").join(", ")})`;
    case "jira_add_comment":       return `${args.key} +comment`;
    case "jira_transition_issue":  return `${args.key} → transition ${args.transitionId}`;
    case "confluence_search":      return args.cql ?? args.query ?? "";
    case "confluence_get_page":    return args.pageId ?? "";
    case "confluence_create_page": return `${args.spaceKey}/${args.title ?? ""}`.slice(0, 80);
    case "confluence_update_page": return `${args.pageId}`;
    case "slack_read_channel":     return args.channel ?? "";
    case "slack_read_thread":      return `${args.channel ?? ""} @ ${args.threadTs ?? ""}`;
    case "slack_post_message":     return `${args.channel ?? ""}: ${args.text ?? ""}`.slice(0, 80);
    default: return "";
  }
}

function integrationResultSummary(name, args, data) {
  if (Array.isArray(data)) return `${name}: ${data.length} rows`;
  if (data?.key) return `${name}: ${data.key}`;
  if (data?.id) return `${name}: id=${data.id}`;
  return summarizeIntegrationCall(name, args) || name;
}

async function dispatchIntegrationCall(name, args, cwd) {
  switch (name) {
    // ---- Jira ----
    case "jira_list_projects":     return jiraTools.listProjects({ cwd });
    case "jira_search_issues":     return jiraTools.searchIssues({ cwd, jql: args.jql, maxResults: args.maxResults });
    case "jira_get_issue":         return jiraTools.getIssue({ cwd, key: args.key });
    case "jira_list_transitions":  return jiraTools.listTransitions({ cwd, key: args.key });
    case "jira_create_issue":      return jiraTools.createIssue({
      cwd,
      projectKey: args.projectKey,
      summary: args.summary,
      description: args.description,
      issueTypeName: args.issueTypeName,
      issueTypeId: args.issueTypeId,
      labels: args.labels
    });
    case "jira_update_issue":      return jiraTools.updateIssue({
      cwd, key: args.key, summary: args.summary, description: args.description, labels: args.labels
    });
    case "jira_add_comment":       return jiraTools.addComment({ cwd, key: args.key, body: args.body });
    case "jira_transition_issue":  return jiraTools.transitionIssue({ cwd, key: args.key, transitionId: args.transitionId });
    // ---- Confluence ----
    case "confluence_list_spaces": return confluenceTools.listSpaces({ cwd });
    case "confluence_search":      return confluenceTools.searchPages({ cwd, cql: args.cql, query: args.query, limit: args.limit });
    case "confluence_get_page":    return confluenceTools.getPage({ cwd, pageId: args.pageId });
    case "confluence_create_page": return confluenceTools.createPage({
      cwd, spaceKey: args.spaceKey, title: args.title,
      bodyText: args.bodyText, bodyStorage: args.bodyStorage, parentId: args.parentId
    });
    case "confluence_update_page": return confluenceTools.updatePage({
      cwd, pageId: args.pageId, title: args.title, bodyText: args.bodyText, bodyStorage: args.bodyStorage
    });
    // ---- Slack ----
    case "slack_list_channels":    return slackTools.listChannels({ cwd, limit: args.limit });
    case "slack_read_channel":     return slackTools.readChannel({ cwd, channel: args.channel, limit: args.limit });
    case "slack_read_thread":      return slackTools.readThread({
      cwd, channel: args.channel, threadTs: args.threadTs, limit: args.limit
    });
    case "slack_post_message":     return slackTools.postMessage({
      cwd, channel: args.channel, text: args.text, threadTs: args.threadTs
    });
    default: throw new Error(`Unknown integration tool: ${name}`);
  }
}

function resolveFetch(fetchImpl, approvalRequester, settings) {
  if (typeof fetchImpl === "function") return fetchImpl;
  if (typeof globalThis.fetch !== "function") {
    throw new Error("Network tools require a global fetch implementation");
  }
  return createSafeFetch({
    // Proxy-aware: in the session Pod all egress rides the egress proxy via
    // HTTP(S)_PROXY env, which Node's built-in fetch ignores (WebSearch /
    // WebFetch died with ECONNREFUSED under the NetworkPolicy). Identity
    // (globalThis.fetch) when no proxy env is present.
    fetchImpl: getProxyAwareFetch(),
    approvalRequester: approvalRequester
      ? (req) => approvalRequester({ ...req, approvalMode: settings?.approvalMode, permissions: settings?.permissions })
      : null
  });
}
