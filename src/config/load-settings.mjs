import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_SETTINGS } from "./default-settings.mjs";
import { mergeSettings } from "./merge-settings.mjs";

export function getUserSettingsPath(homeDir = os.homedir()) {
  return path.join(homeDir, ".procway", "ai-agent", "settings.json");
}

export function getWorkspaceSettingsPath(workspaceDir) {
  return path.join(workspaceDir, ".procway", "ai-agent", "settings.json");
}

export function settingsFromEnv(env = process.env) {
  const settings = {};
  if (env.PROCWAY_CODE_PROVIDER) settings.defaultProvider = env.PROCWAY_CODE_PROVIDER;
  if (env.PROCWAY_CODE_APPROVAL_MODE) settings.approvalMode = env.PROCWAY_CODE_APPROVAL_MODE;
  if (env.PROCWAY_CODE_COMPATIBILITY_MODE) {
    settings.context = { compatibilityMode: env.PROCWAY_CODE_COMPATIBILITY_MODE };
  }
  // Credential-broker provider (ADR 0008 §F7c). When the dashboard points a
  // session at its LLM proxy it sets PROCWAY_PROVIDER_BASE_URL; build the
  // provider entry inline so the session runs without any workspace/user
  // settings.json — those files no longer ship into the session container
  // (the auth volume was removed). The proxy supplies the real credential, so
  // no apiKeyEnv is set for `anthropic-via-proxy`.
  if (env.PROCWAY_CODE_PROVIDER && env.PROCWAY_PROVIDER_BASE_URL) {
    const id = env.PROCWAY_CODE_PROVIDER;
    const provider = {
      type: env.PROCWAY_PROVIDER_TYPE || id,
      baseUrl: env.PROCWAY_PROVIDER_BASE_URL
    };
    if (env.PROCWAY_CODE_MODEL) provider.defaultModel = env.PROCWAY_CODE_MODEL;
    // Non-broker provider types still need a key env name; broker types don't.
    if (env.PROCWAY_PROVIDER_API_KEY_ENV) provider.apiKeyEnv = env.PROCWAY_PROVIDER_API_KEY_ENV;
    settings.providers = { [id]: provider };
  }
  return settings;
}

export function settingsFromCliOptions(options = {}) {
  const settings = {};
  if (options.provider) settings.defaultProvider = options.provider;
  if (options.approvalMode) settings.approvalMode = options.approvalMode;
  if (options.maxToolRounds != null) {
    settings.tools = { maxToolRounds: options.maxToolRounds };
  }
  if (options.compatibilityMode) {
    settings.context = { compatibilityMode: options.compatibilityMode };
  }
  return settings;
}

function resolveModelOverride({ env = {}, cliOptions = {}, workspaceSettings = null, mergedDefaultProvider = null } = {}) {
  if (cliOptions?.model) return cliOptions.model;
  // PROCWAY_CODE_MODEL is the dashboard's SPAWN-TIME bootstrap (k8s Pod env,
  // frozen for the Pod's lifetime). The workspace settings file is the
  // dashboard's LIVE distribution channel (issue #30 hot-reload): when it
  // explicitly pins a defaultModel for the active provider, that newer value
  // must win over the frozen env — otherwise a model change in the dashboard
  // would never reach a running session without a restart. An explicit
  // `--model` CLI flag still beats both.
  if (env?.PROCWAY_CODE_MODEL) {
    const fromWorkspace = mergedDefaultProvider
      ? workspaceSettings?.providers?.[mergedDefaultProvider]?.defaultModel
      : null;
    if (typeof fromWorkspace === "string" && fromWorkspace.length > 0) return null;
    return env.PROCWAY_CODE_MODEL;
  }
  return null;
}

function applyModelOverride(settings, modelOverride) {
  if (!modelOverride) return settings;
  const providerId = settings?.defaultProvider;
  if (!providerId) return settings;
  const providers = settings.providers ?? {};
  const target = providers[providerId];
  if (!target) return settings;
  return {
    ...settings,
    providers: {
      ...providers,
      [providerId]: { ...target, defaultModel: modelOverride }
    }
  };
}

export async function loadSettings({ cwd = process.cwd(), repoRoot = null, env = process.env, cliOptions = {}, homeDir = os.homedir() } = {}) {
  // workspace settings live in the procway repo, NOT in the cwd. When a
  // worker is spawned with cwd = ticket worktree, that worktree usually
  // has no `.procway/ai-agent/settings.json`. Callers pass `repoRoot` to
  // point us at the dashboard's settings file; we fall back to cwd for
  // standalone REPL / interactive usage where cwd IS the procway repo.
  const workspaceDir = path.resolve(repoRoot ?? cwd);
  const userPath = getUserSettingsPath(homeDir);
  const workspacePath = getWorkspaceSettingsPath(workspaceDir);
  const sources = [
    { name: "default", path: null, settings: DEFAULT_SETTINGS },
    { name: "environment", path: null, settings: settingsFromEnv(env) },
    { name: "user", path: userPath, settings: stripNullPermissions(await readJsonIfExists(userPath)) },
    { name: "workspace", path: workspacePath, settings: stripNullPermissions(await readJsonIfExists(workspacePath)) },
    { name: "cli", path: null, settings: settingsFromCliOptions(cliOptions) }
  ];
  const merged = mergeSettings(...sources.map((source) => source.settings));
  const workspaceSource = sources.find((source) => source.name === "workspace");
  const modelOverride = resolveModelOverride({
    env,
    cliOptions,
    workspaceSettings: workspaceSource?.settings ?? null,
    mergedDefaultProvider: merged?.defaultProvider ?? null
  });
  const settings = applyModelOverride(merged, modelOverride);
  return {
    settings,
    sources: sources.map(({ name, path: sourcePath, settings: sourceSettings }) => ({
      name,
      path: sourcePath,
      loaded: sourceSettings != null,
      keys: sourceSettings && typeof sourceSettings === "object" ? Object.keys(sourceSettings) : []
    }))
  };
}

// `permissions: null` in a settings file would clobber the builtin
// deny/allow/ask defaults (mergeSettings lets null override an object), which
// silently disables the default deny rules (`rm -rf` 等). Dashboards have shipped
// files with the key explicitly nulled, so treat null as "no opinion" and let
// the defaults through. Disabling rules on purpose is still possible with an
// explicit object (e.g. `{ "deny": [] }`).
function stripNullPermissions(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return settings;
  if (settings.permissions !== null) return settings;
  const { permissions: _omit, ...rest } = settings;
  return rest;
}

async function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) return null;
  const content = await readFile(filePath, "utf8");
  try {
    return JSON.parse(content);
  } catch (error) {
    error.message = `Failed to parse JSON settings at ${filePath}: ${error.message}`;
    throw error;
  }
}
