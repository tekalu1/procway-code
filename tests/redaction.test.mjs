import { describe, expect, it } from "vitest";
import { DEFAULT_REDACTION_PATTERNS, combinePatterns, redact, redactEvent } from "../src/session/redaction.mjs";

describe("redaction", () => {
  it("masks AWS access keys, OpenAI keys, GitHub tokens, and Bearer headers in strings", () => {
    const text = [
      "AWS=AKIAABCDEFGHIJKLMNOP",
      "openai sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF",
      "openrouter sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789abcdef",
      "github ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD",
      "Authorization: Bearer abc.DEF-_xyz=="
    ].join(" / ");
    const masked = redact(text);
    expect(masked).not.toMatch(/AKIA/);
    expect(masked).not.toMatch(/sk-abc/);
    expect(masked).not.toMatch(/sk-or-v1-/);
    expect(masked).not.toMatch(/ghp_abc/);
    expect(masked).not.toMatch(/Bearer abc/);
    expect(masked.split("[REDACTED]").length - 1).toBe(5);
  });

  it("recursively redacts strings inside event payloads", () => {
    const event = {
      type: "user.prompt.submitted",
      sessionId: "s-1",
      content: [
        { kind: "text", text: "see ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD" }
      ],
      meta: {
        token: "Bearer abc.def123",
        nested: ["sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD"]
      }
    };
    const out = redactEvent(event);
    expect(out.content[0].text).toContain("[REDACTED]");
    expect(out.meta.token).toContain("[REDACTED]");
    expect(out.meta.nested[0]).toBe("[REDACTED]");
    expect(event.content[0].text).toContain("ghp_");
  });

  it("supports user-supplied patterns via combinePatterns", () => {
    const patterns = combinePatterns([/COMPANY-[0-9]+/g, { pattern: "TEST-[A-Z]+", flags: "g" }]);
    expect(patterns.length).toBe(DEFAULT_REDACTION_PATTERNS.length + 2);
    const masked = redact("COMPANY-12345 TEST-FOO sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD", { patterns });
    expect(masked).toContain("[REDACTED]");
    expect(masked).not.toContain("COMPANY-12345");
    expect(masked).not.toContain("TEST-FOO");
  });

  it("preserves non-string scalars and returns input untouched when no match", () => {
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBe(null);
    expect(redact("nothing to mask here")).toBe("nothing to mask here");
  });
});
