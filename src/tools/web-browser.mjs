import path from "node:path";
import { accessSync, statSync, constants as fsConstants } from "node:fs";
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";

const DEFAULT_BINARY = "agent-browser";
const DEFAULT_EXECUTABLE_PATH = "/usr/bin/chromium";
const DEFAULT_ARGS = "--no-sandbox,--disable-dev-shm-usage";
const DEFAULT_DISPLAY = ":1";

const ACTION_ALIASES = new Map([
  ["goto", "navigate"],
  ["open", "navigate"],
  ["nav", "navigate"],
  ["input", "fill"],
  ["snap", "snapshot"],
  ["screen", "screenshot"],
  ["text", "get_text"],
  ["gettext", "get_text"],
  ["keys", "press"],
  ["key", "press"]
]);

// Steps that change page state — gated as mutations for approval. Read-only
// steps (navigate/snapshot/get_text/screenshot/wait/back/reload) mirror the
// non-mutating treatment the legacy browser_action gave navigate+screenshot.
const MUTATION_ACTIONS = new Set(["click", "fill", "type", "press", "select", "check", "uncheck", "scroll", "drag", "upload"]);

/**
 * Drive a persistent agent-browser daemon (vercel-labs/agent-browser) through
 * a bounded sequence of page actions.
 *
 * Unlike the legacy Playwright-backed `browser_action` (fresh browser per
 * call), agent-browser keeps the browser alive across tool calls via its
 * daemon, so the natural workflow is: navigate -> snapshot (read @refs) ->
 * click/fill the ref the model just saw -> snapshot again. `snapshot` and
 * `get_text` steps return their output in the result `data` so the model can
 * pick refs for a follow-up call.
 *
 * Backed by the `agent-browser` CLI (spawned per step with --json via the
 * AGENT_BROWSER_JSON env). The launch recipe (existing chromium, --no-sandbox,
 * headed on DISPLAY :1) is validated in ADR 0007 Phase 0.
 */
export async function runWebBrowserAction({ cwd, steps, runCommand = defaultRunCommand, settings, display } = {}) {
  const normalizedSteps = normalizeSteps(steps);
  const cfg = settings?.tools?.browser ?? {};
  const binary = cfg.binary ?? DEFAULT_BINARY;
  const env = buildEnv({ cfg, display });

  const outputs = [];
  for (const [index, step] of normalizedSteps.entries()) {
    const action = canonicalAction(step.action);
    const { args, finalize, prep } = buildStep({ action, step, index, cwd });
    if (prep) await prep();
    const { stdout, stderr, code } = await runCommand(binary, args, { env });
    const parsed = parseResult({ action, stdout, stderr, code });
    outputs.push(finalize ? finalize(parsed) : { action, ...parsed });
  }

  return {
    kind: "browser_action",
    summary: `web_browser: ${outputs.map((entry) => entry.action).join(" -> ")}`,
    data: { steps: outputs }
  };
}

/**
 * Map one normalized step to an agent-browser argv + an optional finalizer
 * that shapes the per-step output entry from the parsed JSON `data`.
 */
function buildStep({ action, step, index, cwd }) {
  switch (action) {
    case "navigate": {
      requireString(step.url, `steps[${index}].url`);
      return { args: ["open", step.url], finalize: (p) => ({ action, url: p.data?.url ?? step.url, title: p.data?.title ?? null }) };
    }
    case "snapshot": {
      const args = ["snapshot"];
      if (step.interactiveOnly !== false) args.push("-i");
      if (step.compact !== false) args.push("-c");
      return { args, finalize: (p) => ({ action, snapshot: p.data?.snapshot ?? "", refs: p.data?.refs ?? {} }) };
    }
    case "click": {
      const target = requireTarget(step, index);
      return { args: ["click", target], finalize: (p) => ({ action, target, clicked: p.data?.clicked ?? target }) };
    }
    case "fill": {
      const target = requireTarget(step, index);
      requireString(step.text, `steps[${index}].text`);
      return { args: ["fill", target, step.text], finalize: () => ({ action, target, textLength: step.text.length }) };
    }
    case "type": {
      requireString(step.text, `steps[${index}].text`);
      // No selector: real keystrokes into the focused element.
      return { args: ["keyboard", "type", step.text], finalize: () => ({ action, textLength: step.text.length }) };
    }
    case "press": {
      requireString(step.keys, `steps[${index}].keys`);
      return { args: ["press", step.keys], finalize: () => ({ action, keys: step.keys }) };
    }
    case "get_text": {
      // `agent-browser get text` requires a target; default to the whole page
      // body when the caller passes neither a ref nor a selector.
      const target = step.ref ?? step.selector ?? "body";
      return { args: ["get", "text", target], finalize: (p) => ({ action, target, text: p.data?.text ?? "" }) };
    }
    case "screenshot": {
      requireString(step.path, `steps[${index}].path`);
      const resolvedPath = resolveWorkspacePath(cwd, step.path);
      const args = ["screenshot", resolvedPath];
      if (step.fullPage) args.push("--full");
      if (step.annotate) args.push("--annotate");
      return {
        args,
        // mkdir is async; do it in the finalizer's sibling — handled below.
        prep: async () => mkdir(path.dirname(resolvedPath), { recursive: true }),
        finalize: () => ({ action, path: path.relative(cwd, resolvedPath), annotate: step.annotate === true })
      };
    }
    case "wait": {
      const value = step.selector ?? step.ms ?? step.value;
      requireDefined(value, `steps[${index}].selector|ms`);
      return { args: ["wait", String(value)], finalize: () => ({ action, waited: String(value) }) };
    }
    case "scroll": {
      const dir = (step.direction ?? "down").toLowerCase();
      const args = ["scroll", dir];
      if (step.px != null) args.push(String(step.px));
      return { args, finalize: () => ({ action, direction: dir, px: step.px ?? null }) };
    }
    case "back":
      return { args: ["back"], finalize: () => ({ action }) };
    case "reload":
      return { args: ["reload"], finalize: () => ({ action }) };
    default:
      throw new Error(`Unsupported web_browser action: ${step.action}`);
  }
}

function buildEnv({ cfg, display }) {
  const env = { ...process.env };
  env.AGENT_BROWSER_JSON = "1";
  env.AGENT_BROWSER_EXECUTABLE_PATH = cfg.executablePath ?? process.env.AGENT_BROWSER_EXECUTABLE_PATH ?? DEFAULT_EXECUTABLE_PATH;
  env.AGENT_BROWSER_ARGS = cfg.args ?? process.env.AGENT_BROWSER_ARGS ?? DEFAULT_ARGS;
  env.DISPLAY = display ?? cfg.display ?? process.env.DISPLAY ?? DEFAULT_DISPLAY;
  // Headed by default so the noVNC desktop viewer shows the browser working.
  const headed = cfg.headed ?? true;
  if (headed) env.AGENT_BROWSER_HEADED = "1";
  else delete env.AGENT_BROWSER_HEADED;
  const session = cfg.session ?? process.env.AGENT_BROWSER_SESSION;
  if (session) env.AGENT_BROWSER_SESSION = session;
  const idle = cfg.idleTimeoutMs ?? process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS;
  if (idle != null) env.AGENT_BROWSER_IDLE_TIMEOUT_MS = String(idle);
  return env;
}

function parseResult({ action, stdout, stderr, code }) {
  const json = extractJson(stdout);
  if (json) {
    if (json.success === false) {
      const message = json.error ?? `agent-browser ${action} reported failure`;
      throw new Error(`web_browser ${action} failed: ${message}`);
    }
    return { data: json.data ?? {} };
  }
  // No parseable JSON: treat a clean exit as success with no structured data,
  // otherwise surface the stderr/stdout tail.
  if (code === 0) return { data: {} };
  const detail = (stderr || stdout || "").trim().slice(0, 500);
  throw new Error(`web_browser ${action} failed (exit ${code})${detail ? `: ${detail}` : ""}`);
}

/**
 * agent-browser prints a single JSON object on stdout under AGENT_BROWSER_JSON,
 * but daemon spin-up / upgrade notices can prepend noise. Parse the last
 * brace-delimited JSON object on stdout.
 */
function extractJson(stdout) {
  if (typeof stdout !== "string") return null;
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.lastIndexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function normalizeSteps(input) {
  const rawSteps = Array.isArray(input) ? input : [input];
  const steps = rawSteps.filter(Boolean);
  if (steps.length === 0) throw new Error("web_browser requires at least one step");
  return steps;
}

function canonicalAction(action) {
  if (typeof action !== "string" || !action.trim()) throw new Error("Each web_browser step requires an action");
  const lowered = action.trim().toLowerCase();
  return ACTION_ALIASES.get(lowered) ?? lowered;
}

export function isWebBrowserMutationStep(action) {
  return MUTATION_ACTIONS.has(canonicalAction(action));
}

function requireTarget(step, index) {
  const target = step.ref ?? step.selector;
  if (typeof target !== "string" || target.length === 0) {
    throw new Error(`steps[${index}] requires a ref (e.g. "@e2") or selector`);
  }
  return target;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
}

function requireDefined(value, label) {
  if (value === undefined || value === null || value === "") throw new Error(`${label} must be provided`);
}

/**
 * Registration-time availability probe (ADR 0030 D5). web_browser spawns the
 * `agent-browser` CLI, which in turn launches the browser executable that
 * buildEnv pins via AGENT_BROWSER_EXECUTABLE_PATH (default /usr/bin/chromium)
 * — so chromium presence matters inside agent-browser, not at our spawn, and
 * is probed here as the resolved executable path. A display is also required
 * when the browser runs headed (the default, so the noVNC desktop shows it);
 * the reference runtime image guarantees all three (Dockerfile installs
 * chromium + agent-browser, entrypoint exports DISPLAY=:1). The probe mirrors
 * buildEnv's resolution exactly, including the settings-level overrides
 * (settings.tools.browser.binary/executablePath/display, and headed:false
 * which drops the display requirement) — a setup that would work at execution
 * time must not be de-registered. `findBinary` is injectable for tests, like
 * `runCommand` above.
 */
export function getWebBrowserAvailability({ env = process.env, settings, findBinary = findBinaryOnPath } = {}) {
  const cfg = settings?.tools?.browser ?? {};
  const reasons = [];
  const binary = cfg.binary ?? DEFAULT_BINARY;
  if (!findBinary(binary, env)) reasons.push(`missing binary ${binary}`);
  const executablePath = cfg.executablePath ?? env.AGENT_BROWSER_EXECUTABLE_PATH ?? DEFAULT_EXECUTABLE_PATH;
  // An empty override (e.g. a templated env left blank) is forwarded as-is by
  // buildEnv and breaks the browser launch — treat it as missing, not default.
  if (!executablePath || !findBinary(executablePath, env)) {
    reasons.push(`missing browser executable ${executablePath || "(empty)"}`);
  }
  const headed = cfg.headed ?? true;
  if (headed && !(cfg.display ?? env.DISPLAY)) reasons.push("DISPLAY unset");
  return reasons.length > 0 ? { available: false, reason: reasons.join(", ") } : { available: true };
}

function findBinaryOnPath(binary, env = process.env) {
  if (path.isAbsolute(binary)) return isExecutableFile(binary);
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (dir && isExecutableFile(path.join(dir, binary))) return true;
  }
  return false;
}

function isExecutableFile(filePath) {
  try {
    // X_OK alone passes on directories (search permission) — require a file.
    accessSync(filePath, fsConstants.X_OK);
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function resolveWorkspacePath(cwd, filePath) {
  if (typeof filePath !== "string" || !filePath) throw new Error("path must be a non-empty string");
  if (path.isAbsolute(filePath)) throw new Error("Screenshot path must be workspace-relative");
  const root = path.resolve(cwd);
  const resolved = path.resolve(root, filePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Screenshot path must stay inside the workspace");
  }
  return resolved;
}

function defaultRunCommand(command, args, { env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (err) => {
      reject(new Error(`${command} failed to spawn: ${err?.message ?? err}`));
    });
    // Resolve regardless of exit code: agent-browser encodes action failures in
    // its JSON ({"success":false,"error":...}), which parseResult interprets.
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}
