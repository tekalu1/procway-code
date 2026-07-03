import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { getWorkspaceSettingsPath } from "./load-settings.mjs";

export async function readWorkspaceSettings(cwd = process.cwd()) {
  const filePath = getWorkspaceSettingsPath(path.resolve(cwd));
  if (!existsSync(filePath)) return {};
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function writeWorkspaceSettings(cwd = process.cwd(), settings) {
  const filePath = getWorkspaceSettingsPath(path.resolve(cwd));
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return filePath;
}

export async function setWorkspaceSetting({ cwd = process.cwd(), key, value }) {
  const settings = await readWorkspaceSettings(cwd);
  setByPath(settings, key, parseConfigValue(value));
  const pathWritten = await writeWorkspaceSettings(cwd, settings);
  return { path: pathWritten, key, value: getByPath(settings, key) };
}

function setByPath(target, key, value) {
  const parts = key.split(".");
  let current = target;
  for (const part of parts.slice(0, -1)) {
    if (!current[part] || typeof current[part] !== "object" || Array.isArray(current[part])) {
      current[part] = {};
    }
    current = current[part];
  }
  current[parts.at(-1)] = value;
}

function getByPath(target, key) {
  return key.split(".").reduce((value, part) => value?.[part], target);
}

function parseConfigValue(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
