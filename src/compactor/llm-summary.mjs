import { compactMessages } from "../session/compactor.mjs";

const SUMMARIZER_PROMPT = `You are a context compactor. Given a conversation slice, produce a faithful summary in <= 1500 characters that preserves: user intent, file paths touched, tool calls invoked, decisions taken, errors encountered. Do not invent facts. Do not include greetings. Output plain text only.`;

const FALLBACK_STRATEGY = "summarize-context";

/**
 * LLM-based compactor strategy. Replaces the compactable middle slice with a
 * model-generated summary. Falls back to the deterministic
 * `summarize-context` strategy when the provider rejects the request, the
 * response is empty, or no `runProviderImpl` is supplied.
 *
 * @param {{
 *   messages: Array<object>,
 *   keepLastMessages: number,
 *   strategy: "llm-summary",
 *   runProviderImpl?: Function,
 *   settings?: object,
 *   cwd?: string,
 *   now?: Date,
 *   dropToolResults?: boolean,
 *   fallbackStrategy?: string
 * }} input
 */
export async function compactMessagesLlm({
  messages,
  keepLastMessages = 10,
  runProviderImpl,
  settings = {},
  cwd = process.cwd(),
  now = new Date(),
  dropToolResults = false,
  fallbackStrategy = FALLBACK_STRATEGY
}) {
  // Build the deterministic fallback result, tagging it so callers can tell a
  // summary was produced without the model (and why). `fallbackStrategy` is the
  // strategy that actually ran, which the UI surfaces alongside the requested
  // "llm-summary".
  const fallback = (reason) => {
    const deterministic = compactMessages({
      messages,
      keepLastMessages,
      strategy: fallbackStrategy,
      dropToolResults,
      now
    });
    return {
      ...deterministic,
      strategy: "llm-summary",
      llmFallback: true,
      fallbackStrategy: deterministic.strategy,
      fallbackReason: reason
    };
  };

  if (typeof runProviderImpl !== "function") {
    return fallback("no-provider");
  }

  const firstSystemCount = messages[0]?.role === "system" ? 1 : 0;
  const tailStart = Math.max(firstSystemCount, messages.length - Math.max(1, keepLastMessages));
  const compactable = messages.slice(firstSystemCount, tailStart);
  if (compactable.length === 0) {
    return { compacted: false, messages, summary: "", removedMessages: 0, strategy: "llm-summary", keepLastMessages, llmFallback: false };
  }

  // Orthogonal toggle: keep verbose tool output out of the slice handed to the
  // summarizer (a token-cost lever). Tool call *names* still survive via the
  // assistant messages that scheduled them.
  const summarizable = dropToolResults
    ? compactable.filter((message) => message.role !== "tool")
    : compactable;
  const transcript = renderForSummary(summarizable);
  const summarizerMessages = [
    { role: "system", content: SUMMARIZER_PROMPT },
    { role: "user", content: `Compact the following conversation:\n\n${transcript}` }
  ];
  let summaryText;
  try {
    const response = await runProviderImpl({
      settings,
      messages: summarizerMessages,
      tools: [],
      cwd,
      stream: false
    });
    summaryText = extractSummaryText(response);
  } catch (error) {
    return fallback(error?.message ?? "provider-error");
  }

  if (typeof summaryText !== "string" || summaryText.trim().length === 0) {
    return fallback("empty-summary");
  }

  const head = messages.slice(0, firstSystemCount);
  const tail = messages.slice(tailStart);
  const summaryEntry = {
    role: "system",
    content: summaryText.trim(),
    compacted: true,
    compactedAt: now.toISOString(),
    compactStrategy: "llm-summary",
    originalMessageCount: compactable.length
  };
  return {
    compacted: true,
    messages: [...head, summaryEntry, ...tail],
    summary: summaryText.trim(),
    removedMessages: compactable.length - 1,
    strategy: "llm-summary",
    keepLastMessages,
    llmFallback: false
  };
}

function renderForSummary(messages) {
  return messages.map((message, index) => {
    const role = message.role ?? "user";
    const text = typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content.map((b) => b?.text ?? JSON.stringify(b)).join("")
        : JSON.stringify(message.content ?? "");
    return `[${index}] ${role}: ${text}`;
  }).join("\n\n");
}

function extractSummaryText(response) {
  if (!response) return "";
  if (typeof response === "string") return response;
  if (typeof response.text === "string") return response.text;
  const message = response.message;
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    return message.content
      .map((block) => (block?.kind === "text" || typeof block?.text === "string") ? block.text ?? "" : "")
      .join("");
  }
  return "";
}
