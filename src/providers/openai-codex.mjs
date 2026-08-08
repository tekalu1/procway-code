import { getValidCredentials } from "../auth/refresh-guard.mjs";
import { messageContentToText } from "../core/types/message.mjs";
import { parseSseStream } from "./sse.mjs";
import { ProviderRequestError, isRetryableNetworkError } from "./openai-compatible.mjs";
import { normalizeReasoningEffort } from "./reasoning.mjs";
import { isInlineImageBlock, imageBlockToDataUrl } from "./image-hydration.mjs";
import { llmFetch } from "./llm-fetch.mjs";
import { parseToolArgs } from "./format/tool-args.mjs";

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api/codex";
const DEFAULT_CLIENT_VERSION = "0.0.1";
const DEFAULT_ORIGINATOR = "procway";
const DEFAULT_PROFILE_ID = "codex";

const ZERO_USAGE = Object.freeze({ inputTokens: 0, outputTokens: 0 });

/**
 * ChatGPT backend (Responses API over `chatgpt.com/backend-api/codex`).
 * Always opens an SSE response (upstream rejects `stream: false`) and collapses
 * the deltas into the same `{ message, toolCalls, usage }` shape returned by
 * the openai-compatible provider.
 *
 * Authentication is OAuth — provider.authProfile selects which profile from
 * auth-profiles.json to use. The access token is refreshed automatically on
 * 401 (one retry).
 *
 * @param {object} args
 * @param {{ type: "openai-codex"; authProfile?: string; baseUrl?: string; defaultModel?: string; clientVersion?: string; originator?: string; maxRetries?: number }} args.provider
 * @param {string} [args.model]
 * @param {string} [args.prompt]
 * @param {Array<object>} [args.messages]
 * @param {Array<object>} [args.tools]  Chat Completions-style tool defs.
 * @param {typeof globalThis.fetch} [args.fetchImpl]
 * @param {AbortSignal} [args.signal]
 * @param {boolean} [args.stream]  When true (default), returns
 *   `{ deltaStream, finalize }` where deltaStream yields
 *   `{ deltaText, raw }` text fragments as they arrive and finalize()
 *   resolves to the aggregated `{ message, toolCalls, usage }` once the
 *   stream ends. When false, blocks until the stream ends and returns
 *   the aggregated shape directly.
 */
export async function runOpenAiCodexProvider({
  provider,
  model,
  prompt,
  messages,
  tools,
  fetchImpl = llmFetch,
  signal,
  stream = true
}) {
  if (!fetchImpl) throw new Error("fetch is not available in this Node.js runtime");

  // openai-codex-via-proxy (ADR 0008 §F7c): the dashboard credential broker
  // holds + refreshes the OAuth token and injects Authorization +
  // chatgpt-account-id upstream. The session builds the same body/url and
  // sends its client-identity headers (originator/User-Agent), but carries NO
  // credential and never reads auth-profiles.json.
  const viaProxy = provider.type === "openai-codex-via-proxy";
  // ADR 0008 §F7 / T1-17: present the session-scoped broker token so the
  // dashboard proxy can verify the request belongs to this session's tenant.
  // The broker strips this inbound Authorization and injects the real codex
  // OAuth Bearer + chatgpt-account-id upstream (relay.ts STRIPPED_INBOUND), so
  // there's no header collision. Injected at spawn as PROCWAY_PROXY_TOKEN;
  // absent in local/single-tenant mode, where the proxy stays unauthenticated.
  const proxyToken = viaProxy ? process.env.PROCWAY_PROXY_TOKEN : undefined;
  const profileId = provider.authProfile ?? DEFAULT_PROFILE_ID;
  const baseUrl = (provider.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const clientVersion = provider.clientVersion ?? DEFAULT_CLIENT_VERSION;
  const originator = provider.originator ?? DEFAULT_ORIGINATOR;
  const resolvedModel = model || provider.defaultModel;
  if (!resolvedModel) throw new Error("openai-codex provider requires a model (set provider.defaultModel)");

  const sourceMessages = Array.isArray(messages) && messages.length > 0
    ? messages
    : [{ role: "user", content: prompt ?? "" }];
  const { instructions, input } = toResponsesPayload(sourceMessages);
  const responsesTools = toResponsesTools(tools, { strict: provider.strictTools === true });

  // Responses API reasoning control. When effort is configured we also request
  // `summary: "auto"` so the model streams `reasoning_summary_text.delta`
  // chunks — those drive the dashboard's live "thinking" view. Omitting the
  // field entirely preserves the upstream default (which for gpt-5.5-class
  // models is high effort → minutes of latency even for tiny answers).
  const reasoningEffort = normalizeReasoningEffort(provider.reasoningEffort);
  const url = `${baseUrl}/responses?client_version=${encodeURIComponent(clientVersion)}`;
  const body = JSON.stringify({
    model: resolvedModel,
    instructions,
    input,
    store: false,
    stream: true,
    ...(reasoningEffort ? { reasoning: { effort: reasoningEffort, summary: "auto" } } : {}),
    ...(responsesTools.length > 0 ? { tools: responsesTools, tool_choice: "auto", parallel_tool_calls: true } : {})
  });

  const buildHeaders = viaProxy
    ? () => ({
        // Session-scoped broker token only; the broker strips it and injects
        // the real Authorization + chatgpt-account-id upstream.
        ...(proxyToken ? { Authorization: `Bearer ${proxyToken}` } : {}),
        originator,
        "User-Agent": `${originator}/${clientVersion}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream"
      })
    : (credentials) => ({
        Authorization: `Bearer ${credentials.access}`,
        "chatgpt-account-id": credentials.accountId,
        originator,
        "User-Agent": `${originator}/${clientVersion}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream"
      });

  const response = await fetchWithAuthRetry({
    profileId,
    url,
    body,
    buildHeaders,
    fetchImpl,
    signal,
    maxRetries: provider.maxRetries ?? 2,
    viaProxy
  });

  return stream ? runStreaming(response) : runNonStreaming(response);
}

async function fetchWithAuthRetry({ profileId, url, body, buildHeaders, fetchImpl, signal, maxRetries, viaProxy = false }) {
  // via-proxy mode carries no local credentials — the dashboard broker injects
  // them. Skip OAuth resolution and the 401 force-refresh dance entirely.
  let credentials = viaProxy ? null : await getValidCredentials(profileId);
  let forceRefreshed = false;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let response;
    const startedAt = Date.now();
    try {
      response = await fetchImpl(url, { method: "POST", headers: buildHeaders(credentials), body, signal });
    } catch (error) {
      if (attempt >= maxRetries || !isRetryableNetworkError(error)) throw error;
      // Diagnostic for the recurring ~300s stalls: surfaces how long the
      // attempt waited and which undici error fired (e.g. UND_ERR_HEADERS_TIMEOUT
      // ≈ a hung connection that never sent headers) before we retry.
      const code = error?.code ?? error?.cause?.code ?? error?.name ?? "unknown";
      console.error(`[openai-codex] request attempt ${attempt} failed after ${Date.now() - startedAt}ms (${code}); retrying`);
      await sleep(backoffMs(attempt));
      continue;
    }

    if (!viaProxy && response.status === 401 && !forceRefreshed) {
      forceRefreshed = true;
      try {
        credentials = await getValidCredentials(profileId, { force: true });
      } catch (refreshError) {
        const text = await response.text();
        throw new ProviderRequestError({
          status: response.status,
          statusText: response.statusText,
          body: `Authorization expired and refresh failed: ${refreshError.message}\n${text}`,
          retryable: false
        });
      }
      continue;
    }

    if (response.ok) return response;

    const text = await response.text();
    const retryable = isRetryableStatus(response.status);
    if (retryable && attempt < maxRetries) {
      await sleep(backoffMs(attempt));
      continue;
    }
    throw new ProviderRequestError({
      status: response.status,
      statusText: response.statusText,
      body: text,
      retryable
    });
  }
  throw new Error("openai-codex provider: retry loop exhausted without resolution");
}

/**
 * Aggregation state shared by streaming and non-streaming paths.
 */
function createAggregator() {
  return {
    aggregatedText: "",
    reasoningSummary: "",
    usage: null,
    lastError: null,
    // Responses API truncation: response.status "incomplete" with
    // incomplete_details.reason "max_output_tokens" means output was cut off —
    // a tool call's arguments JSON is the likely casualty.
    truncated: false,
    // SSE emits each output item by `output_index`. A single response may
    // produce text + one or more function_calls — keep them keyed by index
    // so deltas land on the right item.
    toolCallsByIndex: new Map()
  };
}

/**
 * Apply one SSE event to the aggregator. Returns either:
 *   - `null`                                    nothing to forward
 *   - `{ kind: "text",      deltaText: string }` output text fragment
 *   - `{ kind: "reasoning", deltaText: string }` reasoning summary fragment
 *
 * The streaming wrapper forwards both kinds into deltaStream so the turn
 * orchestrator can emit `assistant.message.delta` vs
 * `assistant.reasoning.delta` accordingly. Reasoning deltas are surfaced
 * during the "model waiting" window so the dashboard UI can show progress
 * instead of going silent for minutes while gpt-5.5-class models think.
 */
/** Extract final assistant text from a Responses API `response.output[]` — used
 *  as a fallback when the stream delivered no `response.output_text.delta`. */
function extractOutputText(response) {
  const output = Array.isArray(response?.output) ? response.output : [];
  let text = "";
  for (const item of output) {
    if (item?.type !== "message") continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const block of content) {
      if (block?.type === "output_text" && typeof block.text === "string") text += block.text;
    }
  }
  return text;
}

function applyEvent(state, event) {
  if (!event || typeof event !== "object") return null;
  switch (event.type) {
    case "response.output_item.added": {
      const item = event.item;
      if (item?.type === "function_call" && typeof event.output_index === "number") {
        state.toolCallsByIndex.set(event.output_index, {
          id: item.call_id ?? item.id ?? `tc_${event.output_index}`,
          name: item.name ?? "",
          argumentsRaw: typeof item.arguments === "string" ? item.arguments : ""
        });
      }
      return null;
    }
    case "response.function_call_arguments.delta": {
      if (typeof event.delta !== "string" || typeof event.output_index !== "number") return null;
      const entry = state.toolCallsByIndex.get(event.output_index);
      if (entry) entry.argumentsRaw += event.delta;
      return null;
    }
    case "response.function_call_arguments.done": {
      if (typeof event.output_index !== "number") return null;
      const entry = state.toolCallsByIndex.get(event.output_index);
      if (entry && typeof event.arguments === "string") entry.argumentsRaw = event.arguments;
      return null;
    }
    case "response.output_text.delta": {
      if (typeof event.delta !== "string" || event.delta.length === 0) return null;
      state.aggregatedText += event.delta;
      return { kind: "text", deltaText: event.delta };
    }
    case "response.reasoning_summary_text.delta": {
      if (typeof event.delta !== "string" || event.delta.length === 0) return null;
      state.reasoningSummary += event.delta;
      return { kind: "reasoning", deltaText: event.delta };
    }
    case "response.completed":
    case "response.done": {
      const u = event.response?.usage;
      if (u) state.usage = u;
      if (event.response?.status === "incomplete"
        && event.response?.incomplete_details?.reason === "max_output_tokens") {
        state.truncated = true;
      }
      // Fallback: a response that streamed NO output_text.delta (e.g. a long
      // reasoning turn that emitted only keepalive + a final message) carries
      // its text on the completed frame's response.output[]. Without this the
      // assistant message would be empty. Only fill if we got no deltas.
      if (!state.aggregatedText) {
        const finalText = extractOutputText(event.response);
        if (finalText) state.aggregatedText = finalText;
      }
      return null;
    }
    case "response.failed":
    case "response.error":
    case "error":
      state.lastError = event.response?.error ?? event.error ?? event;
      return null;
    default:
      return null;
  }
}

function buildFinalResult(state) {
  if (state.lastError) {
    const message = typeof state.lastError.message === "string"
      ? state.lastError.message
      : JSON.stringify(state.lastError);
    throw new Error(`openai-codex provider stream error: ${message}`);
  }
  const toolCalls = [...state.toolCallsByIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, entry]) => ({
      id: entry.id,
      name: entry.name,
      args: parseToolArgs(entry.argumentsRaw, { truncated: state.truncated })
    }));

  if (toolCalls.length > 0) {
    return {
      message: {
        role: "assistant",
        content: state.aggregatedText || null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.args ?? {})
          }
        }))
      },
      toolCalls,
      usage: normalizeUsage(state.usage),
      reasoningContent: state.reasoningSummary || null
    };
  }

  return {
    message: { role: "assistant", content: state.aggregatedText },
    toolCalls: [],
    usage: normalizeUsage(state.usage),
    reasoningContent: state.reasoningSummary || null
  };
}

async function runNonStreaming(response) {
  const state = createAggregator();
  for await (const event of parseSseStream(response.body)) {
    applyEvent(state, event);
  }
  return buildFinalResult(state);
}

function runStreaming(response) {
  const state = createAggregator();
  const chunkBuffer = [];
  let chunkResolver = null;
  let streamDone = false;
  let streamError = null;

  // Heartbeat: gpt-5.5-class reasoning models stream `response.in_progress`
  // keepalive frames (and function_call arg deltas, item.added, …) for minutes
  // WITHOUT emitting any text/reasoning delta. Those frames reset llm-fetch's
  // inter-chunk body timeout but produce no agent event, so the turn-idle
  // watchdog (conversation.mjs) saw total silence and aborted a perfectly
  // healthy long-reasoning turn → raw "This operation was aborted" in chat.
  // Forward a lightweight, throttled `heartbeat` chunk on ANY non-delta frame so
  // the watchdog's lastProgress is bumped as long as the upstream is alive; a
  // TRUE stall (keepalive also stops) is still caught by the body timeout.
  const HEARTBEAT_THROTTLE_MS = 5000;
  let lastChunkAt = 0;
  const pushChunk = (chunk) => {
    chunkBuffer.push(chunk);
    lastChunkAt = Date.now();
    if (chunkResolver) {
      const r = chunkResolver;
      chunkResolver = null;
      r();
    }
  };
  const consumePromise = (async () => {
    try {
      for await (const event of parseSseStream(response.body)) {
        const delta = applyEvent(state, event);
        if (delta) {
          pushChunk({ deltaText: delta.deltaText, kind: delta.kind, raw: event });
        } else if (Date.now() - lastChunkAt >= HEARTBEAT_THROTTLE_MS) {
          // A non-delta frame (keepalive / tool-arg delta / item.added / …) —
          // proof of life. Throttle so a chatty stream doesn't flood the event
          // log; one bump per 5s is ample for a 90s+ watchdog.
          pushChunk({ kind: "heartbeat", raw: event });
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
      return buildFinalResult(state);
    }
  };
}

/**
 * Convert canonical chat-style messages into the Responses API payload.
 * - system → `instructions` (joined with blank lines)
 * - user → input item with `input_text`
 * - assistant (text only) → input item with `output_text`
 * - assistant (tool_calls) → one `function_call` input item per call
 * - tool → `function_call_output` input item
 *
 * Invariant the API enforces: every `function_call` must be followed by a
 * matching `function_call_output` before the next `user` / `assistant` item,
 * else the request is rejected with 400 "No tool output found for function
 * call <id>" (the TK-15 failure mode — a tool hung mid-round, the runner
 * was reaped, and the conversation reloaded from disk without the missing
 * tool_result messages). After collecting all items we walk the sequence
 * and synthesize a placeholder error output for any orphan function_call.
 */
function toResponsesPayload(messages) {
  const instructionsParts = [];
  const input = [];

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const role = message.role;

    if (role === "system") {
      const text = extractText(message);
      if (text) instructionsParts.push(text);
      continue;
    }

    if (role === "tool") {
      const block = Array.isArray(message.content)
        ? message.content.find((b) => b?.kind === "tool_result")
        : null;
      const callId = block?.toolCallId ?? message.toolCallId ?? message.tool_call_id;
      if (!callId) continue;
      const payload = block
        ? (block.ok === false ? { error: block.result?.error ?? block.result } : block.result)
        : extractToolOutput(message);
      // Match the openai-compatible adapter (messageToRawShape): always
      // JSON-stringify the payload so consumers can parse the output
      // uniformly. Plain strings end up quoted; the model handles both.
      input.push({
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(payload ?? null)
      });
      // The Responses API has no way to attach an image to a
      // function_call_output, so images surfaced by a tool (e.g. view_image)
      // are delivered as a following user item with input_image parts. This
      // sits after the output, satisfying the call→output ordering invariant.
      const toolImages = collectInlineImages(message);
      if (toolImages.length > 0) {
        input.push({
          role: "user",
          content: [
            { type: "input_text", text: "[view_image] image(s) from the preceding tool result:" },
            ...toolImages.map(toResponsesImagePart)
          ]
        });
      }
      continue;
    }

    if (role === "assistant") {
      const toolCalls = extractAssistantToolCalls(message);
      const text = extractText(message);
      if (text) input.push({ role: "assistant", content: [{ type: "output_text", text }] });
      for (const call of toolCalls) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.args ?? {})
        });
      }
      continue;
    }

    if (role === "user") {
      const text = extractText(message);
      const images = collectInlineImages(message);
      const content = [];
      if (text || images.length === 0) content.push({ type: "input_text", text });
      for (const img of images) content.push(toResponsesImagePart(img));
      input.push({ role: "user", content });
      continue;
    }
  }

  const repaired = repairOrphanFunctionCalls(input);

  if (repaired.length === 0) {
    repaired.push({ role: "user", content: [{ type: "input_text", text: "" }] });
  }

  return {
    instructions: instructionsParts.join("\n\n"),
    input: repaired
  };
}

/**
 * Reconcile `function_call` / `function_call_output` pairs so the input
 * satisfies the Responses API contract. The API rejects two kinds of orphan:
 *
 *   1. A `function_call` with no matching `function_call_output`
 *      → "No tool output found for function call <id>". Filled with a
 *      synthesized error payload (TK-15: runner reaped between
 *      `assistant.message.completed` and `tool.call.completed`).
 *
 *   2. A `function_call_output` with no matching `function_call`
 *      → "No tool call found for function call output with call_id <id>".
 *      Dropped. This is the compaction failure mode: the summarizer's
 *      keep-last boundary fell between an assistant tool_use and its
 *      tool_result, so the tool_use was folded into the summary while the
 *      orphaned result survived in the kept tail. (compactor.resolveTailStart
 *      now prevents this for new sessions; dropping here salvages sessions
 *      already persisted in the broken state.)
 *
 * Both checks are presence-based, not position-based — strictly the API cares
 * about ordering, but in practice outputs always immediately follow their
 * calls, so presence is what we patch over.
 */
function repairOrphanFunctionCalls(input) {
  const seenOutputs = new Set();
  const seenCalls = new Set();
  for (const item of input) {
    if (!item || typeof item.call_id !== "string") continue;
    if (item.type === "function_call_output") seenOutputs.add(item.call_id);
    else if (item.type === "function_call") seenCalls.add(item.call_id);
  }

  const out = [];
  for (const item of input) {
    // Orphan output (call_id with no originating function_call): drop it.
    if (item && item.type === "function_call_output"
        && typeof item.call_id === "string" && !seenCalls.has(item.call_id)) {
      continue;
    }
    out.push(item);
    // Orphan call (no output): synthesize a placeholder result right after it.
    if (item && item.type === "function_call" && typeof item.call_id === "string" && !seenOutputs.has(item.call_id)) {
      out.push({
        type: "function_call_output",
        call_id: item.call_id,
        output: JSON.stringify({
          error: "tool result missing (worker reaped or interrupted before completion)",
          tool: item.name ?? null,
          synthesized: true
        })
      });
      // Mark as covered so a duplicate function_call with the same id later
      // in the stream doesn't double-fill.
      seenOutputs.add(item.call_id);
    }
  }
  return out;
}

/**
 * Convert Chat Completions-style tool definitions to Responses-API shape.
 *
 * Chat Completions: `{ type: "function", function: { name, description, parameters } }`
 * Responses:        `{ type: "function", name, description, parameters, strict? }`
 *
 * `strict` is opt-in (provider.strictTools=true). Strict mode demands the
 * JSON Schema list every property in `required` and set
 * `additionalProperties: false` on every object — ai-agent's built-in tools
 * (list_files, run_shell, etc.) don't satisfy that, so we default to off.
 */
function toResponsesTools(tools, { strict = false } = {}) {
  if (!Array.isArray(tools) || tools.length === 0) return [];
  const out = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    if (tool.type && tool.type !== "function") continue;
    const fn = tool.function ?? tool;
    const name = fn.name;
    if (!name) continue;
    const parameters = strict
      ? ensureStrictParameters(fn.parameters)
      : (fn.parameters ?? { type: "object", properties: {} });
    const entry = {
      type: "function",
      name,
      description: fn.description ?? "",
      parameters
    };
    if (strict) entry.strict = true;
    out.push(entry);
  }
  return out;
}

function ensureStrictParameters(parameters) {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    return { type: "object", properties: {}, required: [], additionalProperties: false };
  }
  return injectAdditionalPropertiesFalse(parameters);
}

function injectAdditionalPropertiesFalse(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const next = { ...schema };
  if (next.type === "object") {
    if (next.additionalProperties === undefined) next.additionalProperties = false;
    if (next.properties && typeof next.properties === "object") {
      const props = {};
      for (const [key, value] of Object.entries(next.properties)) {
        props[key] = injectAdditionalPropertiesFalse(value);
      }
      next.properties = props;
    }
  } else if (next.type === "array" && next.items) {
    next.items = injectAdditionalPropertiesFalse(next.items);
  }
  return next;
}

function collectInlineImages(message) {
  if (!Array.isArray(message?.content)) return [];
  return message.content.filter(isInlineImageBlock);
}

function toResponsesImagePart(block) {
  return { type: "input_image", image_url: imageBlockToDataUrl(block) };
}

function extractText(message) {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    const text = messageContentToText(message);
    if (text) return text;
  }
  return "";
}

function extractToolOutput(message) {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    const text = messageContentToText(message);
    if (text) return text;
    return JSON.stringify(message.content);
  }
  return JSON.stringify(message.content ?? "");
}

function extractAssistantToolCalls(message) {
  // Canonical ai-agent shape: content blocks with kind: "tool_use" carrying
  // `toolCallId` + `args`. See core/types/message.mjs and the equivalent
  // adapter in agent/conversation.mjs (messageToRawShape).
  if (Array.isArray(message.content)) {
    const blocks = message.content.filter((b) => b?.kind === "tool_use");
    if (blocks.length > 0) {
      return blocks.map((block) => ({
        id: block.toolCallId,
        name: block.name,
        args: block.args,
        arguments: JSON.stringify(block.args ?? {})
      }));
    }
  }
  // OpenAI Chat Completions shape (when callers hand us the openai-compatible
  // return value directly without normalizing to ContentBlock form).
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return message.tool_calls.map((tc) => ({
      id: tc.id,
      name: tc.function?.name ?? tc.name ?? "",
      arguments: tc.function?.arguments ?? tc.arguments,
      args: tc.args
    }));
  }
  return [];
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return { ...ZERO_USAGE };
  const inputTokens = Number(
    usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens ?? 0
  );
  const outputTokens = Number(
    usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens ?? 0
  );
  // Responses API reports cached prompt reads under input_tokens_details.
  const cacheReadTokens = Number(
    usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? usage.cacheReadTokens ?? 0
  );
  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    ...(Number.isFinite(cacheReadTokens) && cacheReadTokens > 0 ? { cacheReadTokens } : {})
  };
}

function isRetryableStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function backoffMs(attempt) {
  return 1000 * 2 ** attempt;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
