import { REASONING_EFFORTS } from "../providers/reasoning.mjs";

const COMPATIBILITY_MODES = new Set(["claude", "codex", "mixed"]);
const WEB_SEARCH_BACKENDS = new Set(["tavily", "brave", "serper", "google-cse", "duckduckgo"]);
const BROWSER_ENGINES = new Set(["chrome", "lightpanda"]);
const APPROVAL_MODES = new Set(["always-ask", "auto-readonly", "full-auto"]);
const PROVIDER_TYPES = new Set(["openai", "openai-compatible", "openai-codex", "anthropic", "anthropic-compatible", "anthropic-via-proxy", "openai-via-proxy", "openai-codex-via-proxy", "cli-agent"]);
const API_PROVIDER_TYPES = new Set(["openai", "openai-compatible", "openai-codex", "anthropic", "anthropic-compatible", "anthropic-via-proxy", "openai-via-proxy", "openai-codex-via-proxy"]);
const OAUTH_PROVIDER_TYPES = new Set(["openai-codex"]);
// Credential-broker providers (ADR 0008 §F7c) get their credential injected
// upstream by the dashboard proxy, so — like OAuth providers — they carry no
// local apiKeyEnv. baseUrl (the proxy URL) and defaultModel are still required.
// NOTE: openai-codex-via-proxy is deliberately NOT in OAUTH_PROVIDER_TYPES — it
// needs a baseUrl (the proxy), unlike a direct openai-codex provider.
const BROKER_PROVIDER_TYPES = new Set(["anthropic-via-proxy", "openai-via-proxy", "openai-codex-via-proxy"]);
// Accepts the legacy "drop-tool-results" (migrated to the dropToolResults
// toggle at runtime by getCompactConfig) and the deprecated summarize-* values
// (no longer offered in the UI but still honored) so existing settings.json
// files keep validating.
const COMPACT_STRATEGIES = new Set(["drop-tool-results", "summarize-context", "summarize-aggressive", "truncate-oldest", "llm-summary"]);
const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export { PROVIDER_TYPES, API_PROVIDER_TYPES, PROVIDER_ID_PATTERN };

export function validateSettings(settings) {
  const errors = [];
  const mode = settings?.context?.compatibilityMode;
  if (mode && !COMPATIBILITY_MODES.has(mode)) {
    errors.push(`context.compatibilityMode must be one of: ${[...COMPATIBILITY_MODES].join(", ")}`);
  }
  if (settings?.approvalMode && !APPROVAL_MODES.has(settings.approvalMode)) {
    errors.push(`approvalMode must be one of: ${[...APPROVAL_MODES].join(", ")}`);
  }
  if (settings?.permissions != null) {
    const perms = settings.permissions;
    if (typeof perms !== "object" || Array.isArray(perms)) {
      errors.push("permissions must be an object with allow/deny/ask arrays");
    } else {
      for (const key of ["allow", "deny", "ask"]) {
        const list = perms[key];
        if (list == null) continue;
        if (!Array.isArray(list) || list.some((entry) => typeof entry !== "string")) {
          errors.push(`permissions.${key} must be an array of strings`);
        }
      }
    }
  }
  if (settings?.agents?.maxDepth != null && settings.agents.maxDepth < 0) {
    errors.push("agents.maxDepth must be >= 0");
  }
  if (settings?.tools?.maxParallelTools != null && settings.tools.maxParallelTools < 1) {
    errors.push("tools.maxParallelTools must be >= 1");
  }
  if (settings?.tools?.maxToolRounds != null && settings.tools.maxToolRounds < 0) {
    errors.push("tools.maxToolRounds must be >= 0, where 0 means unlimited");
  }
  if (settings?.tools?.writeLock != null && typeof settings.tools.writeLock !== "boolean") {
    errors.push("tools.writeLock must be a boolean");
  }
  if (settings?.usage != null) {
    const usage = settings.usage;
    if (typeof usage !== "object" || Array.isArray(usage)) {
      errors.push("usage must be an object");
    } else {
      if (usage.trackCost != null && typeof usage.trackCost !== "boolean") {
        errors.push("usage.trackCost must be a boolean");
      }
      if (usage.pricing != null) {
        if (typeof usage.pricing !== "object" || Array.isArray(usage.pricing)) {
          errors.push("usage.pricing must be an object keyed by `provider:model`");
        } else {
          for (const [key, entry] of Object.entries(usage.pricing)) {
            if (!entry || typeof entry !== "object") {
              errors.push(`usage.pricing.${key} must be an object`);
              continue;
            }
            if (entry.inputPer1k != null && typeof entry.inputPer1k !== "number") {
              errors.push(`usage.pricing.${key}.inputPer1k must be a number`);
            }
            if (entry.outputPer1k != null && typeof entry.outputPer1k !== "number") {
              errors.push(`usage.pricing.${key}.outputPer1k must be a number`);
            }
          }
        }
      }
    }
  }
  if (settings?.session?.autoCompact) {
    const autoCompact = settings.session.autoCompact;
    if (autoCompact.enabled != null && typeof autoCompact.enabled !== "boolean") {
      errors.push("session.autoCompact.enabled must be a boolean");
    }
    if (autoCompact.messageCount != null && autoCompact.messageCount < 1) {
      errors.push("session.autoCompact.messageCount must be >= 1");
    }
    if (autoCompact.estimatedTokens != null && autoCompact.estimatedTokens < 1) {
      errors.push("session.autoCompact.estimatedTokens must be >= 1");
    }
    if (autoCompact.keepLastMessages != null && autoCompact.keepLastMessages < 1) {
      errors.push("session.autoCompact.keepLastMessages must be >= 1");
    }
    if (autoCompact.strategy && !COMPACT_STRATEGIES.has(autoCompact.strategy)) {
      errors.push(`session.autoCompact.strategy must be one of: ${[...COMPACT_STRATEGIES].join(", ")}`);
    }
    if (autoCompact.dropToolResults != null && typeof autoCompact.dropToolResults !== "boolean") {
      errors.push("session.autoCompact.dropToolResults must be a boolean");
    }
  }
  if (settings?.defaultProvider && settings?.providers && !settings.providers[settings.defaultProvider]) {
    errors.push(`defaultProvider not found in providers: ${settings.defaultProvider}`);
  }
  // Optional vision delegate: a provider used to answer questions about images
  // (ask_image tool + attachment auto-describe) when the main provider is
  // text-only (`supportsVision: false`). Must reference an API provider —
  // cli-agent flattens to plain text and cannot accept images.
  if (settings?.visionProvider != null) {
    if (typeof settings.visionProvider !== "string" || settings.visionProvider.length === 0) {
      errors.push("visionProvider must be a non-empty string");
    } else if (settings?.providers && !settings.providers[settings.visionProvider]) {
      errors.push(`visionProvider not found in providers: ${settings.visionProvider}`);
    } else if (settings?.providers?.[settings.visionProvider]?.type === "cli-agent") {
      errors.push("visionProvider must not be a cli-agent provider (it cannot accept images)");
    } else if (settings?.providers?.[settings.visionProvider]?.supportsVision === false) {
      errors.push(`visionProvider ${settings.visionProvider} is marked supportsVision: false`);
    }
  }
  for (const [id, provider] of Object.entries(settings?.providers ?? {})) {
    if (!PROVIDER_ID_PATTERN.test(id)) {
      errors.push(`providers.${id}: id must match ${PROVIDER_ID_PATTERN}`);
    }
    if (!provider?.type) {
      errors.push(`providers.${id}.type is required`);
      continue;
    }
    if (!PROVIDER_TYPES.has(provider.type)) {
      errors.push(`providers.${id}.type must be one of: ${[...PROVIDER_TYPES].join(", ")}`);
      continue;
    }
    if (provider.type === "cli-agent") {
      if (!provider.command) errors.push(`providers.${id}.command is required for cli-agent providers`);
      if (provider.args != null && (!Array.isArray(provider.args) || provider.args.some((arg) => typeof arg !== "string"))) {
        errors.push(`providers.${id}.args must be an array of strings`);
      }
      // PoC (TK-135): mcpHost flag enables MCP server injection so the sub-CLI
      // calls procway tools instead of its own built-ins. Optional; default false.
      if (provider.mcpHost != null && typeof provider.mcpHost !== "boolean") {
        errors.push(`providers.${id}.mcpHost must be a boolean`);
      }
      if (provider.mcpHostKeepBuiltins != null && typeof provider.mcpHostKeepBuiltins !== "boolean") {
        errors.push(`providers.${id}.mcpHostKeepBuiltins must be a boolean`);
      }
      continue;
    }
    if (OAUTH_PROVIDER_TYPES.has(provider.type)) {
      // OAuth providers identify themselves by `authProfile` rather than an
      // env-var-backed API key. Sub-fields (baseUrl / clientVersion /
      // originator) all have sensible defaults baked into the provider.
      if (provider.authProfile != null && typeof provider.authProfile !== "string") {
        errors.push(`providers.${id}.authProfile must be a string`);
      }
      if (provider.clientVersion != null && (typeof provider.clientVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(provider.clientVersion))) {
        errors.push(`providers.${id}.clientVersion must be a SemVer string (e.g. "0.0.1")`);
      }
      if (provider.originator != null && typeof provider.originator !== "string") {
        errors.push(`providers.${id}.originator must be a string`);
      }
    } else if (!BROKER_PROVIDER_TYPES.has(provider.type)) {
      if (!provider.apiKeyEnv) errors.push(`providers.${id}.apiKeyEnv is required`);
    }
    if (!OAUTH_PROVIDER_TYPES.has(provider.type) && !provider.baseUrl) {
      errors.push(`providers.${id}.baseUrl is required`);
    }
    if (API_PROVIDER_TYPES.has(provider.type)) {
      if (provider.defaultModel == null || provider.defaultModel === "") {
        errors.push(`providers.${id}.defaultModel is required for ${provider.type} providers`);
      } else if (typeof provider.defaultModel !== "string") {
        errors.push(`providers.${id}.defaultModel must be a string`);
      }
    }
    if (provider.echoReasoning != null && typeof provider.echoReasoning !== "boolean") {
      errors.push(`providers.${id}.echoReasoning must be a boolean`);
    }
    // Whether the provider's defaultModel can accept image inputs. Omitted =
    // true (status quo). Set false for text-only models (e.g. deepseek-v4) so
    // image refs are delegated to `visionProvider` instead of 400-ing the turn.
    if (provider.supportsVision != null && typeof provider.supportsVision !== "boolean") {
      errors.push(`providers.${id}.supportsVision must be a boolean`);
    }
    // Common reasoning-effort knob (openai-codex → reasoning.effort,
    // openai-compatible → reasoning_effort, anthropic → thinking budget).
    if (provider.reasoningEffort != null
        && (typeof provider.reasoningEffort !== "string" || !REASONING_EFFORTS.includes(provider.reasoningEffort.toLowerCase()))) {
      errors.push(`providers.${id}.reasoningEffort must be one of: ${REASONING_EFFORTS.join(", ")}`);
    }
  }
  for (const [id, server] of Object.entries(settings?.mcpServers ?? {})) {
    if (server?.enabled === false) continue;
    if (!server?.transport) {
      errors.push(`mcpServers.${id}.transport is required`);
      continue;
    }
    const transport = String(server.transport).toLowerCase();
    if (transport === "stdio") {
      if (!server.command) errors.push(`mcpServers.${id}.command is required`);
      continue;
    }
    if (transport === "http" || transport === "sse") {
      if (!server.baseUrl) errors.push(`mcpServers.${id}.baseUrl is required`);
      continue;
    }
    errors.push(`mcpServers.${id}.transport must be one of: stdio, http, sse`);
  }
  if (settings?.session?.encryption) {
    const enc = settings.session.encryption;
    const provider = enc.provider;
    if (provider != null && !["none", "passphrase", "os-keychain"].includes(provider)) {
      errors.push("session.encryption.provider must be one of: none, passphrase, os-keychain");
    }
  }
  if (settings?.session?.redaction?.patterns != null && !Array.isArray(settings.session.redaction.patterns)) {
    errors.push("session.redaction.patterns must be an array");
  }
  if (settings?.session?.snapshot?.intervalEvents != null && settings.session.snapshot.intervalEvents < 1) {
    errors.push("session.snapshot.intervalEvents must be >= 1");
  }
  if (settings?.session?.snapshot?.intervalMs != null && settings.session.snapshot.intervalMs < 0) {
    errors.push("session.snapshot.intervalMs must be >= 0");
  }
  if (settings?.tools?.webSearch != null) {
    const ws = settings.tools.webSearch;
    if (typeof ws !== "object" || Array.isArray(ws)) {
      errors.push("tools.webSearch must be an object");
    } else {
      if (ws.backend != null && !WEB_SEARCH_BACKENDS.has(String(ws.backend).toLowerCase())) {
        errors.push(`tools.webSearch.backend must be one of: ${[...WEB_SEARCH_BACKENDS].join(", ")}`);
      }
      if (ws.apiKeyEnv != null && (typeof ws.apiKeyEnv !== "string" || ws.apiKeyEnv.length === 0)) {
        errors.push("tools.webSearch.apiKeyEnv must be a non-empty string");
      }
      if (ws.baseUrl != null && (typeof ws.baseUrl !== "string" || ws.baseUrl.length === 0)) {
        errors.push("tools.webSearch.baseUrl must be a non-empty string");
      }
      if (ws.googleCseId != null && typeof ws.googleCseId !== "string") {
        errors.push("tools.webSearch.googleCseId must be a string");
      }
      if (ws.defaultMaxResults != null && (typeof ws.defaultMaxResults !== "number" || ws.defaultMaxResults < 1)) {
        errors.push("tools.webSearch.defaultMaxResults must be a number >= 1");
      }
      if (ws.timeoutMs != null && (typeof ws.timeoutMs !== "number" || ws.timeoutMs < 1)) {
        errors.push("tools.webSearch.timeoutMs must be a number >= 1");
      }
    }
  }
  if (settings?.tools?.sandbox != null) {
    const sb = settings.tools.sandbox;
    if (typeof sb !== "object" || Array.isArray(sb)) {
      errors.push("tools.sandbox must be an object");
    } else {
      for (const key of ["memoryMB", "cpuSeconds", "timeoutMs"]) {
        if (sb[key] != null && typeof sb[key] !== "number") {
          errors.push(`tools.sandbox.${key} must be a number`);
        }
      }
    }
  }
  if (settings?.tools?.browser != null) {
    const br = settings.tools.browser;
    if (typeof br !== "object" || Array.isArray(br)) {
      errors.push("tools.browser must be an object");
    } else {
      for (const key of ["enabled", "headed"]) {
        if (br[key] != null && typeof br[key] !== "boolean") {
          errors.push(`tools.browser.${key} must be a boolean`);
        }
      }
      for (const key of ["executablePath", "binary", "session", "display", "args"]) {
        if (br[key] != null && (typeof br[key] !== "string" || br[key].length === 0)) {
          errors.push(`tools.browser.${key} must be a non-empty string`);
        }
      }
      if (br.engine != null && !BROWSER_ENGINES.has(String(br.engine).toLowerCase())) {
        errors.push(`tools.browser.engine must be one of: ${[...BROWSER_ENGINES].join(", ")}`);
      }
      if (br.idleTimeoutMs != null && (typeof br.idleTimeoutMs !== "number" || br.idleTimeoutMs < 0)) {
        errors.push("tools.browser.idleTimeoutMs must be a number >= 0");
      }
    }
  }
  if (settings?.agents?.isolation != null && !["inline", "fork"].includes(settings.agents.isolation)) {
    errors.push("agents.isolation must be one of: inline, fork");
  }
  return errors;
}
