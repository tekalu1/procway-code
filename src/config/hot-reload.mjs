/**
 * Hot-reload `settings.json` and `secrets.json` while `procway-code serve`
 * is running so dashboard edits take effect from the next turn without a
 * process restart.
 *
 * Design: each AgentSession holds the live `settings` object by reference
 * (turn-orchestrator reads `session.settings.providers[...]` per turn), so
 * mutating the same object in place propagates new values to all sessions.
 * Validation failures are skipped with a warning — the prior value stays
 * authoritative until a valid edit lands.
 *
 * What hot-reloads:
 *   - Top-level keys in settings.json (providers, defaultProvider,
 *     approvalMode, tools.maxToolRounds, ...)
 *   - Secrets in secrets.json (re-injected into process.env with overwrite)
 *   - User env vars in user-env.json (dashboard-distributed snapshot, issue
 *     #30) — applied to process.env via the injected applyUserEnvImpl so the
 *     next tool spawn sees them
 *   - The active-project marker (ADR 0024 Phase 2) — a runtime switch of the
 *     active project re-runs applyUserEnvImpl, swapping the applied project
 *     bucket (the manager re-resolves the active project from the marker)
 *
 * What still requires restart:
 *   - serve port/host bindings (HTTP server already listening)
 *   - WebSocket auth token (clients already authenticated)
 *   - MCP stdio servers (child processes already spawned)
 */
import fsSync from "node:fs";
import path from "node:path";
import { loadSettings } from "./load-settings.mjs";
import { validateSettings } from "./schema.mjs";
import { applySecretsFromFiles } from "./load-secrets.mjs";

const DEFAULT_DEBOUNCE_MS = 250;

/**
 * @param {{
 *   cwd: string,
 *   repoRoot?: string | null,
 *   settings: object,
 *   onApplied?: (info: { keys: string[], appliedSecrets: string[] }) => void,
 *   onWarn?: (message: string) => void,
 *   onError?: (error: unknown) => void,
 *   debounceMs?: number,
 *   watchImpl?: typeof fsSync.watch,
 *   loadImpl?: typeof loadSettings,
 *   applySecretsImpl?: typeof applySecretsFromFiles,
 *   applyUserEnvImpl?: (() => Promise<{applied: string[], removed: string[]} | null>) | null,
 * }} input
 * @returns {{ close: () => void, reloadNow: () => Promise<void> }}
 */
export function startSettingsHotReload({
  cwd,
  repoRoot = null,
  settings,
  onApplied = () => {},
  onWarn = () => {},
  onError = () => {},
  debounceMs = DEFAULT_DEBOUNCE_MS,
  watchImpl = fsSync.watch,
  loadImpl = loadSettings,
  applySecretsImpl = applySecretsFromFiles,
  applyUserEnvImpl = null
} = {}) {
  if (!settings || typeof settings !== "object") {
    throw new Error("startSettingsHotReload requires a settings object to mutate");
  }
  const watchRoot = repoRoot ?? cwd;
  const dir = path.join(watchRoot, ".procway", "ai-agent");

  let timer = null;
  let closed = false;
  let reloadInFlight = null;

  async function reload() {
    if (closed) return;
    // User env first and INDEPENDENTLY of the settings reload: the two live in
    // separate files with separate failure domains — a corrupt settings.json
    // must not block an env-var update, and vice versa.
    let userEnv = null;
    if (applyUserEnvImpl) {
      try {
        userEnv = await applyUserEnvImpl();
      } catch (error) {
        onWarn(`user-env apply failed (${describeError(error)})`);
      }
    }
    try {
      const result = await loadImpl({ cwd, repoRoot });
      const next = result?.settings;
      if (!next || typeof next !== "object") {
        onWarn("hot-reload skipped: loadSettings returned no settings");
        return;
      }
      const errors = validateSettings(next);
      if (errors.length > 0) {
        onWarn(`hot-reload skipped (invalid settings): ${errors.join("; ")}`);
        return;
      }
      // Mutate in place so live sessions / provider lookups see the new values
      // on the next read. Removing the old keys first guarantees deleted
      // fields (e.g. a removed provider) actually disappear.
      for (const key of Object.keys(settings)) {
        delete settings[key];
      }
      Object.assign(settings, next);

      let appliedSecrets = [];
      try {
        const { applied } = await applySecretsImpl({
          cwd: watchRoot,
          env: process.env,
          overwrite: true
        });
        appliedSecrets = applied ?? [];
      } catch (error) {
        onWarn(`hot-reload: secrets reapply failed (${describeError(error)})`);
      }

      onApplied({ keys: Object.keys(next), appliedSecrets, userEnv });
    } catch (error) {
      // A corrupt settings.json (e.g. an external or torn write) makes
      // loadSettings throw on JSON.parse. Applying garbage — or merging a
      // dropped source down to DEFAULT_SETTINGS — is worse than doing nothing,
      // so we keep the prior in-memory settings. But make it LOUD that the live
      // config is now STALE: otherwise a user who edits settings.json sees zero
      // effect and no clue why the session keeps using the old model/provider.
      if (isJsonParseError(error)) {
        onWarn(
          `settings file is corrupt — keeping the previous (STALE) config until a ` +
            `valid edit lands; your latest edit is NOT applied: ${describeError(error)}`
        );
      } else {
        onError(error);
      }
    }
  }

  function scheduleReload() {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      reloadInFlight = reload().finally(() => {
        reloadInFlight = null;
      });
    }, debounceMs);
  }

  let watcher = null;
  try {
    watcher = watchImpl(dir, { persistent: false }, (_eventType, filename) => {
      if (!filename) {
        // Some platforms emit null filename on bulk changes — be safe and reload.
        scheduleReload();
        return;
      }
      const name = typeof filename === "string" ? filename : filename.toString();
      // `active-project` (ADR 0024 Phase 2): re-apply the user-env on a marker
      // change here too. NB the in-Pod load_project_env tool reloads DIRECTLY
      // (setActiveProject), and the marker lives in the writable per-session dir
      // (markerDir) which is usually NOT this watched (read-only) snapshot dir —
      // so this branch only fires when the marker happens to share this dir
      // (single-dir / test setups). The direct reload is the live mechanism.
      if (
        name === "settings.json" || name === "secrets.json"
        || name === "user-env.json" || name === "active-project"
      ) {
        scheduleReload();
      }
    });
    watcher.on("error", (error) => {
      onWarn(`hot-reload watcher error (${describeError(error)})`);
    });
  } catch (error) {
    onWarn(`hot-reload watcher could not start at ${dir} (${describeError(error)})`);
  }

  return {
    close() {
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      try { watcher?.close?.(); } catch { /* ignore */ }
    },
    async reloadNow() {
      if (closed) return;
      await reload();
    },
    /** Test hook: wait for any pending debounced/in-flight reload to settle. */
    async _drain() {
      if (timer) {
        await new Promise((resolve) => setTimeout(resolve, debounceMs + 20));
      }
      if (reloadInFlight) await reloadInFlight;
    }
  };
}

function describeError(error) {
  if (!error) return "unknown error";
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Distinguish "the settings file is corrupt JSON" from other reload failures so
 * the operator gets a clear STALE-config warning instead of a generic error.
 * loadSettings wraps parse failures as `Failed to parse JSON settings at …`.
 */
function isJsonParseError(error) {
  if (error instanceof SyntaxError) return true;
  const message = error?.message ?? "";
  return /Failed to parse JSON settings|Unexpected (token|non-whitespace|end of)/i.test(message);
}
