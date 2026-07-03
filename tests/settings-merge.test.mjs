import { describe, expect, it } from "vitest";
import { mergeSettings } from "../src/config/merge-settings.mjs";

describe("mergeSettings", () => {
  it("deep merges objects and replaces arrays", () => {
    const result = mergeSettings(
      {
        providers: {
          a: { type: "openai", baseUrl: "https://example.test" }
        },
        context: {
          instructionPriority: ["cli", "workspace"]
        }
      },
      {
        providers: {
          a: { apiKeyEnv: "OPENAI_API_KEY" },
          b: { type: "cli-agent" }
        },
        context: {
          instructionPriority: ["cli", "user"]
        }
      }
    );

    expect(result.providers.a).toEqual({
      type: "openai",
      baseUrl: "https://example.test",
      apiKeyEnv: "OPENAI_API_KEY"
    });
    expect(result.providers.b).toEqual({ type: "cli-agent" });
    expect(result.context.instructionPriority).toEqual(["cli", "user"]);
  });
});
