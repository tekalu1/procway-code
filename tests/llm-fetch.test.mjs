import { describe, it, expect } from "vitest";
import { llmFetch } from "../src/providers/llm-fetch.mjs";

describe("llm-fetch", () => {
  // Importing this module statically imports `undici`. If undici is not an
  // installed dependency the import throws (no fallback by design) — so this
  // test doubling as a presence check is intentional.
  it("loads (undici resolved) and exports a fetch function", () => {
    expect(typeof llmFetch).toBe("function");
  });
});
