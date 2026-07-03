import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { DEFAULT_SETTINGS } from "./default-settings.mjs";
import { getUserSettingsPath, getWorkspaceSettingsPath } from "./load-settings.mjs";

export async function initSettings({ cwd = process.cwd(), scope = "workspace", force = false } = {}) {
  if (!["workspace", "user"].includes(scope)) {
    throw new Error("settings init scope must be workspace or user");
  }
  const filePath = scope === "user" ? getUserSettingsPath() : getWorkspaceSettingsPath(path.resolve(cwd));
  if (existsSync(filePath) && !force) {
    return { path: filePath, created: false, reason: "exists" };
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(DEFAULT_SETTINGS, null, 2) + "\n", "utf8");
  return { path: filePath, created: true };
}
