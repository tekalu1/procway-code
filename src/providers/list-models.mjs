/**
 * Fetch the list of available models for an API-type provider.
 *
 * Endpoints:
 *   - openai / openai-compatible       → GET {baseUrl}/models
 *   - anthropic / anthropic-compatible → GET {baseUrl}/v1/models
 *   - cli-agent                        → throws ListModelsError(code: "not-implemented")
 *
 * Returns: `{ models: string[] }`
 * Throws : `ListModelsError` for predictable failure shapes; consumers
 *          (UI / API endpoints) translate the `code` into user-facing messages.
 */
export class ListModelsError extends Error {
  constructor(code, message, { status = null, cause = null } = {}) {
    super(message);
    this.name = "ListModelsError";
    this.code = code;
    this.status = status;
    if (cause) this.cause = cause;
  }
}

const TIMEOUT_CODES = new Set(["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "ETIMEDOUT"]);

export async function listModels({ provider, fetchImpl = globalThis.fetch, env = process.env, timeoutMs = 15000 } = {}) {
  if (!provider?.type) throw new ListModelsError("invalid", "provider.type is required");
  if (provider.type === "cli-agent") {
    throw new ListModelsError("not-implemented", "cli-agent providers do not expose a model list");
  }
  // Credential-broker (`*-via-proxy`) providers carry no apiKeyEnv and only
  // proxy chat/messages — model discovery goes through the dashboard's own
  // keyed provider, not the proxy (ADR 0008 §F7c).
  if (typeof provider.type === "string" && provider.type.endsWith("-via-proxy")) {
    throw new ListModelsError("not-implemented", "credential-broker providers do not expose a model list");
  }
  if (!fetchImpl) throw new ListModelsError("unknown", "fetch is not available in this runtime");

  const apiKey = provider.apiKeyEnv ? env[provider.apiKeyEnv] : null;
  if (!apiKey) {
    throw new ListModelsError("unauthorized", `Missing API key environment variable: ${provider.apiKeyEnv}`);
  }
  if (!provider.baseUrl) {
    throw new ListModelsError("invalid", "provider.baseUrl is required");
  }
  const baseUrl = provider.baseUrl.replace(/\/$/, "");

  if (provider.type === "openai" || provider.type === "openai-compatible") {
    return fetchOpenAiModels({ baseUrl, apiKey, fetchImpl, timeoutMs });
  }
  if (provider.type === "anthropic" || provider.type === "anthropic-compatible") {
    return fetchAnthropicModels({ baseUrl, apiKey, fetchImpl, timeoutMs, version: provider.version ?? "2023-06-01" });
  }
  throw new ListModelsError("not-implemented", `Unknown provider type: ${provider.type}`);
}

async function fetchOpenAiModels({ baseUrl, apiKey, fetchImpl, timeoutMs }) {
  const endpoint = `${baseUrl}/models`;
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  };
  return fetchModelsWithErrorHandling({ endpoint, headers, fetchImpl, timeoutMs });
}

async function fetchAnthropicModels({ baseUrl, apiKey, fetchImpl, timeoutMs, version }) {
  const endpoint = `${baseUrl}/v1/models`;
  const headers = {
    "x-api-key": apiKey,
    "anthropic-version": version,
    "Content-Type": "application/json"
  };
  return fetchModelsWithErrorHandling({ endpoint, headers, fetchImpl, timeoutMs });
}

async function fetchModelsWithErrorHandling({ endpoint, headers, fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(endpoint, { method: "GET", headers, signal: controller.signal });
  } catch (error) {
    const code = isTimeoutError(error) ? "timeout" : "network";
    throw new ListModelsError(code, `Failed to reach ${endpoint}: ${error?.message ?? error}`, { cause: error });
  } finally {
    clearTimeout(timer);
  }
  const bodyText = await safeText(response);
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new ListModelsError("unauthorized", `Authentication rejected (${response.status})`, { status: response.status });
    }
    if (response.status === 404) {
      throw new ListModelsError("not-implemented", `Endpoint not found at ${endpoint}`, { status: response.status });
    }
    throw new ListModelsError("unknown", `Provider returned ${response.status} ${response.statusText}: ${bodyText.slice(0, 200)}`, { status: response.status });
  }
  let data;
  try {
    data = JSON.parse(bodyText);
  } catch (error) {
    throw new ListModelsError("unknown", `Provider returned non-JSON response`, { cause: error });
  }
  const models = extractModelIds(data);
  return { models };
}

function extractModelIds(data) {
  if (Array.isArray(data?.data)) {
    return data.data
      .map((entry) => (entry && typeof entry.id === "string" ? entry.id : null))
      .filter(Boolean);
  }
  if (Array.isArray(data?.models)) {
    return data.models
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (entry && typeof entry.id === "string") return entry.id;
        return null;
      })
      .filter(Boolean);
  }
  return [];
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function isTimeoutError(error) {
  if (!error) return false;
  if (error.name === "AbortError") return true;
  if (error.code && TIMEOUT_CODES.has(error.code)) return true;
  if (error.cause?.code && TIMEOUT_CODES.has(error.cause.code)) return true;
  return false;
}
