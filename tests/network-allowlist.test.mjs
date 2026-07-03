import { describe, expect, it } from "vitest";
import { evaluateHost, evaluateUrl, loadAllowlistFromEnv, parseAllowlist } from "../src/safety/network-allowlist.mjs";
import { createSafeFetch } from "../src/safety/safe-fetch.mjs";

describe("network-allowlist", () => {
  it("returns null when env is unset or empty", () => {
    expect(parseAllowlist(undefined)).toBeNull();
    expect(parseAllowlist("")).toBeNull();
    expect(parseAllowlist(",")).toBeNull();
    expect(loadAllowlistFromEnv({})).toBeNull();
  });

  it("trims and lowercases entries", () => {
    expect(parseAllowlist(" Api.Openai.Com ,  anthropic.com ")).toEqual(["api.openai.com", "anthropic.com"]);
  });

  it("evaluateHost returns allow when allowlist is empty", () => {
    expect(evaluateHost("anywhere.example.com", null)).toEqual(expect.objectContaining({ decision: "allow" }));
    expect(evaluateHost("anywhere.example.com", [])).toEqual(expect.objectContaining({ decision: "allow" }));
  });

  it("matches exact host and subdomain suffix", () => {
    const list = ["api.openai.com", "anthropic.com"];
    expect(evaluateHost("api.openai.com", list).decision).toBe("allow");
    expect(evaluateHost("eu.anthropic.com", list).decision).toBe("allow");
    expect(evaluateHost("evil.com", list).decision).toBe("ask");
  });

  it("returns ask when URL is invalid or host is missing", () => {
    expect(evaluateUrl("not-a-url", ["openai.com"])).toEqual(expect.objectContaining({ decision: "ask" }));
    expect(evaluateUrl("https://api.openai.com/v1/chat", ["openai.com"]).decision).toBe("allow");
  });
});

describe("safe-fetch", () => {
  it("passes through when allowlist is empty", async () => {
    const calls = [];
    const wrapped = createSafeFetch({
      env: {},
      fetchImpl: async (url) => { calls.push(url); return new Response(""); }
    });
    await wrapped("https://anywhere.example.com");
    expect(calls).toEqual(["https://anywhere.example.com"]);
  });

  it("invokes the approver and forwards on allow", async () => {
    const requests = [];
    const wrapped = createSafeFetch({
      env: { PROCWAY_NET_ALLOW: "openai.com" },
      fetchImpl: async () => new Response("ok"),
      approvalRequester: async (request) => { requests.push(request); return true; }
    });
    const response = await wrapped("https://attack.example.com/v1");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual(expect.objectContaining({ kind: "network", summary: "attack.example.com" }));
    await response.text();
  });

  it("throws NET_ALLOWLIST_DENIED when the approver rejects", async () => {
    const wrapped = createSafeFetch({
      env: { PROCWAY_NET_ALLOW: "openai.com" },
      fetchImpl: async () => new Response("should not be reached"),
      approvalRequester: async () => false
    });
    await expect(wrapped("https://other.example.com")).rejects.toThrow(/network egress denied/);
  });
});
