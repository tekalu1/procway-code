import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const AUTH_PROFILES_FILENAME = "auth-profiles.json";
const LOCK_RETRY_DELAY_MS = 25;
const LOCK_MAX_WAIT_MS = 5_000;

export function getUserAuthProfilesPath(homeDir = os.homedir()) {
  return path.join(homeDir, ".procway", "ai-agent", AUTH_PROFILES_FILENAME);
}

export function getWorkspaceAuthProfilesPath(workspaceDir) {
  return path.join(workspaceDir, ".procway", "ai-agent", AUTH_PROFILES_FILENAME);
}

function emptyStoreShape() {
  return { profiles: {} };
}

function sanitizeStore(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyStoreShape();
  const profiles = parsed.profiles;
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) return emptyStoreShape();
  const out = { profiles: {} };
  for (const [id, profile] of Object.entries(profiles)) {
    if (!profile || typeof profile !== "object") continue;
    const provider = typeof profile.provider === "string" ? profile.provider : null;
    const mode = typeof profile.mode === "string" ? profile.mode : null;
    if (!provider || !mode) continue;
    const credentials = profile.credentials && typeof profile.credentials === "object" ? profile.credentials : null;
    out.profiles[id] = {
      provider,
      mode,
      credentials,
      updatedAt: typeof profile.updatedAt === "string" ? profile.updatedAt : null
    };
  }
  return out;
}

async function readStoreFile(filePath) {
  if (!existsSync(filePath)) return emptyStoreShape();
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return emptyStoreShape();
    throw error;
  }
  if (!raw.trim()) return emptyStoreShape();
  try {
    return sanitizeStore(JSON.parse(raw));
  } catch (error) {
    throw new Error(`auth-profiles.json is not valid JSON (${filePath}): ${error.message}`);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLock(filePath) {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      // Stash the pid for post-mortem; we never read it back, so no parsing needed.
      try { await handle.writeFile(`${process.pid}\n`); } catch { /* best-effort */ }
      await handle.close();
      return {
        async release() {
          try { await rm(lockPath, { force: true }); } catch { /* ignore */ }
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for auth-profiles.json lock at ${lockPath}. If you are sure no other process holds it, delete the file manually.`);
      }
      await delay(LOCK_RETRY_DELAY_MS);
    }
  }
}

async function atomicWriteJson(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  await writeFile(tmpPath, payload, { mode: 0o600, encoding: "utf8" });
  await rename(tmpPath, filePath);
}

/**
 * Resolve which auth-profiles.json file to use for reads. We prefer a workspace
 * file when one already exists (so per-repo logins stay scoped) and fall back
 * to the user-level file otherwise.
 *
 * @param {{ cwd?: string; homeDir?: string }} [options]
 * @returns {{ readPath: string; writePath: string; userPath: string; workspacePath: string }}
 */
export function resolveAuthProfilesPaths({ cwd = process.cwd(), homeDir = os.homedir() } = {}) {
  const userPath = getUserAuthProfilesPath(homeDir);
  const workspacePath = getWorkspaceAuthProfilesPath(path.resolve(cwd));
  const workspaceExists = existsSync(workspacePath);
  return {
    userPath,
    workspacePath,
    readPath: workspaceExists ? workspacePath : userPath,
    // Writes default to user-level — auth state is per-user, not per-repo,
    // unless the user has explicitly created a workspace file (e.g., for CI).
    writePath: workspaceExists ? workspacePath : userPath
  };
}

/**
 * Read the full store. Returns a fresh object even when the file is missing.
 *
 * @param {{ cwd?: string; homeDir?: string; pathOverride?: string }} [options]
 */
export async function readAuthProfilesStore(options = {}) {
  const filePath = options.pathOverride ?? resolveAuthProfilesPaths(options).readPath;
  const store = await readStoreFile(filePath);
  return { filePath, store };
}

/**
 * Read a single profile, or null when it does not exist.
 *
 * @param {string} profileId
 * @param {{ cwd?: string; homeDir?: string; pathOverride?: string }} [options]
 */
export async function readAuthProfile(profileId, options = {}) {
  const { store } = await readAuthProfilesStore(options);
  return store.profiles[profileId] ?? null;
}

/**
 * Read-modify-write a single profile inside the cross-process lock. The
 * mutator receives the current profile (or null if absent) and must return
 * either the new profile or null to delete it.
 *
 * @param {string} profileId
 * @param {(profile: object | null) => Promise<object | null> | object | null} mutator
 * @param {{ cwd?: string; homeDir?: string; pathOverride?: string }} [options]
 */
export async function updateAuthProfile(profileId, mutator, options = {}) {
  const paths = resolveAuthProfilesPaths(options);
  const filePath = options.pathOverride ?? paths.writePath;
  await mkdir(path.dirname(filePath), { recursive: true });
  const lock = await acquireLock(filePath);
  try {
    const store = await readStoreFile(filePath);
    const before = store.profiles[profileId] ?? null;
    const next = await mutator(before);
    if (next === null) {
      delete store.profiles[profileId];
    } else {
      store.profiles[profileId] = {
        ...next,
        updatedAt: new Date().toISOString()
      };
    }
    await atomicWriteJson(filePath, store);
    return { filePath, profile: store.profiles[profileId] ?? null };
  } finally {
    await lock.release();
  }
}

/**
 * Convenience writer for the common case: persist an OAuth credential bundle
 * under a profile. Always sets mode: "oauth".
 *
 * @param {string} profileId
 * @param {string} provider
 * @param {{ access: string; refresh: string; expires: number; accountId?: string }} credentials
 * @param {{ cwd?: string; homeDir?: string; pathOverride?: string }} [options]
 */
export async function writeOAuthProfile(profileId, provider, credentials, options = {}) {
  return updateAuthProfile(
    profileId,
    () => ({ provider, mode: "oauth", credentials }),
    options
  );
}

/**
 * Delete a profile. No-op when the profile does not exist.
 *
 * @param {string} profileId
 * @param {{ cwd?: string; homeDir?: string; pathOverride?: string }} [options]
 */
export async function deleteAuthProfile(profileId, options = {}) {
  return updateAuthProfile(profileId, () => null, options);
}
