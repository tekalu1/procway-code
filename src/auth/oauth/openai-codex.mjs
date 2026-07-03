// Vendored from @earendil-works/pi-ai (packages/ai/src/utils/oauth/openai-codex.ts).
// See LICENSE.md in this directory.
//
// Differences from upstream:
//   - Converted to ESM (.mjs), JSDoc instead of TS.
//   - Default originator is "procway" (upstream defaults to "pi").
//   - Removed deferred dynamic imports for node:crypto / node:http; we only ever
//     run in Node, so static imports are simpler and correct.

import { randomBytes } from "node:crypto";
import http from "node:http";
import { generatePKCE } from "./pkce.mjs";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.mjs";

const CALLBACK_HOST = process.env.PROCWAY_OAUTH_CALLBACK_HOST || "127.0.0.1";
const CALLBACK_PORT = 1455;
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/auth/callback`;
const SCOPE = "openid profile email offline_access";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const DEFAULT_ORIGINATOR = "procway";

function createState() {
  return randomBytes(16).toString("hex");
}

function parseAuthorizationInput(input) {
  const value = input.trim();
  if (!value) return {};

  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined
    };
  } catch {
    // not a URL
  }

  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }

  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined
    };
  }

  return { code: value };
}

function decodeJwt(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1] ?? "";
    const decoded = Buffer.from(payload, "base64url").toString("utf8");
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function getAccountId(accessToken) {
  const payload = decodeJwt(accessToken);
  const auth = payload?.[JWT_CLAIM_PATH];
  const accountId = auth?.chatgpt_account_id;
  return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}

async function exchangeAuthorizationCode(code, verifier, redirectUri = REDIRECT_URI) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri
    })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      type: "failed",
      status: response.status,
      message: `OpenAI Codex token exchange failed (${response.status}): ${text || response.statusText}`
    };
  }

  const json = await response.json();
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    return {
      type: "failed",
      message: `OpenAI Codex token exchange response missing fields: ${JSON.stringify(json)}`
    };
  }

  return {
    type: "success",
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000
  };
}

async function refreshAccessToken(refreshToken) {
  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID
      })
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        type: "failed",
        status: response.status,
        message: `OpenAI Codex token refresh failed (${response.status}): ${text || response.statusText}`
      };
    }

    const json = await response.json();
    if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
      return {
        type: "failed",
        message: `OpenAI Codex token refresh response missing fields: ${JSON.stringify(json)}`
      };
    }

    return {
      type: "success",
      access: json.access_token,
      refresh: json.refresh_token,
      expires: Date.now() + json.expires_in * 1000
    };
  } catch (error) {
    return {
      type: "failed",
      message: `OpenAI Codex token refresh error: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

async function createAuthorizationFlow(originator) {
  const { verifier, challenge } = await generatePKCE();
  const state = createState();

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", originator);

  return { verifier, state, url: url.toString() };
}

function startLocalOAuthServer(state) {
  let settleWait;
  const waitForCodePromise = new Promise((resolve) => {
    let settled = false;
    settleWait = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
  });

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || "", "http://localhost");
      if (url.pathname !== "/auth/callback") {
        res.statusCode = 404;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(oauthErrorHtml("Callback route not found."));
        return;
      }
      if (url.searchParams.get("state") !== state) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(oauthErrorHtml("State mismatch."));
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(oauthErrorHtml("Missing authorization code."));
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(oauthSuccessHtml("OpenAI authentication completed. You can close this window."));
      settleWait?.({ code });
    } catch {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(oauthErrorHtml("Internal error while processing OAuth callback."));
    }
  });

  const closeServer = () => {
    // Browsers hold the response socket open via keep-alive after the success
    // page renders. Without closing those sockets the Node event loop stays
    // pinned and our CLI never exits. `closeAllConnections` is available on
    // Node 18.2+ (we require Node 20+).
    try { server.closeAllConnections?.(); } catch { /* ignore */ }
    try { server.close(); } catch { /* ignore */ }
  };

  return new Promise((resolve) => {
    server
      .listen(CALLBACK_PORT, CALLBACK_HOST, () => {
        resolve({
          close: closeServer,
          cancelWait: () => settleWait?.(null),
          waitForCode: () => waitForCodePromise,
          started: true
        });
      })
      .on("error", () => {
        // Port already in use or otherwise unbindable — fall back to manual entry.
        settleWait?.(null);
        resolve({
          close: closeServer,
          cancelWait: () => {},
          waitForCode: async () => null,
          started: false
        });
      });
  });
}

/**
 * Run the OpenAI Codex (ChatGPT) OAuth login flow.
 *
 * @param {object} options
 * @param {(info: { url: string; instructions?: string }) => void} options.onAuth
 *   Called with the authorize URL once it is ready. Caller is responsible for
 *   opening the URL in a browser (or showing it for the user to paste).
 * @param {(prompt: { message: string }) => Promise<string>} options.onPrompt
 *   Fallback to prompt the user when the local callback is unavailable or
 *   times out. Should resolve to the pasted authorization code or redirect URL.
 * @param {(message: string) => void} [options.onProgress]
 * @param {() => Promise<string>} [options.onManualCodeInput]
 *   Optional concurrent promise that resolves with a user-pasted code while
 *   the browser flow is also running. Whichever resolves first wins.
 * @param {string} [options.originator] - OAuth `originator` query parameter.
 *   Defaults to "procway".
 * @returns {Promise<{ access: string; refresh: string; expires: number; accountId: string }>}
 */
export async function loginOpenAICodex(options) {
  const originator = options.originator ?? DEFAULT_ORIGINATOR;
  const { verifier, state, url } = await createAuthorizationFlow(originator);
  const server = await startLocalOAuthServer(state);

  options.onAuth({
    url,
    instructions: server.started
      ? "A browser window should open. Complete login to finish."
      : `Local callback port ${CALLBACK_PORT} was unavailable. Open the URL manually, then paste the redirect URL back here.`
  });

  let code;
  try {
    if (options.onManualCodeInput) {
      let manualCode;
      let manualError;
      const manualPromise = options
        .onManualCodeInput()
        .then((input) => {
          manualCode = input;
          server.cancelWait();
        })
        .catch((err) => {
          manualError = err instanceof Error ? err : new Error(String(err));
          server.cancelWait();
        });

      const result = await server.waitForCode();

      if (manualError) throw manualError;

      if (result?.code) {
        code = result.code;
      } else if (manualCode) {
        const parsed = parseAuthorizationInput(manualCode);
        if (parsed.state && parsed.state !== state) throw new Error("State mismatch");
        code = parsed.code;
      }

      if (!code) {
        await manualPromise;
        if (manualError) throw manualError;
        if (manualCode) {
          const parsed = parseAuthorizationInput(manualCode);
          if (parsed.state && parsed.state !== state) throw new Error("State mismatch");
          code = parsed.code;
        }
      }
    } else {
      const result = await server.waitForCode();
      if (result?.code) code = result.code;
    }

    if (!code) {
      const input = await options.onPrompt({
        message: "Paste the authorization code (or full redirect URL):"
      });
      const parsed = parseAuthorizationInput(input);
      if (parsed.state && parsed.state !== state) throw new Error("State mismatch");
      code = parsed.code;
    }

    if (!code) throw new Error("Missing authorization code");

    const tokenResult = await exchangeAuthorizationCode(code, verifier);
    if (tokenResult.type !== "success") throw new Error(tokenResult.message);

    const accountId = getAccountId(tokenResult.access);
    if (!accountId) throw new Error("Failed to extract accountId from token");

    return {
      access: tokenResult.access,
      refresh: tokenResult.refresh,
      expires: tokenResult.expires,
      accountId
    };
  } finally {
    server.close();
  }
}

/**
 * Refresh an OpenAI Codex OAuth token. Returns a fresh credential bundle —
 * the upstream rotates `refresh_token` on every refresh, so callers MUST
 * persist the new value or the next refresh will fail.
 *
 * @param {string} refreshToken
 * @returns {Promise<{ access: string; refresh: string; expires: number; accountId: string }>}
 */
export async function refreshOpenAICodexToken(refreshToken) {
  const result = await refreshAccessToken(refreshToken);
  if (result.type !== "success") throw new Error(result.message);

  const accountId = getAccountId(result.access);
  if (!accountId) throw new Error("Failed to extract accountId from token");

  return {
    access: result.access,
    refresh: result.refresh,
    expires: result.expires,
    accountId
  };
}

/**
 * Generate the authorize URL + PKCE state for a manual (UI-driven) flow.
 * Unlike `loginOpenAICodex`, this does NOT start a local callback server —
 * the caller is responsible for capturing the redirect URL (typically via
 * a paste-back UI) and handing it to `exchangeCodexAuthorizationCode`.
 *
 * @param {{ originator?: string }} [options]
 * @returns {Promise<{ verifier: string; state: string; url: string }>}
 */
export function createCodexAuthorizationFlow(options = {}) {
  return createAuthorizationFlow(options.originator ?? DEFAULT_ORIGINATOR);
}

/**
 * Complete a manual flow: exchange an authorization code (typically pasted
 * by the user) for a credential bundle. Throws on state mismatch / missing
 * fields / network failures.
 *
 * @param {{ code: string; verifier: string; expectedState?: string; receivedState?: string }} params
 * @returns {Promise<{ access: string; refresh: string; expires: number; accountId: string }>}
 */
export async function exchangeCodexAuthorizationCode({ code, verifier, expectedState, receivedState }) {
  if (expectedState !== undefined && receivedState !== undefined && expectedState !== receivedState) {
    throw new Error("State mismatch");
  }
  if (typeof code !== "string" || code.length === 0) throw new Error("Missing authorization code");
  if (typeof verifier !== "string" || verifier.length === 0) throw new Error("Missing PKCE verifier");

  const result = await exchangeAuthorizationCode(code, verifier);
  if (result.type !== "success") throw new Error(result.message);

  const accountId = getAccountId(result.access);
  if (!accountId) throw new Error("Failed to extract accountId from token");

  return {
    access: result.access,
    refresh: result.refresh,
    expires: result.expires,
    accountId
  };
}

/**
 * Extract `code` and `state` from a redirect URL or query string the user
 * pasted back from the OAuth flow. Re-exported so the dashboard can
 * normalize input the same way the CLI does.
 *
 * @param {string} input
 * @returns {{ code?: string; state?: string }}
 */
export function parseCodexRedirect(input) {
  return parseAuthorizationInput(input);
}

export const OPENAI_CODEX_OAUTH_CONSTANTS = Object.freeze({
  CLIENT_ID,
  AUTHORIZE_URL,
  TOKEN_URL,
  REDIRECT_URI,
  CALLBACK_HOST,
  CALLBACK_PORT,
  SCOPE,
  DEFAULT_ORIGINATOR,
  JWT_CLAIM_PATH
});
