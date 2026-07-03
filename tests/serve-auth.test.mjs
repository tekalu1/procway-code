import { describe, expect, it } from "vitest";
import { compareTokens, extractTokenFromUrl, readAuthToken } from "../src/adapters/serve/auth.mjs";

describe("serve auth", () => {
  it("compareTokens rejects empty / mismatched / non-string inputs", () => {
    expect(compareTokens("", "")).toBe(false);
    expect(compareTokens("abc", "")).toBe(false);
    expect(compareTokens("abc", "ab")).toBe(false);
    expect(compareTokens("abc", "xyz")).toBe(false);
    expect(compareTokens(undefined, "abc")).toBe(false);
    expect(compareTokens(123, "abc")).toBe(false);
  });

  it("compareTokens accepts identical strings via constant-time compare", () => {
    expect(compareTokens("hunter2", "hunter2")).toBe(true);
    expect(compareTokens("a-very-long-token-with-symbols!@#", "a-very-long-token-with-symbols!@#")).toBe(true);
  });

  it("extractTokenFromUrl pulls token from the query string", () => {
    expect(extractTokenFromUrl("/ws?token=abc")).toBe("abc");
    expect(extractTokenFromUrl("/ws?token=a%20b")).toBe("a b");
    expect(extractTokenFromUrl("/ws")).toBeNull();
    expect(extractTokenFromUrl("/ws?token=")).toBeNull();
    expect(extractTokenFromUrl("")).toBeNull();
    expect(extractTokenFromUrl(undefined)).toBeNull();
  });

  it("readAuthToken returns trimmed token or null", () => {
    expect(readAuthToken({ env: { PROCWAY_SERVE_TOKEN: "  hunter2  " } })).toBe("hunter2");
    expect(readAuthToken({ env: { PROCWAY_SERVE_TOKEN: "" } })).toBeNull();
    expect(readAuthToken({ env: {} })).toBeNull();
    expect(readAuthToken({ env: { CUSTOM: "abc" }, varName: "CUSTOM" })).toBe("abc");
  });
});
