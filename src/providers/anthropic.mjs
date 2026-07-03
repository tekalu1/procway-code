import { applyPromptCacheBreakpoints, fromAnthropicContent, toAnthropicMessages, toAnthropicTools } from "./format/anthropic.mjs";
import { parseSseStream } from "./sse.mjs";
import { reasoningEffortToAnthropicBudget } from "./reasoning.mjs";

const ZERO_USAGE = Object.freeze({ inputTokens: 0, outputTokens: 0 });

export async function runAnthropicProvider({
  provider,
  model,
  messages,
  tools,
  prompt,
  fetchImpl = globalThis.fetch,
  stream = true
}) {
  if (!fetchImpl) throw new Error("fetch is not available in this Node.js runtime");
  // anthropic-via-proxy (ADR 0008 §F7c) talks to the dashboard credential
  // broker, which injects the real credential upstream. The session holds no
  // API key, so the key is optional for that type; for direct anthropic /
  // anthropic-compatible providers it is still required.
  const viaProxy = provider.type === "anthropic-via-proxy";
  const apiKey = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined;
  if (!apiKey && !viaProxy) throw new Error(`Missing API key environment variable: ${provider.apiKeyEnv}`);

  const sourceMessages = messages ?? [{ role: "user", content: prompt }];
  const { system, anthropicMessages } = toAnthropicMessages(sourceMessages);
  const endpoint = `${provider.baseUrl.replace(/\/$/, "")}/v1/messages`;
  // ADR 0008 §F7 / T1-17: present the session-scoped broker token so the
  // dashboard proxy can verify the request belongs to this session's tenant.
  // Injected at spawn as PROCWAY_PROXY_TOKEN; absent in local/single-tenant
  // mode, where the proxy stays unauthenticated.
  const proxyToken = viaProxy ? process.env.PROCWAY_PROXY_TOKEN : undefined;
  const headers = {
    // Omit x-api-key entirely when going through the proxy: the broker
    // strips any inbound credential and attaches its own.
    ...(apiKey ? { "x-api-key": apiKey } : {}),
    ...(proxyToken ? { authorization: `Bearer ${proxyToken}` } : {}),
    "anthropic-version": provider.version ?? "2023-06-01",
    "content-type": "application/json"
  };
  // Extended thinking is a token budget rather than an effort level. When
  // enabled, Anthropic requires max_tokens > budget_tokens, so grow the output
  // ceiling to leave room for the visible answer on top of the thinking budget.
  const thinkingBudget = reasoningEffortToAnthropicBudget(provider.reasoningEffort);
  const baseMaxTokens = provider.maxTokens ?? 2048;
  const maxTokens = thinkingBudget ? Math.max(baseMaxTokens, thinkingBudget + 1024) : baseMaxTokens;
  const body = {
    model,
    max_tokens: maxTokens,
    ...(thinkingBudget ? { thinking: { type: "enabled", budget_tokens: thinkingBudget } } : {}),
    ...(system ? { system } : {}),
    // Prompt caching (GA, no beta header): breakpoints on the first user
    // message (the byte-stable worker prompt) + the last message (rolling
    // conversation prefix) + the last tool def (inside toAnthropicTools).
    // The via-proxy broker forwards the body verbatim, so cache_control
    // survives the SaaS path. Opt out per provider with promptCaching:false.
    messages: provider.promptCaching === false
      ? anthropicMessages
      : applyPromptCacheBreakpoints(anthropicMessages),
    ...(tools?.length
      ? { tools: toAnthropicTools(tools, { cacheControl: provider.promptCaching !== false }) }
      : {})
  };

  if (stream && provider.stream !== false) {
    return runStreaming({ endpoint, headers, body, fetchImpl });
  }
  return runNonStreaming({ endpoint, headers, body, fetchImpl });
}

async function runNonStreaming({ endpoint, headers, body, fetchImpl }) {
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Provider request failed: ${response.status} ${response.statusText}\n${text}`);
  }
  const data = JSON.parse(text);
  const { text: contentText, toolCalls } = fromAnthropicContent(data.content);
  const { text: reasoningContent, signature: reasoningSignature } = extractThinking(data.content);
  const usage = normalizeUsage(data.usage);
  const reasoning = thinkingFields(reasoningContent, reasoningSignature);
  if (toolCalls.length > 0) {
    return {
      message: assistantToolMessage(toolCalls),
      toolCalls,
      usage,
      ...reasoning
    };
  }
  return {
    message: { role: "assistant", content: contentText },
    toolCalls: [],
    usage,
    ...reasoning
  };
}

async function runStreaming({ endpoint, headers, body, fetchImpl }) {
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...body, stream: true })
  });
  if (!response.ok) {
    const errText = typeof response.text === "function" ? await response.text() : "";
    throw new Error(`Provider request failed: ${response.status} ${response.statusText}\n${errText}`);
  }

  const sseEvents = [];
  /** @type {Array<{deltaText: string, raw: object}>} */
  const chunkBuffer = [];
  let chunkResolver = null;
  let streamDone = false;
  let streamError = null;

  const consumePromise = (async () => {
    try {
      for await (const sse of parseSseStream(response.body)) {
        sseEvents.push(sse);
        if (sse?.type === "content_block_delta" && typeof sse?.delta?.type === "string") {
          // Extended-thinking deltas stream as `thinking_delta` (text in
          // `delta.thinking`) ahead of the visible answer. Tag them
          // kind:"reasoning" so the orchestrator routes them to the live
          // thinking view, matching the openai-codex contract.
          if (sse.delta.type === "thinking_delta" && typeof sse.delta.thinking === "string" && sse.delta.thinking.length > 0) {
            chunkBuffer.push({ deltaText: sse.delta.thinking, kind: "reasoning", raw: sse });
            if (chunkResolver) {
              const r = chunkResolver;
              chunkResolver = null;
              r();
            }
          } else if (sse.delta.type === "text_delta" && typeof sse.delta.text === "string" && sse.delta.text.length > 0) {
            chunkBuffer.push({ deltaText: sse.delta.text, raw: sse });
            if (chunkResolver) {
              const r = chunkResolver;
              chunkResolver = null;
              r();
            }
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
      const aggregated = aggregateAnthropicSseEvents(sseEvents);
      const { text: contentText, toolCalls } = fromAnthropicContent(aggregated.contentBlocks);
      const { text: reasoningContent, signature: reasoningSignature } = extractThinking(aggregated.contentBlocks);
      const usage = normalizeUsage(aggregated.usage);
      const reasoning = thinkingFields(reasoningContent, reasoningSignature);
      if (toolCalls.length > 0) {
        return {
          message: assistantToolMessage(toolCalls),
          toolCalls,
          usage,
          ...reasoning
        };
      }
      return {
        message: { role: "assistant", content: contentText },
        toolCalls: [],
        usage,
        ...reasoning
      };
    }
  };
}

function assistantToolMessage(toolCalls) {
  return {
    role: "assistant",
    content: null,
    tool_calls: toolCalls.map((toolCall) => ({
      id: toolCall.id,
      type: "function",
      function: {
        name: toolCall.name,
        arguments: JSON.stringify(toolCall.args ?? {})
      }
    }))
  };
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return { ...ZERO_USAGE };
  const inputTokens = Number(usage.input_tokens ?? usage.inputTokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? usage.outputTokens ?? 0);
  // Prompt-cache accounting (audit ④): without these the cache savings are
  // invisible — input_tokens EXCLUDES cached reads on Anthropic, so a
  // cache-hitting session would look implausibly cheap instead of measurably
  // cached. Flows into usage.recorded → events.jsonl →
  // scripts/measure-token-usage.mjs.
  const cacheReadTokens = Number(usage.cache_read_input_tokens ?? usage.cacheReadTokens ?? 0);
  const cacheWriteTokens = Number(usage.cache_creation_input_tokens ?? usage.cacheWriteTokens ?? 0);
  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    ...(Number.isFinite(cacheReadTokens) && cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    ...(Number.isFinite(cacheWriteTokens) && cacheWriteTokens > 0 ? { cacheWriteTokens } : {})
  };
}

function aggregateAnthropicSseEvents(sseEvents) {
  const blocks = [];
  let usage = null;
  for (const event of sseEvents) {
    if (!event || typeof event !== "object") continue;
    if (event.type === "content_block_start") {
      const index = event.index ?? blocks.length;
      const block = event.content_block ?? {};
      blocks[index] = cloneAnthropicBlock(block);
      continue;
    }
    if (event.type === "content_block_delta") {
      const index = event.index ?? blocks.length - 1;
      const target = blocks[index] ?? (blocks[index] = { type: "text", text: "" });
      if (event.delta?.type === "text_delta" && typeof event.delta.text === "string") {
        target.type = "text";
        target.text = (target.text ?? "") + event.delta.text;
      } else if (event.delta?.type === "thinking_delta" && typeof event.delta.thinking === "string") {
        target.type = "thinking";
        target.thinking = (target.thinking ?? "") + event.delta.thinking;
      } else if (event.delta?.type === "signature_delta" && typeof event.delta.signature === "string") {
        // Extended-thinking blocks carry a signature that must be echoed back
        // verbatim on the next request (Anthropic rejects tool-use turns whose
        // thinking block lost its signature).
        target.type = "thinking";
        target.signature = (target.signature ?? "") + event.delta.signature;
      } else if (event.delta?.type === "input_json_delta" && typeof event.delta.partial_json === "string") {
        target.type = "tool_use";
        target.input_buffer = (target.input_buffer ?? "") + event.delta.partial_json;
      }
      continue;
    }
    if (event.type === "content_block_stop") {
      const index = event.index ?? blocks.length - 1;
      const target = blocks[index];
      if (target && target.type === "tool_use" && typeof target.input_buffer === "string") {
        try {
          target.input = target.input_buffer.length === 0 ? {} : JSON.parse(target.input_buffer);
        } catch {
          target.input = {};
        }
        delete target.input_buffer;
      }
      continue;
    }
    if (event.type === "message_delta" && event.usage) {
      usage = { ...(usage ?? {}), ...event.usage };
      continue;
    }
    if (event.type === "message_start" && event.message?.usage) {
      usage = { ...(usage ?? {}), ...event.message.usage };
    }
  }
  return {
    contentBlocks: blocks.filter(Boolean),
    usage
  };
}

function cloneAnthropicBlock(block) {
  if (block.type === "tool_use") {
    return {
      type: "tool_use",
      id: block.id,
      name: block.name,
      input: block.input ?? {},
      input_buffer: ""
    };
  }
  if (block.type === "text") {
    return { type: "text", text: typeof block.text === "string" ? block.text : "" };
  }
  if (block.type === "thinking") {
    return {
      type: "thinking",
      thinking: typeof block.thinking === "string" ? block.thinking : "",
      signature: typeof block.signature === "string" ? block.signature : ""
    };
  }
  return { ...block };
}

/**
 * Pull the aggregated thinking text + signature out of Anthropic content
 * blocks (streaming or non-streaming). Returns empty strings when extended
 * thinking was not used.
 *
 * @param {Array<object> | null | undefined} contentBlocks
 * @returns {{ text: string, signature: string }}
 */
function extractThinking(contentBlocks) {
  const blocks = Array.isArray(contentBlocks) ? contentBlocks : [];
  let text = "";
  let signature = "";
  for (const block of blocks) {
    if (block?.type === "thinking") {
      if (typeof block.thinking === "string") text += block.thinking;
      if (typeof block.signature === "string" && block.signature.length > 0) signature = block.signature;
    }
  }
  return { text, signature };
}

/**
 * Build the `{ reasoningContent, reasoningSignature }` slice of a provider
 * response, omitting empty fields. The orchestrator persists these on the
 * assistant message's meta so toAnthropicMessages can re-attach the thinking
 * block (with signature) on the follow-up request.
 */
function thinkingFields(text, signature) {
  const out = {};
  if (typeof text === "string" && text.length > 0) out.reasoningContent = text;
  if (typeof signature === "string" && signature.length > 0) out.reasoningSignature = signature;
  return out;
}
