import path from "node:path";
import { listFiles } from "../tools/filesystem.mjs";
import { createMessage } from "../core/types/message.mjs";
import { formatMemoryForPrompt } from "../memory/retriever.mjs";
import { getUserEnvSummary, getAvailableProjects } from "../config/user-env.mjs";

const RULES_SECTION_HEADER = "## Rules";
const RULES_USAGE_NOTE =
  "These are forced, high-priority operating rules for every session. Follow them.";
const PROJECT_CONTEXT_SECTION_HEADER_NAME = "## Project Context";
const USER_ENV_SECTION_HEADER_NAME = "## Available Environment Variables";
const ROOT_ENTRIES_SECTION_HEADER = "## Root Entries";
const INSTRUCTIONS_SECTION_HEADER = "## Instructions";
const SKILLS_SECTION_HEADER = "## Available Skills";
const MEMORY_SECTION_HEADER = "## Memory";

/**
 * The complete set of top-level (`## `) section headers buildSystemPrompt may
 * emit. Section-swap helpers (refreshSystemMessageRules / *Skills) MUST bound a
 * replaced section by the next KNOWN header from this set, never a generic
 * `\n\n## ` scan: rule/skill BODIES are user-authored markdown that routinely
 * contain their own level-2 `## ` headers, and a generic scan would mistake an
 * embedded body header for the next section boundary — preserving stale body
 * content past the real section end (and orphaning the rest of the prompt).
 */
const KNOWN_SECTION_HEADERS = [
  RULES_SECTION_HEADER,
  PROJECT_CONTEXT_SECTION_HEADER_NAME,
  USER_ENV_SECTION_HEADER_NAME,
  ROOT_ENTRIES_SECTION_HEADER,
  INSTRUCTIONS_SECTION_HEADER,
  SKILLS_SECTION_HEADER,
  MEMORY_SECTION_HEADER,
];

/**
 * Find the byte offset of the next KNOWN section boundary at/after `start`.
 * A boundary is the `\n\n` separator immediately preceding one of
 * KNOWN_SECTION_HEADERS (so the returned offset points at the `\n\n`, matching
 * the legacy `indexOf("\n\n## ")` contract). Returns -1 when none follows,
 * meaning the swapped section is the last one in the prompt. Unlike a generic
 * `\n\n## ` scan this skips `## ` headers embedded inside section bodies.
 */
function findNextSectionBoundary(text, start) {
  let best = -1;
  for (const header of KNOWN_SECTION_HEADERS) {
    const idx = text.indexOf(`\n\n${header}`, start);
    if (idx !== -1 && (best === -1 || idx < best)) best = idx;
  }
  return best;
}
const SKILLS_USAGE_NOTE =
  "Skills are reusable instruction documents discovered in this workspace. "
  + "Before starting work, check this list: if a skill is relevant to the current task, "
  + "read its SKILL.md with read_file first and follow its instructions.";
const MAX_SKILLS = 40;
const MAX_DESCRIPTION_LENGTH = 200;

export async function buildSystemMessage({ cwd, context, sessionId, memorySnapshot = null }) {
  const listResult = await listFiles({ cwd, dirPath: "." }).catch(() => null);
  const rootEntries = Array.isArray(listResult?.data) ? listResult.data : [];
  return createMessage({
    role: "system",
    sessionId,
    content: [{
      kind: "text",
      text: buildSystemPrompt({ cwd, context, rootEntries, memorySnapshot })
    }]
  });
}

function buildSystemPrompt({ cwd, context, rootEntries, memorySnapshot }) {
  const instructionBlocks = context.instructions
    .slice(0, 8)
    .map((item) => `### ${item.compatibility}: ${item.path}\n${truncate(item.content, 6000)}`)
    .join("\n\n");
  const rootList = rootEntries
    .slice(0, 80)
    .map((entry) => `- ${entry.type}: ${entry.name}`)
    .join("\n");
  const memorySection = formatMemoryForPrompt(memorySnapshot);

  const parts = [
    `You are procway-code, a local coding agent.
Work inside this workspace: ${cwd}
Compatibility mode: ${context.compatibilityMode}

Use the available file tools to inspect the repository before answering repository-specific questions.
Do not claim you inspected files unless you used tools or the file content is included in this prompt.
When the user asks you to create, write, save, update, edit, or generate a file, you must call write_file, apply_patch, or Edit before giving the final answer.
Do not end a turn with phrases like "I will create it" or "I will write it" unless the relevant file tool call has already succeeded.
If you need to create a new file, use write_file with the complete file content.
To ask the user for structured input, call the request_user_action tool instead of only asking in prose — the user answers via an inline widget in the chat. Use kind 'survey' to ask questions (you may ask several at once; mark a recommended option per question), 'env_vars' to have the user set environment variables / secrets (you receive only which keys were set, never the values), and 'approval' to obtain a recorded approval for the current ticket task. Plain-prose questions are fine for quick clarifications, but prefer request_user_action whenever a choice, a form, a value, or a recorded approval is involved.
Keep answers concise and concrete.`
  ];
  // Forced, high-priority "all-sessions" Rules go FIRST (after the base agent
  // instructions, before Project Context / env / Instructions / Skills) so the
  // model treats them as overriding operating rules. Omitted when empty.
  const rulesSection = renderRulesSection(context.rules);
  if (rulesSection) parts.push(rulesSection);
  const projectSection = renderProjectContextSection();
  if (projectSection) parts.push(projectSection);
  const envVarsSection = renderUserEnvSection(getUserEnvSummary(), { availableProjects: getAvailableProjects() });
  if (envVarsSection) parts.push(envVarsSection);
  parts.push(
    `## Root Entries\n${rootList || "(none)"}`,
    `## Instructions\n${instructionBlocks || "(no instruction files discovered for this compatibility mode)"}`,
    renderSkillsSection(context.skills)
  );
  if (memorySection.length > 0) parts.push(memorySection);
  return parts.join("\n\n") + "\n";
}

const PROJECT_CONTEXT_SECTION_HEADER = PROJECT_CONTEXT_SECTION_HEADER_NAME;

/**
 * Tell the agent WHERE this project's source actually lives. The session's
 * working directory (PROCWAY_WORKSPACE_DIR, e.g. /workspace) is an ephemeral
 * per-session scratch PVC that starts EMPTY every boot — the cloned repos and
 * ticket worktrees live under the shared tenant workspaces tree mounted at
 * PROCWAY_WORKSPACE_URI (e.g. /procway-workspaces). Without this section the
 * agent inspects its empty cwd, concludes "the workspace is empty", and asks
 * the user for a repo URL it could have found on disk.
 *
 * Rendered only when PROCWAY_SESSION_PROJECT is set (project-scoped sessions).
 * env is injectable for tests; defaults to the live process env.
 */
export function renderProjectContextSection(env = process.env) {
  const project = (env.PROCWAY_SESSION_PROJECT || "").trim();
  if (!project) return null;
  const workspaceRoot = workspaceRootFromUri(env.PROCWAY_WORKSPACE_URI) || "/procway-workspaces";
  const projectRoot = `${workspaceRoot}/projects/${project}`;
  return `${PROJECT_CONTEXT_SECTION_HEADER}
This session runs on behalf of project "${project}".
Your current working directory is an ephemeral per-session scratch space that starts EMPTY — the project's source code is NOT here.
The project's cloned source lives under the shared workspace tree:
- Code: ${projectRoot}/production/code/<repo>
- Ticket worktrees: ${projectRoot}/backlogs/<ticketId>/code/<repo>
The <repo> directory name(s) are not fixed — list ${projectRoot}/production/code (and the relevant backlogs/<ticketId>/code) to discover them before reading or editing project code.
If those paths are missing or empty, the project likely has no repositories configured or has not been initialized yet — say so instead of guessing or asking for a repo URL.`;
}

/**
 * Render the forced "## Rules" section from the dashboard-delivered all-sessions
 * rule bodies (context.rules — already filtered to enabled + all-sessions and
 * deterministically ordered by the dashboard rules service). Multiple bodies are
 * joined with `\n\n---\n\n`, matching the core build-prompt convention
 * (composeRulesSections). Returns null when there are no rules so the section is
 * omitted entirely (no regression for sessions without all-sessions rules).
 */
export function renderRulesSection(rules) {
  const bodies = (Array.isArray(rules) ? rules : [])
    .map((body) => String(body ?? "").trim())
    .filter(Boolean);
  if (bodies.length === 0) return null;
  return `${RULES_SECTION_HEADER}\n${RULES_USAGE_NOTE}\n\n${bodies.join("\n\n---\n\n")}`;
}

/**
 * Replace the "## Rules" section inside an existing system message on resume so
 * rule edits reach resumed chat sessions (parallels refreshSystemMessageSkills).
 * Returns true when the section was found and replaced. When the resolved rules
 * are now empty the section body collapses to the header-less marker via
 * renderRulesSection returning null — in that case we leave the (stale) section
 * out by removing it; a missing prior section means there is nothing to swap.
 */
export function refreshSystemMessageRules(message, rules) {
  if (!message || message.role !== "system" || !Array.isArray(message.content)) return false;
  const block = message.content.find((part) => part?.kind === "text" && typeof part.text === "string");
  if (!block) return false;
  const marker = `\n\n${RULES_SECTION_HEADER}\n`;
  const markerIndex = block.text.indexOf(marker);
  if (markerIndex === -1) return false;
  const start = markerIndex + 2; // keep the leading section separator
  // Bound the section by the next KNOWN header, not a generic `\n\n## ` scan:
  // rule bodies routinely embed their own `## ` headers, and a generic scan
  // would stop at the first embedded header and leave the stale OLD body tail
  // past it preserved (or, on removal, orphan everything after it).
  const nextSection = findNextSectionBoundary(block.text, start);
  const tail = nextSection === -1
    ? (block.text.endsWith("\n") ? "\n" : "")
    : block.text.slice(nextSection);
  const rendered = renderRulesSection(rules);
  if (rendered) {
    block.text = block.text.slice(0, start) + rendered + tail;
  } else {
    // No rules anymore — drop the whole section including its leading `\n\n`
    // separator (markerIndex points at it). `tail` already begins with the next
    // section's own `\n\n` (or the trailing newline when Rules was last).
    block.text = block.text.slice(0, markerIndex) + tail;
  }
  return true;
}

const USER_ENV_SECTION_HEADER = USER_ENV_SECTION_HEADER_NAME;

/**
 * ADR 0024: tell the agent which user-defined env vars are present in its shell
 * (injected by Procway from the tenant + active project scopes) so it uses them
 * instead of asking the user. KEY NAMES ONLY — values (especially secrets) are
 * never placed in the prompt. `available` is the manager's summary
 * ({ key, isSecret }[]). `availableProjects` (Phase 3) are the project names the
 * agent can switch to via load_project_env. Returns null when there is neither
 * env nor any switchable project.
 */
export function renderUserEnvSection(available, { availableProjects = [] } = {}) {
  const hasEnv = Array.isArray(available) && available.length > 0;
  const projects = Array.isArray(availableProjects) ? availableProjects : [];
  if (!hasEnv && projects.length === 0) return null;
  const parts = [USER_ENV_SECTION_HEADER];
  if (hasEnv) {
    const lines = available.map((e) => `- ${e.key}${e.isSecret ? " (secret)" : ""}`).join("\n");
    parts.push(
      "The following user-defined environment variables are set in your shell environment (injected by Procway from this tenant / project). Reference them as $NAME in shell commands; do not ask the user for values you already have. Secret values are hidden — use them via $NAME but never print, echo, or log them.\n"
      + lines
    );
  }
  if (projects.length > 0) {
    parts.push(
      `Projects you can switch to: ${projects.join(", ")}. In a multi-project session, call load_project_env with a project name to load THAT project's env vars into your shell BEFORE running commands that need its credentials/config. It returns the available env var NAMES only (values are never shown).`
    );
  }
  return parts.join("\n\n");
}

/**
 * Resolve a filesystem path from PROCWAY_WORKSPACE_URI, which is a file:// URI
 * (e.g. file:///procway-workspaces) but may also be a bare path. Mirrors the
 * `file://` stripping in docker/runtime/entrypoint.sh.
 */
function workspaceRootFromUri(uri) {
  const value = String(uri ?? "").trim();
  if (!value) return null;
  if (value.startsWith("file://")) {
    const stripped = value.slice("file://".length);
    return stripped.replace(/\/+$/, "") || null;
  }
  return value.replace(/\/+$/, "") || null;
}

/**
 * Render the "## Available Skills" system-prompt section as a usable index:
 * one line per skill with name, single-line description, and the SKILL.md
 * path, plus an instruction to read the relevant SKILL.md before working
 * (progressive disclosure — skill bodies are never injected here).
 */
export function renderSkillsSection(skills) {
  const items = (skills ?? [])
    .slice(0, MAX_SKILLS)
    .map((item) => {
      const name = item.name || path.basename(path.dirname(item.path));
      const description = firstLine(item.description);
      const label = description ? `${name}: ${description}` : name;
      return `- ${label} (${item.path})`;
    })
    .join("\n");
  if (!items) return `${SKILLS_SECTION_HEADER}\n(no skills discovered)`;
  return `${SKILLS_SECTION_HEADER}\n${SKILLS_USAGE_NOTE}\n${items}`;
}

/**
 * Replace the "## Available Skills" section inside an existing system
 * message (used on session resume so the skills index reflects the current
 * workspace instead of the one captured at session creation).
 * Returns true when the section was found and replaced.
 */
export function refreshSystemMessageSkills(message, skills) {
  if (!message || message.role !== "system" || !Array.isArray(message.content)) return false;
  const block = message.content.find((part) => part?.kind === "text" && typeof part.text === "string");
  if (!block) return false;
  const marker = `\n\n${SKILLS_SECTION_HEADER}\n`;
  const markerIndex = block.text.lastIndexOf(marker);
  if (markerIndex === -1) return false;
  const start = markerIndex + 2; // keep the leading section separator
  // Bound by the next KNOWN header (see findNextSectionBoundary): consistent
  // with refreshSystemMessageRules and resilient to `## ` headers that could
  // appear after this section.
  const nextSection = findNextSectionBoundary(block.text, start);
  const tail = nextSection === -1
    ? (block.text.endsWith("\n") ? "\n" : "")
    : block.text.slice(nextSection);
  block.text = block.text.slice(0, start) + renderSkillsSection(skills) + tail;
  return true;
}

function firstLine(value) {
  const line = String(value ?? "").split("\n")[0].trim();
  if (line.length <= MAX_DESCRIPTION_LENGTH) return line;
  return `${line.slice(0, MAX_DESCRIPTION_LENGTH)}...`;
}

function truncate(value, maxLength) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n...[truncated]`;
}
