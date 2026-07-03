// Egress-proxy awareness for the agent's network tools (WebSearch/WebFetch +
// jira/confluence callApi). Node's built-in fetch ignores HTTP(S)_PROXY, so
// inside the session Pod (NetworkPolicy deny-by-default + squid egress proxy)
// every direct fetch died with ECONNREFUSED. getProxyAwareFetch() returns the
// identity (globalThis.fetch) without proxy env, and an undici
// EnvHttpProxyAgent-dispatched fetch with it.
import { afterEach, describe, expect, it } from "vitest";
import { getProxyAwareFetch, _resetProxyAgentForTest } from "../src/safety/proxy-fetch.mjs";

describe("getProxyAwareFetch", () => {
  afterEach(() => _resetProxyAgentForTest());

  it("returns globalThis.fetch unchanged when no proxy env is present", () => {
    const f = getProxyAwareFetch({});
    expect(f).toBe(globalThis.fetch);
  });

  it("returns a wrapped fetch when HTTPS_PROXY is set", () => {
    const f = getProxyAwareFetch({ HTTPS_PROXY: "http://egress-proxy:3128" });
    expect(typeof f).toBe("function");
    expect(f).not.toBe(globalThis.fetch);
  });

  it("honors the lowercase http_proxy form too", () => {
    const f = getProxyAwareFetch({ http_proxy: "http://egress-proxy:3128" });
    expect(f).not.toBe(globalThis.fetch);
  });
});
