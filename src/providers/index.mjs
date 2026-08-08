import { runCliAgentProvider } from "./cli-agent.mjs";
import { runOpenAiCompatibleProvider } from "./openai-compatible.mjs";
import { runOpenAiCodexProvider } from "./openai-codex.mjs";
import { runAnthropicProvider } from "./anthropic.mjs";
import { messageContentToText } from "../core/types/message.mjs";
import { hydrateImageRefs } from "./image-hydration.mjs";
import { delegateImageRefsForTextOnly } from "./image-delegation.mjs";
import { providerSupportsVision } from "./vision.mjs";

export { listModels, ListModelsError } from "./list-models.mjs";

/** Cumulative image-payload cap for the openai-codex provider (raw bytes,
 *  before base64). Keeps the most recent screenshots within a bound the
 *  ChatGPT codex backend answers promptly; older images degrade to a text
 *  note. ~512 KB ≈ the few-images range observed working before requests
 *  ballooned and hung. Override via settings.attachments.codexMaxTotalImageBytes. */
const DEFAULT_CODEX_MAX_TOTAL_IMAGE_BYTES = 512 * 1024;

/**
 * Phase 4: returns one of two shapes — a fully-resolved response
 * `{ message, toolCalls, usage }` or a streaming response
 * `{ deltaStream, finalize }` whose `finalize()` returns the same fully
 * resolved shape after the stream completes. Streaming may be disabled by
 * passing `stream: false` (used e.g. by cli-agent and tests).
 */
export async function runProvider({ settings, prompt, messages, tools, cwd = process.cwd(), stream = true, signal }) {
  const providerId = settings.defaultProvider;
  const provider = settings.providers?.[providerId];
  if (!provider) {
    throw new Error(`Provider not found: ${providerId}`);
  }
  if (provider.type === "cli-agent") {
    // cli-agent flattens to plain text and shells out to an external CLI —
    // it can't accept inline images, so attachments are intentionally dropped
    // here (image input is out of scope for this provider type).
    return runCliAgentProvider({
      provider,
      prompt: prompt ?? flattenMessagesForCli(messages),
      cwd,
      timeoutMs: settings.agents?.defaultTimeoutMs,
      signal
    });
  }
  // Vision-capable providers: resolve any image `file_ref` blocks to inline
  // base64 just before the request is built. This is the single egress point
  // for attachment bytes (see image-hydration.mjs).
  //
  // The ChatGPT `codex` backend buffers the entire multimodal request before
  // it streams a response, so an agentic loop that accumulates many
  // screenshots (e.g. acceptance checks) balloons every round's request and
  // hangs until the headers timeout fires — then retries forever, pegging CPU.
  // Bound codex's cumulative image payload to the most recent images; other
  // providers keep the prior unbounded behavior. Tunable; default is sized to
  // the few-images range that was observed working.
  const codexImageBudget = provider.type === "openai-codex"
    ? (settings.attachments?.codexMaxTotalImageBytes ?? DEFAULT_CODEX_MAX_TOTAL_IMAGE_BYTES)
    : undefined;
  // Text-only main providers (supportsVision: false) must never receive an
  // image part — image-delegation substitutes vision-model descriptions /
  // ask_image pointer notes instead, so the request can't 400 on images.
  const hydratedMessages = providerSupportsVision(provider)
    ? await hydrateImageRefs(messages, {
        cwd,
        maxBytes: settings.attachments?.maxImageBytes,
        maxTotalBytes: codexImageBudget
      })
    : await delegateImageRefsForTextOnly(messages, {
        settings,
        runProviderImpl: runProvider,
        cwd,
        signal,
        maxBytes: settings.attachments?.maxImageBytes
      });
  // `*-via-proxy` types reuse the same wire format as their base provider; only
  // baseUrl (the dashboard credential broker) + credential handling differ
  // (ADR 0008 §F7c — the proxy injects the real credential upstream).
  if (provider.type === "openai-compatible" || provider.type === "openai" || provider.type === "openai-via-proxy") {
    return runOpenAiCompatibleProvider({
      provider,
      model: provider.defaultModel,
      prompt,
      messages: hydratedMessages,
      tools,
      stream,
      // Without this the user's Stop reached the orchestrator but never the
      // socket: the model kept streaming (and billing) to a turn nobody was
      // listening to any more.
      signal
    });
  }
  if (provider.type === "openai-codex" || provider.type === "openai-codex-via-proxy") {
    return runOpenAiCodexProvider({
      provider,
      model: provider.defaultModel,
      prompt,
      messages: hydratedMessages,
      tools,
      stream,
      signal
    });
  }
  // `anthropic-via-proxy` reuses the Anthropic wire format unchanged; only its
  // baseUrl (the dashboard credential broker) and credential handling differ.
  // See ADR 0008 §F7c — the proxy injects the real credential upstream, so the
  // session sends no API key of its own.
  if (provider.type === "anthropic" || provider.type === "anthropic-compatible" || provider.type === "anthropic-via-proxy") {
    return runAnthropicProvider({
      provider,
      model: provider.defaultModel,
      prompt,
      messages: hydratedMessages,
      tools,
      stream,
      signal
    });
  }
  throw new Error(`Provider type is configured but not implemented yet: ${provider.type}`);
}

function flattenMessagesForCli(messages = []) {
  return messages
    .map((message) => `${message.role}: ${flattenContent(message)}`)
    .join("\n\n");
}

function flattenContent(message) {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    const text = messageContentToText(message);
    if (text) return text;
    return JSON.stringify(message.content);
  }
  return JSON.stringify(message.content ?? "");
}
