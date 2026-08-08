/**
 * Turn errors, rendered as something a user can act on (P3b-10).
 *
 * The old `printTurnError` printed one uncoloured line:
 *
 *   Turn failed: Missing API key environment variable: OPENROUTER_API_KEY
 *
 * — true, but it never said what to DO. `classifyTurnError` maps the common
 * failures (missing key, auth, rate limit, network, idle watchdog, tool-round
 * cap, user interrupt) to a short title plus concrete next steps; anything
 * unrecognised still prints its message, with the retry hint when the provider
 * marked the error retryable.
 */

import { renderPanel } from "./panel.mjs";

/**
 * @param {any} error
 * @returns {{ kind: string, title: string, detail: string, hints: string[] }}
 */
export function classifyTurnError(error) {
  const message = String(error?.message ?? error ?? "");
  const status = Number(error?.status);
  const code = String(error?.code ?? "");

  const missingKey = /Missing API key environment variable:\s*(\S+)/.exec(message);
  if (missingKey) {
    const envName = missingKey[1];
    return {
      kind: "missing-api-key",
      title: "No API key configured",
      detail: `The active provider needs ${envName}, which is not set.`,
      hints: [
        "/config setup — set the provider, endpoint, model and token interactively",
        `procway-code config set-secret ${envName} — store the key without the wizard`,
        `export ${envName}=… — one-off, for this shell only`
      ]
    };
  }

  if (code === "idle_timeout") {
    return {
      kind: "idle-timeout",
      title: "The model went silent",
      detail: message,
      hints: [
        "Retry: long reasoning turns sometimes stall on the provider side",
        "PROCWAY_TURN_IDLE_TIMEOUT_MS=<ms> raises the watchdog (0 disables it)"
      ]
    };
  }

  if (code === "interrupted") {
    return { kind: "interrupted", title: "Interrupted", detail: message, hints: [] };
  }

  if (status === 401 || status === 403 || /unauthorized|invalid[_ ]api[_ ]key|authentication/i.test(message)) {
    return {
      kind: "auth",
      title: "The provider rejected the credentials",
      detail: message,
      hints: [
        "/config setup — re-enter the API token for this provider",
        "procway-code auth login <provider> — for OAuth-based providers",
        "/status — check which provider:model the session is using"
      ]
    };
  }

  if (status === 429 || /rate[ _-]?limit|too many requests|quota/i.test(message)) {
    return {
      kind: "rate-limit",
      title: "Rate limited by the provider",
      detail: message,
      hints: [
        "Wait a few seconds and send the prompt again",
        "/config setup — switch to another provider or a smaller model",
        "/compact — a shorter context costs fewer tokens per round"
      ]
    };
  }

  if (
    /ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|UND_ERR|fetch failed|network|socket hang up/i.test(`${message} ${code}`)
  ) {
    return {
      kind: "network",
      title: "Could not reach the provider",
      detail: message,
      hints: [
        "Check the network connection and any HTTPS_PROXY / HTTP_PROXY setting",
        "/status — confirm the endpoint the active provider points at",
        "Retry once the connection is back; nothing was lost from the session"
      ]
    };
  }

  if (status >= 500 && status < 600) {
    return {
      kind: "provider-error",
      title: `The provider returned ${status}`,
      detail: message,
      hints: ["Retry shortly — server-side errors are usually transient", "/config setup — switch providers if it persists"]
    };
  }

  return {
    kind: "unknown",
    title: status ? `Turn failed (${status})` : "Turn failed",
    detail: message || String(error),
    hints: error?.retryable ? ["Retry, or switch models/providers with /config setup"] : []
  };
}

/**
 * @param {any} error
 * @param {{ width?: number, color?: boolean }} options
 */
export function renderTurnError(error, { width = 80, color = true } = {}) {
  const { title, detail, hints } = classifyTurnError(error);
  return renderPanel({
    title,
    rows: detail ? [["reason", detail, "danger"]] : [],
    notes: hints.length > 0 ? ["Try:", ...hints.map((hint) => `  ${hint}`)] : [],
    width,
    color
  });
}
