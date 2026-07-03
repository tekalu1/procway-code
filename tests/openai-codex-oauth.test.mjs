import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCodexAuthorizationFlow,
  exchangeCodexAuthorizationCode,
  parseCodexRedirect,
  OPENAI_CODEX_OAUTH_CONSTANTS
} from "../src/auth/oauth/openai-codex.mjs";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function jwtFromPayload(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = "x";
  return `${header}.${body}.${signature}`;
}

describe("parseCodexRedirect", () => {
  it("extracts code + state from a full redirect URL", () => {
    const out = parseCodexRedirect("http://localhost:1455/auth/callback?code=abc&state=xyz");
    expect(out).toEqual({ code: "abc", state: "xyz" });
  });

  it("treats a bare token as a code", () => {
    expect(parseCodexRedirect("abc-123")).toEqual({ code: "abc-123" });
  });

  it("parses code#state legacy form", () => {
    expect(parseCodexRedirect("abc#xyz")).toEqual({ code: "abc", state: "xyz" });
  });

  it("returns empty for an empty input", () => {
    expect(parseCodexRedirect("")).toEqual({});
  });

  it("handles a raw query-string body", () => {
    expect(parseCodexRedirect("code=q&state=s")).toEqual({ code: "q", state: "s" });
  });
});

describe("createCodexAuthorizationFlow", () => {
  it("returns verifier/state and an authorize URL with PKCE params and the requested originator", async () => {
    const { verifier, state, url } = await createCodexAuthorizationFlow({ originator: "test-agent" });
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(state).toMatch(/^[0-9a-f]{32}$/);

    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(OPENAI_CODEX_OAUTH_CONSTANTS.AUTHORIZE_URL);
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("client_id")).toBe(OPENAI_CODEX_OAUTH_CONSTANTS.CLIENT_ID);
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(parsed.searchParams.get("state")).toBe(state);
    expect(parsed.searchParams.get("originator")).toBe("test-agent");
    expect(parsed.searchParams.get("scope")).toContain("offline_access");
  });

  it("defaults the originator to 'procway'", async () => {
    const { url } = await createCodexAuthorizationFlow();
    expect(new URL(url).searchParams.get("originator")).toBe("procway");
  });
});

describe("exchangeCodexAuthorizationCode", () => {
  it("rejects on state mismatch before contacting the network", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    await expect(
      exchangeCodexAuthorizationCode({ code: "c", verifier: "v", expectedState: "A", receivedState: "B" })
    ).rejects.toThrow(/State mismatch/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects when code or verifier is missing", async () => {
    await expect(exchangeCodexAuthorizationCode({ code: "", verifier: "v" })).rejects.toThrow(/Missing authorization code/);
    await expect(exchangeCodexAuthorizationCode({ code: "c", verifier: "" })).rejects.toThrow(/Missing PKCE verifier/);
  });

  it("returns credentials with accountId extracted from the JWT on success", async () => {
    const access = jwtFromPayload({
      [OPENAI_CODEX_OAUTH_CONSTANTS.JWT_CLAIM_PATH]: { chatgpt_account_id: "acct-fixture" }
    });
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ access_token: access, refresh_token: "ref", expires_in: 3600 }),
      text: async () => ""
    }));
    const credentials = await exchangeCodexAuthorizationCode({ code: "c", verifier: "v" });
    expect(credentials.access).toBe(access);
    expect(credentials.refresh).toBe("ref");
    expect(credentials.accountId).toBe("acct-fixture");
    expect(credentials.expires).toBeGreaterThan(Date.now());
  });

  it("propagates non-2xx token-endpoint errors", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: async () => "{\"error\":\"invalid_grant\"}",
      json: async () => ({ error: "invalid_grant" })
    }));
    await expect(
      exchangeCodexAuthorizationCode({ code: "c", verifier: "v" })
    ).rejects.toThrow(/token exchange failed \(400\)/);
  });

  it("throws when the JWT carries no chatgpt_account_id", async () => {
    const access = jwtFromPayload({ some_other_claim: 1 });
    globalThis.fetch = vi.fn(async () => ({
      ok: true, status: 200, statusText: "OK",
      json: async () => ({ access_token: access, refresh_token: "ref", expires_in: 3600 }),
      text: async () => ""
    }));
    await expect(
      exchangeCodexAuthorizationCode({ code: "c", verifier: "v" })
    ).rejects.toThrow(/accountId/);
  });
});
