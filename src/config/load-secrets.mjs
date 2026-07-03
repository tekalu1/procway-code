import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function getUserSecretsPath(homeDir = os.homedir()) {
  return path.join(homeDir, ".procway", "ai-agent", "secrets.json");
}

export function getWorkspaceSecretsPath(workspaceDir) {
  return path.join(workspaceDir, ".procway", "ai-agent", "secrets.json");
}

function sanitize(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof key !== "string" || key.length === 0) continue;
    if (typeof value !== "string" || value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

async function readSecretsFile(filePath, onParseError) {
  if (!existsSync(filePath)) return {};
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    onParseError?.(filePath, error);
    return {};
  }
  try {
    return sanitize(JSON.parse(raw));
  } catch (error) {
    onParseError?.(filePath, error);
    return {};
  }
}

export async function readSecretsFiles({
  cwd = process.cwd(),
  homeDir = os.homedir(),
  onParseError = (file, error) => {
    console.warn(`[procway-code] failed to read ${file}: ${error.message}`);
  }
} = {}) {
  const userPath = getUserSecretsPath(homeDir);
  const workspacePath = getWorkspaceSecretsPath(path.resolve(cwd));
  const userSecrets = await readSecretsFile(userPath, onParseError);
  const workspaceSecrets = await readSecretsFile(workspacePath, onParseError);
  return { ...userSecrets, ...workspaceSecrets };
}

// env-priority by default: only fills keys that are absent or empty in `env`.
// Pass `overwrite: true` (hot-reload path) to rotate values even when env is
// already set — otherwise rotated secrets from secrets.json would never take
// effect without a process restart.
export function applySecretsToEnv(env, secrets, { overwrite = false } = {}) {
  if (!env || typeof env !== "object") return [];
  if (!secrets || typeof secrets !== "object") return [];
  const applied = [];
  for (const [key, value] of Object.entries(secrets)) {
    if (typeof key !== "string" || key.length === 0) continue;
    if (typeof value !== "string" || value.length === 0) continue;
    if (!overwrite && env[key] != null && env[key] !== "") continue;
    env[key] = value;
    applied.push(key);
  }
  return applied;
}

export async function applySecretsFromFiles({
  cwd = process.cwd(),
  homeDir = os.homedir(),
  env = process.env,
  onParseError,
  overwrite = false
} = {}) {
  const secrets = await readSecretsFiles({ cwd, homeDir, onParseError });
  const applied = applySecretsToEnv(env, secrets, { overwrite });
  return { secrets, applied };
}
