/**
 * Web search + web fetch tools.
 *
 * Pluggable backends: tavily | brave | serper | google-cse | duckduckgo.
 * `duckduckgo` requires no API key and is the default fallback. All egress
 * goes through `safeFetch` so the operator can gate hosts via PROCWAY_NET_ALLOW.
 *
 * Settings shape (validated in src/config/schema.mjs):
 *   tools.webSearch = {
 *     backend?: "tavily" | "brave" | "serper" | "google-cse" | "duckduckgo",
 *     apiKeyEnv?: string,             // env var holding the backend API key
 *     defaultMaxResults?: number,     // default result cap (1..20)
 *     baseUrl?: string,               // override backend endpoint
 *     googleCseId?: string,           // google-cse only: the cx parameter
 *     timeoutMs?: number              // per-request timeout
 *   }
 */

const DEFAULT_BACKEND = "duckduckgo";
const DEFAULT_MAX_RESULTS = 5;
const HARD_MAX_RESULTS = 20;
const DEFAULT_TIMEOUT_MS = 15000;
const FETCH_MAX_BYTES = 500_000;

const BACKEND_DEFAULTS = {
  tavily: { baseUrl: "https://api.tavily.com/search", apiKeyEnv: "TAVILY_API_KEY" },
  brave: { baseUrl: "https://api.search.brave.com/res/v1/web/search", apiKeyEnv: "BRAVE_SEARCH_API_KEY" },
  serper: { baseUrl: "https://google.serper.dev/search", apiKeyEnv: "SERPER_API_KEY" },
  "google-cse": { baseUrl: "https://www.googleapis.com/customsearch/v1", apiKeyEnv: "GOOGLE_CSE_API_KEY" },
  duckduckgo: { baseUrl: "https://html.duckduckgo.com/html/", apiKeyEnv: null }
};

export const SUPPORTED_WEB_SEARCH_BACKENDS = Object.freeze(Object.keys(BACKEND_DEFAULTS));

function resolveBackendConfig(settings, env = process.env) {
  const cfg = settings?.tools?.webSearch ?? {};
  const backend = (cfg.backend ?? DEFAULT_BACKEND).toLowerCase();
  const defaults = BACKEND_DEFAULTS[backend];
  if (!defaults) {
    throw new Error(`Unknown web search backend: ${backend}. Supported: ${SUPPORTED_WEB_SEARCH_BACKENDS.join(", ")}`);
  }
  const apiKeyEnv = cfg.apiKeyEnv ?? defaults.apiKeyEnv;
  const apiKey = apiKeyEnv ? env?.[apiKeyEnv] ?? null : null;
  return {
    backend,
    baseUrl: cfg.baseUrl ?? defaults.baseUrl,
    apiKey,
    apiKeyEnv,
    googleCseId: cfg.googleCseId ?? env?.GOOGLE_CSE_ID ?? null,
    timeoutMs: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    defaultMaxResults: clampMaxResults(cfg.defaultMaxResults ?? DEFAULT_MAX_RESULTS)
  };
}

function clampMaxResults(value) {
  const n = Number.isFinite(value) ? Math.floor(value) : DEFAULT_MAX_RESULTS;
  if (n < 1) return 1;
  if (n > HARD_MAX_RESULTS) return HARD_MAX_RESULTS;
  return n;
}

function withTimeout(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer)
  };
}

async function callBackend({ backend, baseUrl, apiKey, googleCseId, query, maxResults, fetchImpl, timeoutMs, signal }) {
  const { signal: timeoutSignal, cancel } = withTimeout(timeoutMs);
  const composite = composeAbortSignals(signal, timeoutSignal);
  try {
    if (backend === "tavily") {
      if (!apiKey) throw new Error("Tavily backend requires an API key (set TAVILY_API_KEY or tools.webSearch.apiKeyEnv)");
      const res = await fetchImpl(baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: apiKey, query, max_results: maxResults, search_depth: "basic" }),
        signal: composite
      });
      if (!res.ok) throw await httpError(res);
      const json = await res.json();
      return (json?.results ?? []).slice(0, maxResults).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.content ?? ""
      }));
    }
    if (backend === "brave") {
      if (!apiKey) throw new Error("Brave backend requires an API key (set BRAVE_SEARCH_API_KEY or tools.webSearch.apiKeyEnv)");
      const url = new URL(baseUrl);
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(maxResults));
      const res = await fetchImpl(url, {
        headers: { "X-Subscription-Token": apiKey, accept: "application/json" },
        signal: composite
      });
      if (!res.ok) throw await httpError(res);
      const json = await res.json();
      return (json?.web?.results ?? []).slice(0, maxResults).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.description ?? ""
      }));
    }
    if (backend === "serper") {
      if (!apiKey) throw new Error("Serper backend requires an API key (set SERPER_API_KEY or tools.webSearch.apiKeyEnv)");
      const res = await fetchImpl(baseUrl, {
        method: "POST",
        headers: { "X-API-KEY": apiKey, "content-type": "application/json" },
        body: JSON.stringify({ q: query, num: maxResults }),
        signal: composite
      });
      if (!res.ok) throw await httpError(res);
      const json = await res.json();
      return (json?.organic ?? []).slice(0, maxResults).map((r) => ({
        title: r.title ?? "",
        url: r.link ?? "",
        snippet: r.snippet ?? ""
      }));
    }
    if (backend === "google-cse") {
      if (!apiKey) throw new Error("Google CSE backend requires an API key (set GOOGLE_CSE_API_KEY or tools.webSearch.apiKeyEnv)");
      if (!googleCseId) throw new Error("Google CSE backend requires tools.webSearch.googleCseId (or GOOGLE_CSE_ID)");
      const url = new URL(baseUrl);
      url.searchParams.set("key", apiKey);
      url.searchParams.set("cx", googleCseId);
      url.searchParams.set("q", query);
      url.searchParams.set("num", String(maxResults));
      const res = await fetchImpl(url, { signal: composite });
      if (!res.ok) throw await httpError(res);
      const json = await res.json();
      return (json?.items ?? []).slice(0, maxResults).map((r) => ({
        title: r.title ?? "",
        url: r.link ?? "",
        snippet: r.snippet ?? ""
      }));
    }
    if (backend === "duckduckgo") {
      const url = new URL(baseUrl);
      url.searchParams.set("q", query);
      const res = await fetchImpl(url, {
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; procway-code/0.1)",
          accept: "text/html"
        },
        signal: composite
      });
      if (!res.ok) throw await httpError(res);
      const html = await res.text();
      return parseDuckDuckGoHtml(html, maxResults);
    }
    throw new Error(`Unknown web search backend: ${backend}`);
  } finally {
    cancel();
  }
}

async function httpError(res) {
  let body = "";
  try { body = (await res.text()).slice(0, 500); } catch { /* ignore */ }
  const err = new Error(`HTTP ${res.status} ${res.statusText}${body ? `: ${body}` : ""}`);
  err.status = res.status;
  return err;
}

function composeAbortSignals(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") {
    return AbortSignal.any([a, b]);
  }
  const controller = new AbortController();
  const onAbort = (signal) => () => controller.abort(signal.reason);
  if (a.aborted) controller.abort(a.reason);
  else a.addEventListener("abort", onAbort(a), { once: true });
  if (b.aborted) controller.abort(b.reason);
  else b.addEventListener("abort", onAbort(b), { once: true });
  return controller.signal;
}

/**
 * Minimal DuckDuckGo HTML scraper. Targets html.duckduckgo.com which returns
 * a static result page. Layout is stable enough for fallback use; not a
 * production-quality scraper.
 */
export function parseDuckDuckGoHtml(html, maxResults) {
  if (typeof html !== "string" || html.length === 0) return [];
  const out = [];
  const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const links = [];
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    links.push({ href: decodeDdgRedirect(m[1]), title: stripHtml(m[2]) });
  }
  const snippets = [];
  while ((m = snippetRe.exec(html)) !== null) {
    snippets.push(stripHtml(m[1]));
  }
  for (let i = 0; i < links.length && out.length < maxResults; i += 1) {
    if (!links[i].href) continue;
    out.push({
      title: links[i].title,
      url: links[i].href,
      snippet: snippets[i] ?? ""
    });
  }
  return out;
}

function decodeDdgRedirect(href) {
  try {
    const url = new URL(href, "https://duckduckgo.com");
    if (url.pathname === "/l/" && url.searchParams.has("uddg")) {
      return decodeURIComponent(url.searchParams.get("uddg"));
    }
    return url.toString();
  } catch {
    return href;
  }
}

function stripHtml(s) {
  return String(s)
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Run a web search against the configured backend.
 * Returns a ToolResult with kind: "web_search".
 */
export async function runWebSearch({
  query,
  maxResults,
  settings,
  fetchImpl = globalThis.fetch,
  env = process.env,
  signal
} = {}) {
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new Error("web_search: query is required");
  }
  if (!fetchImpl) {
    throw new Error("web_search: no fetch implementation available");
  }
  const cfg = resolveBackendConfig(settings, env);
  const cap = clampMaxResults(maxResults ?? cfg.defaultMaxResults);
  const trimmed = query.trim();
  const results = await callBackend({
    backend: cfg.backend,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    googleCseId: cfg.googleCseId,
    query: trimmed,
    maxResults: cap,
    fetchImpl,
    timeoutMs: cfg.timeoutMs,
    signal
  });
  return {
    kind: "web_search",
    summary: `web_search(${cfg.backend}) "${truncate(trimmed, 60)}" → ${results.length} result(s)`,
    data: {
      backend: cfg.backend,
      query: trimmed,
      maxResults: cap,
      results
    }
  };
}

/**
 * Fetch a URL and return its (truncated) text body.
 * Returns a ToolResult with kind: "web_fetch".
 */
export async function runWebFetch({
  url,
  maxBytes = FETCH_MAX_BYTES,
  asText = true,
  fetchImpl = globalThis.fetch,
  signal,
  timeoutMs
} = {}) {
  if (typeof url !== "string" || url.trim().length === 0) {
    throw new Error("web_fetch: url is required");
  }
  if (!fetchImpl) {
    throw new Error("web_fetch: no fetch implementation available");
  }
  const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.min(maxBytes, FETCH_MAX_BYTES * 4) : FETCH_MAX_BYTES;
  const { signal: timeoutSignal, cancel } = withTimeout(timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const composite = composeAbortSignals(signal, timeoutSignal);
  try {
    const res = await fetchImpl(url, {
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; procway-code/0.1)",
        accept: asText ? "text/html, text/plain, application/json;q=0.9, */*;q=0.5" : "*/*"
      },
      signal: composite
    });
    if (!res.ok) {
      const err = await httpError(res);
      throw err;
    }
    const contentType = res.headers?.get?.("content-type") ?? "";
    const buffer = await res.arrayBuffer();
    const truncated = buffer.byteLength > cap;
    const sliced = truncated ? buffer.slice(0, cap) : buffer;
    const body = asText
      ? new TextDecoder("utf-8", { fatal: false }).decode(sliced)
      : Buffer.from(sliced).toString("base64");
    return {
      kind: "web_fetch",
      summary: `web_fetch ${truncate(url, 80)} → ${res.status} ${formatBytes(buffer.byteLength)}${truncated ? " (truncated)" : ""}`,
      data: {
        url,
        status: res.status,
        contentType,
        bytes: buffer.byteLength,
        truncated,
        encoding: asText ? "utf-8" : "base64",
        body
      }
    };
  } finally {
    cancel();
  }
}

function truncate(s, n) {
  const str = String(s);
  return str.length <= n ? str : `${str.slice(0, n - 1)}…`;
}

function formatBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}
