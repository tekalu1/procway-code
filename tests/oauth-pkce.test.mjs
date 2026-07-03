import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generatePKCE } from "../src/auth/oauth/pkce.mjs";

function sha256Base64Url(input) {
  return createHash("sha256")
    .update(input)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

describe("generatePKCE", () => {
  it("returns a 43-char base64url verifier and challenge", async () => {
    const { verifier, challenge } = await generatePKCE();
    expect(verifier).toHaveLength(43);
    expect(challenge).toHaveLength(43);
    expect(BASE64URL_PATTERN.test(verifier)).toBe(true);
    expect(BASE64URL_PATTERN.test(challenge)).toBe(true);
  });

  it("computes the challenge as sha256(verifier) in base64url", async () => {
    const { verifier, challenge } = await generatePKCE();
    expect(challenge).toBe(sha256Base64Url(verifier));
  });

  it("produces distinct verifier/challenge across calls", async () => {
    const a = await generatePKCE();
    const b = await generatePKCE();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });
});
