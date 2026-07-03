const DEFAULT_AUTO_COMPACT = {
  enabled: false,
  messageCount: 40,
  estimatedTokens: 60000,
  keepLastMessages: 10,
  strategy: "llm-summary",
  // Orthogonal to `strategy`: when true, tool-result messages in the
  // compactable region are dropped before the strategy runs. Mainly a cost
  // lever for `llm-summary` (the summarizer sees fewer tokens); a no-op for
  // `truncate-oldest`, which deletes the region regardless.
  dropToolResults: false
};

// Strategies the *engine* accepts. `summarize-context` / `summarize-aggressive`
// are no longer offered in the UI (see the dashboard's AUTO_COMPACT_STRATEGIES)
// but stay here because `summarize-context` is the deterministic fallback for
// `llm-summary`, and an explicit value in settings.json is still honored.
// "drop-tool-results" was removed as a strategy and is now the orthogonal
// `dropToolResults` toggle — getCompactConfig migrates the legacy value.
const COMPACT_STRATEGIES = new Set([
  "summarize-context",
  "summarize-aggressive",
  "truncate-oldest",
  "llm-summary"
]);

export function getCompactConfig(settings = {}) {
  const merged = {
    ...DEFAULT_AUTO_COMPACT,
    ...(settings.session?.autoCompact ?? {})
  };
  // Legacy migration: the old "drop-tool-results" strategy becomes the
  // deterministic summary plus the new orthogonal toggle, so existing
  // settings keep dropping tool noise without an LLM call.
  if (merged.strategy === "drop-tool-results") {
    merged.strategy = "summarize-context";
    merged.dropToolResults = true;
  }
  return merged;
}

export function getCompactStatus({ messages, settings = {} }) {
  const config = getCompactConfig(settings);
  const estimatedTokens = estimateTokens(messages);
  return {
    enabled: config.enabled,
    messageCount: messages.length,
    estimatedTokens,
    messageCountThreshold: config.messageCount,
    estimatedTokensThreshold: config.estimatedTokens,
    keepLastMessages: config.keepLastMessages,
    strategy: config.strategy,
    dropToolResults: config.dropToolResults === true,
    shouldCompact: shouldAutoCompact({ messages, settings })
  };
}

export function shouldAutoCompact({ messages, settings = {} }) {
  const config = getCompactConfig(settings);
  if (!config.enabled) return false;
  // Auto-compaction is triggered solely by the estimated token count
  // (issue #106). `messageCount` is no longer a trigger — it is retained in
  // settings/status only as an informational figure for backward compat.
  return estimateTokens(messages) > config.estimatedTokens;
}

export function compactMessages({
  messages,
  strategy = "summarize-context",
  keepLastMessages = 10,
  dropToolResults = false,
  now = new Date()
}) {
  if (!COMPACT_STRATEGIES.has(strategy)) {
    throw new Error(`Unknown compact strategy: ${strategy}`);
  }
  if (strategy === "llm-summary") {
    // Synchronous variant: fall through to summarize-context. Async callers
    // use compactMessagesLlm in compactor/llm-summary.mjs instead.
    strategy = "summarize-context";
  }
  const normalizedKeepLast = Math.max(1, Number(keepLastMessages) || DEFAULT_AUTO_COMPACT.keepLastMessages);
  const notCompacted = {
    compacted: false,
    messages,
    summary: "",
    removedMessages: 0,
    strategy,
    keepLastMessages: normalizedKeepLast
  };
  if (messages.length <= normalizedKeepLast + 1) return notCompacted;

  const { head, compactable, tail } = splitMessages(messages, normalizedKeepLast);
  if (compactable.length === 0) return notCompacted;

  if (strategy === "truncate-oldest") {
    // The whole compactable region is dropped; dropToolResults is moot here.
    return {
      compacted: true,
      messages: [...head, ...tail],
      summary: "",
      removedMessages: compactable.length,
      strategy,
      keepLastMessages: normalizedKeepLast
    };
  }

  // Orthogonal toggle: feed the summarizer only non-tool messages from the
  // compactable region so verbose tool output doesn't dominate (or inflate)
  // the summary. The region collapses to a single summary message either way,
  // so this never changes the surrounding transcript — only the summary body.
  const summarizable = dropToolResults
    ? compactable.filter((message) => message.role !== "tool")
    : compactable;
  if (summarizable.length === 0) {
    // Region was nothing but tool results and we dropped them — collapse to
    // nothing rather than minting an empty summary.
    return {
      compacted: true,
      messages: [...head, ...tail],
      summary: "",
      removedMessages: compactable.length,
      strategy,
      keepLastMessages: normalizedKeepLast
    };
  }

  const summary = strategy === "summarize-aggressive"
    ? buildAggressiveSummary(summarizable, now)
    : buildContextSummary(summarizable, now);
  return {
    compacted: true,
    messages: [
      ...head,
      {
        role: "system",
        content: summary,
        compacted: true,
        compactedAt: now.toISOString(),
        compactStrategy: strategy,
        originalMessageCount: compactable.length
      },
      ...tail
    ],
    summary,
    removedMessages: compactable.length - 1,
    strategy,
    keepLastMessages: normalizedKeepLast
  };
}

export function estimateTokens(messages) {
  const chars = messages.reduce((total, message) => total + messageToText(message).length, 0);
  return Math.ceil(chars / 4);
}

function splitMessages(messages, keepLastMessages) {
  const firstSystem = messages[0]?.role === "system" ? [messages[0]] : [];
  const bodyStart = firstSystem.length;
  const tailStart = resolveTailStart(messages, keepLastMessages, bodyStart);
  return {
    head: firstSystem,
    compactable: messages.slice(bodyStart, tailStart),
    tail: messages.slice(tailStart)
  };
}

/**
 * Resolve the index where the kept "tail" begins.
 *
 * The naive boundary `messages.length - keepLast` can land *between* an
 * assistant `tool_use` message and its `tool_result`: the assistant half is
 * swept into the summarized/truncated region while the orphaned tool result
 * survives in the kept tail. On the next request the provider then emits a
 * `function_call_output` (OpenAI Responses) / `role:"tool"` message (Chat
 * Completions) with no preceding tool call, and the upstream rejects the
 * whole request with 400 "No tool call found for function call output with
 * call_id <id>".
 *
 * Walking the boundary backwards over any leading tool-result messages pulls
 * the originating assistant message back into the tail, keeping every
 * tool_use/tool_result pair together. `bodyStart` (the index just past a
 * leading system message) is the floor — we never reach into `head`.
 *
 * Exported so the session-level merge (agent/conversation.mjs) derives the
 * identical boundary; the two must agree or the summary body and the kept
 * tail would describe overlapping or disjoint message ranges.
 */
export function resolveTailStart(messages, keepLastMessages, bodyStart = 0) {
  let tailStart = Math.max(bodyStart, messages.length - keepLastMessages);
  while (tailStart > bodyStart && messages[tailStart]?.role === "tool") {
    tailStart -= 1;
  }
  return tailStart;
}

function buildContextSummary(messages, now) {
  const users = messages.filter((message) => message.role === "user").map(messageToText).filter(Boolean).slice(-8);
  const assistants = messages.filter((message) => message.role === "assistant").map(messageToText).filter(Boolean).slice(-8);
  const toolCalls = messages.flatMap(extractToolCallNames);
  const toolResults = messages.filter((message) => message.role === "tool").map(messageToText).filter(Boolean).slice(-8);
  const paths = extractPaths(messages).slice(0, 20);
  const lines = [
    "【コンパクトサマリー】",
    `作成日時: ${now.toISOString()}`,
    `圧縮対象メッセージ数: ${messages.length}`,
    users.length ? `ユーザー要求: ${users.map(shorten).join(" / ")}` : null,
    assistants.length ? `アシスタント応答: ${assistants.map(shorten).join(" / ")}` : null,
    toolCalls.length ? `ツール呼び出し: ${[...new Set(toolCalls)].join(", ")}` : null,
    toolResults.length ? `ツール結果: ${toolResults.map(shorten).join(" / ")}` : null,
    paths.length ? `関連パス: ${paths.join(", ")}` : null
  ].filter(Boolean);
  return `${lines.join("\n")}\n`;
}

function buildAggressiveSummary(messages, now) {
  const paths = extractPaths(messages).slice(0, 12);
  const latestUser = [...messages].reverse().find((message) => message.role === "user");
  const toolCalls = [...new Set(messages.flatMap(extractToolCallNames))].slice(0, 12);
  return [
    "【コンパクトサマリー】",
    `作成日時: ${now.toISOString()}`,
    `圧縮対象メッセージ数: ${messages.length}`,
    latestUser ? `最新の主要要求: ${shorten(messageToText(latestUser), 500)}` : null,
    toolCalls.length ? `使用ツール: ${toolCalls.join(", ")}` : null,
    paths.length ? `関連パス: ${paths.join(", ")}` : null
  ].filter(Boolean).join("\n") + "\n";
}

function extractToolCallNames(message) {
  return (message.tool_calls ?? [])
    .map((toolCall) => toolCall.function?.name ?? toolCall.name)
    .filter(Boolean);
}

function extractPaths(messages) {
  const text = messages.map(messageToText).join("\n");
  return [...new Set(text.match(/[A-Za-z]:\\[^\s"'`<>|]+|(?:\.{1,2}\/)?[\w.-]+(?:\/[\w.-]+)+/g) ?? [])];
}

function messageToText(message) {
  if (typeof message.content === "string") return message.content;
  if (message.content == null && message.tool_calls) return JSON.stringify(message.tool_calls);
  return JSON.stringify(message.content ?? "");
}

function shorten(value, max = 240) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3)}...`;
}
