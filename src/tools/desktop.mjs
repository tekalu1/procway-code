import path from "node:path";
import { accessSync, statSync, constants as fsConstants } from "node:fs";
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";

const REQUIRED_BINARIES = ["xdotool", "scrot"];

const ACTION_ALIASES = new Map([
  ["screen", "screenshot"],
  ["capture", "screenshot"],
  ["move", "mouse_move"],
  ["mouse", "mouse_click"],
  ["click", "mouse_click"],
  ["press", "key"],
  ["hotkey", "key"]
]);

const VALID_BUTTONS = new Set(["left", "middle", "right"]);
const BUTTON_NUMBERS = { left: 1, middle: 2, right: 3 };

/**
 * Run a small, self-contained desktop automation script against the
 * runtime container's Xvfb desktop (visible to the user via noVNC).
 *
 * Backed by `xdotool` (mouse/keyboard) and `scrot` (screenshot). Both must
 * be installed in the runtime image and an X server must be reachable via
 * the DISPLAY env (runtime entrypoint exports DISPLAY=:1).
 */
export async function runDesktopAction({ cwd, steps, runCommand = defaultRunCommand, display } = {}) {
  const normalizedSteps = normalizeSteps(steps);
  const env = { ...process.env };
  const resolvedDisplay = display ?? process.env.DISPLAY ?? ":1";
  env.DISPLAY = resolvedDisplay;

  const outputs = [];
  for (const [index, step] of normalizedSteps.entries()) {
    const action = canonicalAction(step.action);
    if (action === "screenshot") {
      requireString(step.path, `steps[${index}].path`);
      const resolvedPath = resolveWorkspacePath(cwd, step.path);
      await mkdir(path.dirname(resolvedPath), { recursive: true });
      const args = ["--overwrite"];
      if (step.delayMs && Number.isFinite(step.delayMs)) {
        args.push("--delay", String(Math.max(0, Math.round(step.delayMs / 1000))));
      }
      args.push(resolvedPath);
      await runCommand("scrot", args, { env });
      outputs.push({ action, path: path.relative(cwd, resolvedPath) });
    } else if (action === "mouse_move") {
      const x = requireInteger(step.x, `steps[${index}].x`);
      const y = requireInteger(step.y, `steps[${index}].y`);
      await runCommand("xdotool", ["mousemove", "--sync", String(x), String(y)], { env });
      outputs.push({ action, x, y });
    } else if (action === "mouse_click") {
      const button = canonicalButton(step.button ?? "left", `steps[${index}].button`);
      const buttonNumber = BUTTON_NUMBERS[button];
      if (step.x !== undefined || step.y !== undefined) {
        const x = requireInteger(step.x, `steps[${index}].x`);
        const y = requireInteger(step.y, `steps[${index}].y`);
        await runCommand("xdotool", ["mousemove", "--sync", String(x), String(y), "click", String(buttonNumber)], { env });
        outputs.push({ action, x, y, button });
      } else {
        await runCommand("xdotool", ["click", String(buttonNumber)], { env });
        outputs.push({ action, button });
      }
    } else if (action === "type") {
      requireString(step.text, `steps[${index}].text`);
      const args = ["type"];
      if (step.delayMs && Number.isFinite(step.delayMs)) {
        args.push("--delay", String(Math.max(0, Math.round(step.delayMs))));
      }
      args.push("--", step.text);
      await runCommand("xdotool", args, { env });
      outputs.push({ action, textLength: step.text.length });
    } else if (action === "key") {
      requireString(step.keys, `steps[${index}].keys`);
      // xdotool key accepts space-separated combos: e.g. "Return", "ctrl+c",
      // "alt+Tab". Split on whitespace so callers can chain ("ctrl+a Delete").
      const tokens = step.keys.trim().split(/\s+/).filter(Boolean);
      await runCommand("xdotool", ["key", "--", ...tokens], { env });
      outputs.push({ action, keys: step.keys });
    } else {
      throw new Error(`Unsupported desktop action: ${step.action}`);
    }
  }

  return {
    kind: "desktop_action",
    summary: `Desktop action completed: ${outputs.map((entry) => entry.action).join(" -> ")}`,
    data: { steps: outputs, display: resolvedDisplay }
  };
}

function normalizeSteps(input) {
  const rawSteps = Array.isArray(input) ? input : [input];
  const steps = rawSteps.filter(Boolean);
  if (steps.length === 0) throw new Error("desktop_action requires at least one step");
  return steps;
}

function canonicalAction(action) {
  if (typeof action !== "string" || !action.trim()) throw new Error("Each desktop step requires an action");
  const lowered = action.trim().toLowerCase();
  return ACTION_ALIASES.get(lowered) ?? lowered;
}

function canonicalButton(button, label) {
  if (typeof button !== "string") throw new Error(`${label} must be a string`);
  const lowered = button.trim().toLowerCase();
  if (!VALID_BUTTONS.has(lowered)) {
    throw new Error(`${label} must be one of left|middle|right`);
  }
  return lowered;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
}

function requireInteger(value, label) {
  const num = Number(value);
  if (!Number.isInteger(num)) throw new Error(`${label} must be an integer`);
  return num;
}

/**
 * Registration-time availability probe (ADR 0030 D5). desktop_action only
 * works where xdotool + scrot are installed AND an X display is exported —
 * the reference runtime image guarantees both (Dockerfile installs the
 * binaries, entrypoint exports DISPLAY=:1). On hosts without them the tool
 * is not registered at all instead of failing at spawn time, so DISPLAY
 * being unset is treated as "no desktop here" (no implicit ":1" here — the
 * runner's fallback only matters once the tool was registered).
 * `findBinary` is injectable for tests, like `runCommand` above.
 */
export function getDesktopActionAvailability({ env = process.env, findBinary = findBinaryOnPath } = {}) {
  const reasons = REQUIRED_BINARIES
    .filter((binary) => !findBinary(binary, env))
    .map((binary) => `missing binary ${binary}`);
  if (!env.DISPLAY) reasons.push("DISPLAY unset");
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
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const detail = (stderr || stdout || "").trim().slice(0, 500);
        reject(new Error(`${command} exited with code ${code}${detail ? `: ${detail}` : ""}`));
      }
    });
  });
}
