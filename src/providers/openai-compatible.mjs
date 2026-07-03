import { normalizeOpenAiContent, normalizeOpenAiToolCalls, toOpenAiMessages } from "./format/openai.mjs";
import { parseSseStream } from "./sse.mjs";
import { normalizeReasoningEffort } from "./reasoning.mjs";
import { llmFetch } from "./llm-fetch.mjs";

const ZERO_USAGE = Object.freeze({ inputTokens: 0, outputTokens: 0 });

export async function runOpenAiCompatibleProvider({
  provider,
  model,
  prompt,
  messages,
  tools,
  fetchImpl = llmFetch,
  sleepImpl = sleep,
  stream = true
}) {
  if (!fetchImpl) {
    throw new Error("fetch is not available in this Node.js runtime");
  }
  // openai-via-proxy (ADR 0008 §F7c) talks to the dashboard credential broker,
  // which injects the real Bearer credential upstream. The session holds no
  // API key, so the key is optional for that type; direct openai /
  // openai-compatible providers still require it.
  const viaProxy = provider.type === "openai-via-proxy";
  const apiKey = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined;
  if (!apiKey && !viaProxy) {
    throw new Error(`Missing API key environment variable: ${provider.apiKeyEnv}`);
  }

  const sourceMessages = messages ?? [{ role: "user", content: prompt }];
  const openAiMessages = toOpenAiMessages(sourceMessages, { echoReasoning: provider.echoReasoning === true });
  const endpoint = `${provider.baseUrl.replace(/\/$/, "")}/chat/completions`;
  // ADR 0008 §F7 / T1-17: present the session-scoped broker token so the
  // dashboard proxy can verify the request belongs to this session's tenant.
  // The broker strips this inbound Authorization and attaches the real Bearer
  // upstream (relay.ts STRIPPED_INBOUND). Injected at spawn as
  // PROCWAY_PROXY_TOKEN; absent in local/single-tenant mode.
  const proxyToken = viaProxy ? process.env.PROCWAY_PROXY_TOKEN : undefined;
  const headers = {
    // Direct providers send their real key; via-proxy sessions send only the
    // broker token, which the broker strips and replaces with its own.
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...(proxyToken ? { Authorization: `Bearer ${proxyToken}` } : {}),
    "Content-Type": "application/json",
    ...(provider.httpReferer ? { "HTTP-Referer": provider.httpReferer } : {}),
    ...(provider.title ? { "X-Title": provider.title } : {})
  };
  const reasoningEffort = normalizeReasoningEffort(provider.reasoningEffort);
  const body = {
    model,
    messages: openAiMessages,
    // OpenAI gpt-5 / o-series and most compatible gateways (OpenRouter,
    // Cerebras) accept the top-level `reasoning_effort` knob. Omitted when
    // unset so non-reasoning models aren't rejected.
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    ...(tools?.length ? { tools, tool_choice: "auto" } : {})
  };

  if (stream && provider.stream !== false) {
    return runStreaming({ endpoint, headers, body, fetchImpl, sleepImpl, provider });
  }
  return runNonStreaming({ endpoint, headers, body, fetchImpl, sleepImpl, provider });
}

async function runNonStreaming({ endpoint, headers, body, fetchImpl, sleepImpl, provider }) {
  const request = { method: "POST", headers, body: JSON.stringify(body) };
  const { text } = await fetchWithRetry({
    endpoint,
    request,
    fetchImpl,
    sleepImpl,
    maxRetries: provider.maxRetries ?? 2,
    retryBaseDelayMs: provider.retryBaseDelayMs ?? 1000
  });
  const data = JSON.parse(text);
  return responseFromOpenAiData(data);
}

async function runStreaming({ endpoint, headers, body, fetchImpl, sleepImpl, provider }) {
  const request = {
    method: "POST",
    headers,
    body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } })
  };
  const response = await fetchStreamingWithRetry({
    endpoint,
    request,
    fetchImpl,
    sleepImpl,
    maxRetries: provider.maxRetries ?? 2,
    retryBaseDelayMs: provider.retryBaseDelayMs ?? 1000
  });

  const sseEvents = [];
  const chunkBuffer = [];
  let chunkResolver = null;
  let streamDone = false;
  let streamError = null;

  const consumePromise = (async () => {
    try {
      for await (const sse of parseSseStream(response.body)) {
        sseEvents.push(sse);
        // Reasoning ("thinking") deltas arrive out of band before visible
        // output. Tag them with kind:"reasoning" so the turn orchestrator
        // routes them to assistant.reasoning.delta and the dashboard renders
        // the live thinking view — same contract as openai-codex.
        const reasoningText = extractOpenAiReasoningDeltaText(sse);
        if (reasoningText) {
          chunkBuffer.push({ deltaText: reasoningText, kind: "reasoning", raw: sse });
          if (chunkResolver) {
            const r = chunkResolver;
            chunkResolver = null;
            r();
          }
        }
        const deltaText = extractOpenAiDeltaText(sse);
        if (deltaText) {
          chunkBuffer.push({ deltaText, raw: sse });
          if (chunkResolver) {
            const r = chunkResolver;
            chunkResolver = null;
            r();
          }
        }
      }
    } catch (error) {
      streamError = error;
    } finally {
      streamDone = true;
      if (chunkResolver) {
        const r = chunkResolver;
        chunkResolver = null;
        r();
      }
    }
  })();

  async function* deltaStream() {
    while (true) {
      if (chunkBuffer.length > 0) {
        yield chunkBuffer.shift();
        continue;
      }
      if (streamDone) {
        if (streamError) throw streamError;
        return;
      }
      await new Promise((resolve) => { chunkResolver = resolve; });
    }
  }

  return {
    deltaStream: deltaStream(),
    finalize: async () => {
      await consumePromise;
      if (streamError) throw streamError;
      const aggregated = aggregateOpenAiStream(sseEvents);
      return responseFromOpenAiData(aggregated);
    }
  };
}

function responseFromOpenAiData(data) {
  const message = data?.choices?.[0]?.message;
  if (!message) {
    throw new Error("Provider response did not include choices[0].message");
  }
  const usage = normalizeUsage(data?.usage);
  const toolCalls = normalizeOpenAiToolCalls(message.tool_calls);
  // DeepSeek thinking-mode reasoning_content (also exposed under `reasoning`
  // by some upstream proxies). Bubble it up so callers can persist + echo.
  const reasoningContent = typeof message.reasoning_content === "string"
    ? message.reasoning_content
    : typeof message.reasoning === "string"
      ? message.reasoning
      : null;
  if (toolCalls.length > 0) {
    return { message, toolCalls, usage, reasoningContent };
  }
  const normalizedContent = normalizeOpenAiContent(message.content, message);
  return {
    message: { ...message, content: normalizedContent },
    toolCalls: [],
    usage,
    reasoningContent,
    raw: data
  };
}

function extractOpenAiDeltaText(sse) {
  if (!sse || typeof sse !== "object") return "";
  const delta = sse.choices?.[0]?.delta;
  if (!delta) return "";
  const content = delta.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === "string" ? part.text : typeof part === "string" ? part : ""))
      .join("");
  }
  return "";
}

function extractOpenAiReasoningDeltaText(sse) {
  if (!sse || typeof sse !== "object") return "";
  const delta = sse.choices?.[0]?.delta;
  if (!delta) return "";
  // DeepSeek/SiliconFlow expose `reasoning_content`; OpenRouter and some
  // proxies expose `reasoning`. Either is the chain-of-thought stream.
  const reasoning = delta.reasoning_content ?? delta.reasoning;
  return typeof reasoning === "string" ? reasoning : "";
}

function aggregateOpenAiStream(sseEvents) {
  const message = { role: "assistant", content: "" };
  const toolCallsByIndex = new Map();
  let usage = null;
  for (const event of sseEvents) {
    if (!event || typeof event !== "object") continue;
    if (event.type === "done") continue;
    if (event.usage) {
      usage = { ...(usage ?? {}), ...event.usage };
    }
    const choice = event.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    if (typeof delta.role === "string") message.role = delta.role;
    const content = delta.content;
    if (typeof content === "string") {
      message.content += content;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === "string") message.content += part;
        else if (typeof part?.text === "string") message.content += part.text;
      }
    }
    // DeepSeek / SiliconFlow "thinking mode" emits reasoning content out of
    // band; the API requires it to be echoed back on the next turn (error
    // code 20015 otherwise). Accumulate the streamed reasoning so we can
    // surface it on the resulting Message.
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === "string" && reasoning.length > 0) {
      message.reasoning_content = (message.reasoning_content ?? "") + reasoning;
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        if (!tc || typeof tc !== "object") continue;
        const idx = typeof tc.index === "number" ? tc.index : toolCallsByIndex.size;
        let entry = toolCallsByIndex.get(idx);
        if (!entry) {
          entry = { id: tc.id ?? "", type: "function", function: { name: "", arguments: "" } };
          toolCallsByIndex.set(idx, entry);
        }
        if (typeof tc.id === "string" && tc.id.length > 0) entry.id = tc.id;
        if (tc.function?.name) entry.function.name = (entry.function.name ?? "") + tc.function.name;
        if (typeof tc.function?.arguments === "string") {
          entry.function.arguments = (entry.function.arguments ?? "") + tc.function.arguments;
        }
      }
    }
  }
  if (toolCallsByIndex.size > 0) {
    message.tool_calls = [...toolCallsByIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, entry]) => entry);
    message.content = null;
  }
  return {
    choices: [{ message }],
    usage
  };
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return { ...ZERO_USAGE };
  const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens ?? 0);
  const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens ?? 0);
  // Cache accounting: OpenAI reports prompt_tokens_details.cached_tokens,
  // DeepSeek reports prompt_cache_hit_tokens (automatic disk cache). Both
  // surface as cacheReadTokens so measure-token-usage.mjs sees hit rates.
  const cacheReadTokens = Number(
    usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? usage.cacheReadTokens ?? 0
  );
  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    ...(Number.isFinite(cacheReadTokens) && cacheReadTokens > 0 ? { cacheReadTokens } : {})
  };
}

export class ProviderRequestError extends Error {
  constructor({ status, statusText, body, retryable }) {
    super(`Provider request failed: ${status} ${statusText}\n${body}`);
    this.name = "ProviderRequestError";
    this.status = status;
    this.statusText = statusText;
    this.body = body;
    this.retryable = retryable;
  }
}

async function fetchWithRetry({ endpoint, request, fetchImpl, sleepImpl, maxRetries, retryBaseDelayMs }) {
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(endpoint, request);
    } catch (err) {
      // Transient network failures ("fetch failed", ECONNRESET, ENOTFOUND, …)
      // throw before producing a Response. Treat them the same as HTTP 5xx —
      // back off and retry until exhausted.
      lastError = err;
      if (!isRetryableNetworkError(err) || attempt >= maxRetries) break;
      await sleepImpl(getRetryDelayMs({ response: null, attempt, retryBaseDelayMs }));
      continue;
    }
    const text = await response.text();
    if (response.ok) return { response, text, attempt };

    const retryable = isRetryableStatus(response.status);
    lastError = new ProviderRequestError({
      status: response.status,
      statusText: response.statusText,
      body: text,
      retryable
    });
    if (!retryable || attempt >= maxRetries) break;
    await sleepImpl(getRetryDelayMs({ response, attempt, retryBaseDelayMs }));
  }
  throw lastError;
}

async function fetchStreamingWithRetry({ endpoint, request, fetchImpl, sleepImpl, maxRetries, retryBaseDelayMs }) {
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(endpoint, request);
    } catch (err) {
      lastError = err;
      if (!isRetryableNetworkError(err) || attempt >= maxRetries) break;
      await sleepImpl(getRetryDelayMs({ response: null, attempt, retryBaseDelayMs }));
      continue;
    }
    if (response.ok) return response;
    const text = typeof response.text === "function" ? await response.text() : "";
    const retryable = isRetryableStatus(response.status);
    lastError = new ProviderRequestError({
      status: response.status,
      statusText: response.statusText,
      body: text,
      retryable
    });
    if (!retryable || attempt >= maxRetries) break;
    await sleepImpl(getRetryDelayMs({ response, attempt, retryBaseDelayMs }));
  }
  throw lastError;
}

function isRetryableStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

// Caught errors thrown by Node's global fetch (undici) on transient network
// failures. Codes vary by failure mode; the wrapper Error usually carries a
// `code` or a `cause.code`. We treat the common transient set as retryable.
const RETRYABLE_NETWORK_CODES = new Set([
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
]);

export function isRetryableNetworkError(err) {
  if (err == null) return false;
  if (err.name === "ProviderRequestError") return false;
  if (err.name === "AbortError") return false;
  const code = err.code ?? err.cause?.code;
  if (code && RETRYABLE_NETWORK_CODES.has(code)) return true;
  // undici exposes `cause: new TypeError('fetch failed')` when the underlying
  // request layer threw without a recognized errno. The TypeError itself is
  // the only signal we have for this case — assume transient.
  if (err.name === "TypeError" && /fetch failed/i.test(err.message ?? "")) return true;
  if (err.cause?.name === "TypeError" && /fetch failed/i.test(err.cause.message ?? "")) return true;
  return false;
}

function getRetryDelayMs({ response, attempt, retryBaseDelayMs }) {
  // Network failures (no response yet) skip Retry-After parsing and go
  // straight to exponential backoff.
  if (response == null) return retryBaseDelayMs * 2 ** attempt;
  const retryAfter = response.headers?.get?.("retry-after");
  const retryAfterSeconds = Number(retryAfter);
  if (retryAfter != null && retryAfter !== "" && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return retryAfterSeconds * 1000;
  }
  return retryBaseDelayMs * 2 ** attempt;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
