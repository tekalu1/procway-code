/**
 * User-defined environment variables, distributed by the dashboard as a
 * derived snapshot file (issue #30 hot-reload — same pattern as the
 * connections snapshot): `<workspaceDir>/.procway/ai-agent/user-env.json`.
 *
 * Shape:
 *   { "version": 1,
 *     "vars": {
 *       "tenant":   { "KEY": "value", ... },
 *       "projects": { "<project>": { "KEY": "value", ... } } } }
 *
 * The agent merges the tenant scope with the bucket of ITS OWN project
 * (PROCWAY_SESSION_PROJECT, injected by the spawn wiring) — project wins —
 * and applies the result to `process.env` so every subsequent tool spawn
 * (run_shell / shell-manager spread `process.env`) sees the live values.
 *
 * Deletion works because the manager tracks every key IT applied: a key that
 * disappears from the snapshot is removed from `process.env` on the next
 * reload. Keys the manager never touched (system wiring, image ENV) are never
 * deleted.
 *
 * Reserved keys are dropped here as the LAST line of the same defense the
 * dashboard applies on write (`isReservedEnvKey`) and at the spawn boundary
 * (`buildUserEnv`) — a hand-edited snapshot must not shadow the broker token,
 * credentials, or the container identity/runtime wiring.
 */
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync } from "node:fs";
import path from "node:path";

export function getUserEnvPath(workspaceDir) {
  return path.join(workspaceDir, ".procway", "ai-agent", "user-env.json");
}

/**
 * ADR 0024 Phase 2: the ACTIVE project marker. The user-env manager resolves the
 * active project from this file when present, else falls back to the spawn-time
 * `PROCWAY_SESSION_PROJECT` env. A separate process (e.g. the Phase 3 MCP, or any
 * driver) can switch the active project AT RUNTIME by writing a project name
 * here — it cannot mutate the agent's in-memory `process.env` directly. The
 * hot-reload watcher reacts to changes and re-applies the env (the project
 * bucket swap is the manager's normal add/remove diff). Empty / missing ⇒ fall
 * back.
 */
export function getActiveProjectPath(workspaceDir) {
  return path.join(workspaceDir, ".procway", "ai-agent", "active-project");
}

/** Resolve the active project: marker file (runtime-mutable) wins, else the
 *  spawn-time `PROCWAY_SESSION_PROJECT` env (pre-seed). Returns null when neither
 *  yields a non-empty name. */
export function readActiveProject(workspaceDir, env = process.env) {
  const markerPath = getActiveProjectPath(workspaceDir);
  if (existsSync(markerPath)) {
    try {
      const marker = readFileSync(markerPath, "utf8").trim();
      if (marker) return marker;
    } catch {
      // Unreadable marker → fall back to the spawn-time env (never throw here;
      // a transient read race must not wipe the live project selection).
    }
  }
  return env.PROCWAY_SESSION_PROJECT || null;
}

/** Atomically set (or, with a falsy value, clear) the active-project marker.
 *  Clearing falls back to `PROCWAY_SESSION_PROJECT`. Used by runtime drivers /
 *  the Phase 3 MCP and by tests. */
export function writeActiveProject(workspaceDir, project) {
  const markerPath = getActiveProjectPath(workspaceDir);
  const name = project == null ? "" : String(project).trim();
  if (!name) {
    try { rmSync(markerPath, { force: true }); } catch { /* already absent */ }
    return;
  }
  mkdirSync(path.dirname(markerPath), { recursive: true });
  const tmp = `${markerPath}.tmp`;
  writeFileSync(tmp, name, "utf8");
  renameSync(tmp, markerPath); // atomic swap so the watcher never sees a partial write
}

/** Mirrors dashboard/server/env-vars/store.ts RESERVED_EXACT, plus the
 *  runtime-image wiring names that only exist on the Pod side. */
const RESERVED_EXACT = new Set([
  "GH_TOKEN",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "DISPLAY",
  "HOME",
  "PATH",
  "NVM_DIR",
  "NODE_OPTIONS",
  "SHELL",
  "USER",
  "LOGNAME",
  // runtime-image wiring (docker/runtime) — not user-overridable either.
  "AGENT_BROWSER_ARGS",
  "XVFB_RESOLUTION",
  "VNC_PORT",
  "NOVNC_PORT",
  "NVM_SNAPSHOT",
  "XDG_CACHE_HOME",
  "npm_config_cache"
]);

const RESERVED_PREFIXES = ["PROCWAY_"];

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isReservedUserEnvKey(key) {
  if (RESERVED_EXACT.has(key)) return true;
  return RESERVED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Merge the tenant bucket with the session's project bucket (project wins),
 *  keeping only valid, non-reserved string→string pairs. Returns
 *  { desired, skipped } where skipped lists reserved/invalid keys. */
export function mergeUserEnvScopes(vars, { project = null } = {}) {
  const buckets = [];
  if (vars && typeof vars === "object") {
    if (vars.tenant && typeof vars.tenant === "object") buckets.push(vars.tenant);
    if (project && vars.projects && typeof vars.projects === "object") {
      const bucket = vars.projects[project];
      if (bucket && typeof bucket === "object") buckets.push(bucket);
    }
  }
  const desired = {};
  const skipped = [];
  for (const bucket of buckets) {
    for (const [key, value] of Object.entries(bucket)) {
      if (typeof value !== "string") continue;
      if (!ENV_KEY_PATTERN.test(key) || isReservedUserEnvKey(key)) {
        if (!skipped.includes(key)) skipped.push(key);
        continue;
      }
      desired[key] = value; // later buckets (project) override earlier (tenant)
    }
  }
  return { desired, skipped };
}

/**
 * ADR 0024: list the user-defined env vars available for the active scopes
 * (tenant + active project) with secret flags — KEY NAMES ONLY, never values.
 * The prompt-builder renders these so the agent knows what's in its shell and
 * references them via $NAME. Project overrides tenant on duplicate keys; the
 * snapshot already excludes reserved keys. Returns a key-sorted array of
 * { key, isSecret }.
 *
 * @param {{ vars?: any, secretKeys?: any } | null} snapshot
 * @param {{ project?: string | null }} opts
 */
export function summarizeAvailableEnv(snapshot, { project = null } = {}) {
  const vars = snapshot?.vars ?? {};
  const secret = snapshot?.secretKeys ?? {};
  const out = new Map();
  const add = (bucket, secretKeyList) => {
    if (!bucket || typeof bucket !== "object") return;
    const ss = new Set(Array.isArray(secretKeyList) ? secretKeyList : []);
    for (const key of Object.keys(bucket)) out.set(key, { key, isSecret: ss.has(key) });
  };
  add(vars.tenant, secret.tenant); // tenant first…
  if (project) add(vars.projects?.[project], secret.projects?.[project]); // …project overrides
  return [...out.values()].sort((a, b) => a.key.localeCompare(b.key));
}

// Latest available-env summary, refreshed by the manager's reload() (startup +
// hot-reload). The prompt-builder reads this synchronously at prompt-build time
// so it reflects the live snapshot. One agent process = one manager, so a
// module-level holder is sufficient.
let _latestUserEnvSummary = [];
// Project NAMES present in the latest snapshot (this tenant's projects only —
// the snapshot is per-tenant). Used to validate / advertise switch targets.
let _availableProjects = [];
// The live manager (its workspaceDir + reload), registered on creation so the
// load_project_env tool can switch the active project and re-apply without
// threading the manager through the tool layer.
let _activeManager = null;

/** ADR 0024: the available user env vars (key names + secret flags) the manager
 *  last applied. Empty until the first reload(). */
export function getUserEnvSummary() {
  return _latestUserEnvSummary;
}

/** ADR 0024 Phase 3: project names available to switch to (this tenant's
 *  projects, from the snapshot). */
export function getAvailableProjects() {
  return _availableProjects;
}

/**
 * ADR 0024 Phase 3 (effectful, values never returned): switch the ACTIVE project
 * at runtime. Writes the marker (Phase 2) and re-applies the env immediately, so
 * the next tool subprocess sees the new project's vars. Returns the now-available
 * KEY NAMES + secret flags — NEVER values. A falsy/empty project clears the
 * marker (revert to the spawn-time PROCWAY_SESSION_PROJECT, or tenant-only).
 * Throws PROJECT_NOT_AVAILABLE for a name not in this tenant's snapshot.
 */
export async function setActiveProject(project) {
  if (!_activeManager) throw new Error("user-env manager is not initialized");
  const name = project == null ? "" : String(project).trim();
  if (name && !_availableProjects.includes(name)) {
    const err = new Error(`project "${name}" is not available in this session`);
    err.code = "PROJECT_NOT_AVAILABLE";
    throw err;
  }
  writeActiveProject(_activeManager.markerDir, name);
  await _activeManager.reload(); // immediate apply; the watcher's later reload is a no-op
  return { project: name || null, available: getUserEnvSummary() };
}

/**
 * Stateful applier: tracks the keys it set so a later reload can delete the
 * ones that disappeared from the snapshot.
 *
 * `workspaceDir` is the (read-only, dashboard-owned) shared workspace where the
 * user-env.json snapshot lives. `markerDir` is a WRITABLE per-session dir for the
 * active-project marker (ADR 0024 Phase 2/3): the in-Pod load_project_env tool
 * writes it, and the shared workspace is mounted read-only, so the marker must
 * NOT live next to the snapshot. Defaults to `workspaceDir` (fine for tests /
 * single-dir setups).
 *
 * @param {{ workspaceDir: string, markerDir?: string, env?: NodeJS.ProcessEnv, onWarn?: (msg: string) => void }} input
 * @returns {{ path: string, reload: () => Promise<{applied: string[], removed: string[], skipped: string[]} | null> }}
 */
export function createUserEnvManager({ workspaceDir, markerDir = workspaceDir, env = process.env, onWarn = () => {} }) {
  const filePath = getUserEnvPath(workspaceDir);
  const appliedKeys = new Set();

  async function reload() {
    let vars = null;
    let secretKeys = null;
    if (existsSync(filePath)) {
      let raw;
      try {
        raw = await readFile(filePath, "utf8");
      } catch (error) {
        onWarn(`user-env: failed to read ${filePath} (${error?.message ?? error}) — keeping previous values`);
        return null;
      }
      try {
        const parsed = JSON.parse(raw);
        vars = parsed?.vars ?? null;
        secretKeys = parsed?.secretKeys ?? null;
      } catch (error) {
        // A torn/corrupt snapshot must not wipe the live values; the
        // dashboard's next atomic write replaces it cleanly.
        onWarn(`user-env: corrupt JSON at ${filePath} (${error?.message ?? error}) — keeping previous (STALE) values`);
        return null;
      }
    }
    // Missing file ⇒ empty desired set: every previously applied key is removed
    // (the user deleted their last var / the snapshot was reset).
    // ADR 0024 Phase 2: the active project is runtime-mutable via the marker file
    // (falls back to the spawn-time PROCWAY_SESSION_PROJECT). A marker change is
    // watched and triggers this reload, swapping the applied project bucket.
    const project = readActiveProject(markerDir, env);
    const { desired, skipped } = mergeUserEnvScopes(vars, { project });
    // ADR 0024: refresh the prompt-facing summary (key names + secret flags) on
    // every successful (re)load so the system prompt reflects the live snapshot.
    _latestUserEnvSummary = summarizeAvailableEnv({ vars, secretKeys }, { project });
    // ADR 0024 Phase 3: advertise this tenant's switchable project names.
    _availableProjects = vars && vars.projects && typeof vars.projects === "object"
      ? Object.keys(vars.projects).sort()
      : [];

    const removed = [];
    for (const key of [...appliedKeys]) {
      if (!(key in desired)) {
        delete env[key];
        appliedKeys.delete(key);
        removed.push(key);
      }
    }
    const applied = [];
    for (const [key, value] of Object.entries(desired)) {
      if (env[key] !== value) applied.push(key);
      env[key] = value;
      appliedKeys.add(key);
    }
    if (skipped.length > 0) {
      onWarn(`user-env: skipped reserved/invalid keys: ${skipped.join(", ")}`);
    }
    return { applied, removed, skipped };
  }

  // Register as the live manager so setActiveProject() (the load_project_env
  // tool) can switch the active project and re-apply. One manager per process.
  // markerDir (writable) is where the active-project marker is written.
  _activeManager = { markerDir, reload };

  return { path: filePath, reload };
}
