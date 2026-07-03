import { describe, expect, it } from "vitest";
import { validateSettings } from "../src/config/schema.mjs";

describe("validateSettings", () => {
  it("requires configured default provider to exist", () => {
    expect(validateSettings({
      defaultProvider: "missing",
      providers: {}
    })).toContain("defaultProvider not found in providers: missing");
  });

  it("validates provider required keys", () => {
    expect(validateSettings({
      providers: {
        openrouter: { type: "openai-compatible" },
        worker: { type: "cli-agent" }
      }
    })).toEqual(expect.arrayContaining([
      "providers.openrouter.apiKeyEnv is required",
      "providers.openrouter.baseUrl is required",
      "providers.openrouter.defaultModel is required for openai-compatible providers",
      "providers.worker.command is required for cli-agent providers"
    ]));
  });

  it("rejects provider ids that violate the naming pattern", () => {
    const errors = validateSettings({
      providers: {
        Foo_Bar: { type: "cli-agent", command: "foo" },
        "1bad": { type: "cli-agent", command: "bad" }
      }
    });
    expect(errors).toEqual(expect.arrayContaining([
      "providers.Foo_Bar: id must match /^[a-z][a-z0-9-]*$/",
      "providers.1bad: id must match /^[a-z][a-z0-9-]*$/"
    ]));
  });

  it("requires defaultModel for API-type providers and tolerates omission for cli-agent", () => {
    const errors = validateSettings({
      providers: {
        openrouter: { type: "openai-compatible", apiKeyEnv: "K", baseUrl: "https://x" },
        worker: { type: "cli-agent", command: "node" }
      }
    });
    expect(errors).toContain("providers.openrouter.defaultModel is required for openai-compatible providers");
    expect(errors.some((e) => e.includes("worker.defaultModel"))).toBe(false);
  });

  it("validates provider reasoningEffort against the allowed set", () => {
    const errors = validateSettings({
      providers: {
        bad: { type: "openai-codex", defaultModel: "gpt-5.5", reasoningEffort: "turbo" },
        good: { type: "openai-codex", defaultModel: "gpt-5.5", reasoningEffort: "Low" }
      }
    });
    expect(errors).toContain("providers.bad.reasoningEffort must be one of: minimal, low, medium, high");
    expect(errors.some((e) => e.startsWith("providers.good.reasoningEffort"))).toBe(false);
  });

  it("validates cli-agent args is a string array when present", () => {
    const errors = validateSettings({
      providers: {
        worker: { type: "cli-agent", command: "node", args: ["ok", 123] }
      }
    });
    expect(errors).toContain("providers.worker.args must be an array of strings");
  });

  it("validates MCP server required keys and writeLock type", () => {
    expect(validateSettings({
      tools: { writeLock: "yes" },
      mcpServers: {
        missingTransport: {},
        missingCommand: { transport: "stdio" },
        missingBaseUrl: { transport: "http" },
        invalidTransport: { transport: "ws" }
      }
    })).toEqual(expect.arrayContaining([
      "tools.writeLock must be a boolean",
      "mcpServers.missingTransport.transport is required",
      "mcpServers.missingCommand.command is required",
      "mcpServers.missingBaseUrl.baseUrl is required",
      "mcpServers.invalidTransport.transport must be one of: stdio, http, sse"
    ]));
  });

  it("validates tools.webSearch entries", () => {
    const errors = validateSettings({
      tools: {
        webSearch: {
          backend: "wolfram",
          apiKeyEnv: "",
          baseUrl: "",
          defaultMaxResults: 0,
          timeoutMs: 0,
          googleCseId: 42
        }
      }
    });
    expect(errors).toEqual(expect.arrayContaining([
      "tools.webSearch.backend must be one of: tavily, brave, serper, google-cse, duckduckgo",
      "tools.webSearch.apiKeyEnv must be a non-empty string",
      "tools.webSearch.baseUrl must be a non-empty string",
      "tools.webSearch.defaultMaxResults must be a number >= 1",
      "tools.webSearch.timeoutMs must be a number >= 1",
      "tools.webSearch.googleCseId must be a string"
    ]));
  });

  it("accepts a fully-specified tools.webSearch block", () => {
    const errors = validateSettings({
      tools: {
        webSearch: {
          backend: "tavily",
          apiKeyEnv: "TAVILY_API_KEY",
          baseUrl: "https://api.tavily.com/search",
          defaultMaxResults: 5,
          timeoutMs: 15000,
          googleCseId: "cx-id"
        }
      }
    });
    expect(errors.filter((e) => e.startsWith("tools.webSearch"))).toEqual([]);
  });

  it("validates auto compact settings", () => {
    expect(validateSettings({
      session: {
        autoCompact: {
          enabled: "yes",
          messageCount: 0,
          estimatedTokens: 0,
          keepLastMessages: 0,
          strategy: "unknown",
          dropToolResults: "nope"
        }
      }
    })).toEqual(expect.arrayContaining([
      "session.autoCompact.enabled must be a boolean",
      "session.autoCompact.messageCount must be >= 1",
      "session.autoCompact.estimatedTokens must be >= 1",
      "session.autoCompact.keepLastMessages must be >= 1",
      "session.autoCompact.strategy must be one of: drop-tool-results, summarize-context, summarize-aggressive, truncate-oldest, llm-summary",
      "session.autoCompact.dropToolResults must be a boolean"
    ]));
  });

  it("accepts a valid auto compact block with dropToolResults", () => {
    const errors = validateSettings({
      session: {
        autoCompact: {
          enabled: true,
          messageCount: 40,
          estimatedTokens: 60000,
          keepLastMessages: 10,
          strategy: "llm-summary",
          dropToolResults: true
        }
      }
    });
    expect(errors.filter((e) => e.startsWith("session.autoCompact"))).toEqual([]);
  });
});
