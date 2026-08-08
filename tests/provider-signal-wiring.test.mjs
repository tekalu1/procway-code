// S-1 (wiring half): runProvider must hand the turn's AbortSignal to EVERY
// provider branch. cli-agent and openai-codex already did; the two main
// branches (openai-compatible, anthropic) silently dropped it, so a Stop never
// reached the socket. Mocked at the module boundary so this asserts the wiring
// itself, not the HTTP behavior (covered in abort-propagation.test.mjs).
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ openai: [], anthropic: [], codex: [], cli: [] }));

vi.mock("../src/providers/openai-compatible.mjs", () => ({
  runOpenAiCompatibleProvider: async (args) => { calls.openai.push(args); return { message: { role: "assistant", content: "ok" }, toolCalls: [] }; },
  ProviderRequestError: class extends Error {},
  isRetryableNetworkError: () => false
}));
vi.mock("../src/providers/anthropic.mjs", () => ({
  runAnthropicProvider: async (args) => { calls.anthropic.push(args); return { message: { role: "assistant", content: "ok" }, toolCalls: [] }; }
}));
vi.mock("../src/providers/openai-codex.mjs", () => ({
  runOpenAiCodexProvider: async (args) => { calls.codex.push(args); return { message: { role: "assistant", content: "ok" }, toolCalls: [] }; }
}));
vi.mock("../src/providers/cli-agent.mjs", () => ({
  runCliAgentProvider: async (args) => { calls.cli.push(args); return { message: { role: "assistant", content: "ok" }, toolCalls: [] }; }
}));

const { runProvider } = await import("../src/providers/index.mjs");

function settingsFor(type) {
  return {
    defaultProvider: "p",
    providers: { p: { type, baseUrl: "https://example.test", apiKeyEnv: "X", defaultModel: "m", command: "echo" } }
  };
}

describe("runProvider signal wiring", () => {
  beforeEach(() => {
    calls.openai.length = 0;
    calls.anthropic.length = 0;
    calls.codex.length = 0;
    calls.cli.length = 0;
  });

  const cases = [
    ["openai-compatible", "openai"],
    ["openai", "openai"],
    ["openai-via-proxy", "openai"],
    ["anthropic", "anthropic"],
    ["anthropic-compatible", "anthropic"],
    ["anthropic-via-proxy", "anthropic"],
    ["openai-codex", "codex"],
    ["cli-agent", "cli"]
  ];

  for (const [type, bucket] of cases) {
    it(`forwards the signal to the ${type} branch`, async () => {
      const controller = new AbortController();
      await runProvider({
        settings: settingsFor(type),
        messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
        prompt: "hi",
        signal: controller.signal
      });
      expect(calls[bucket]).toHaveLength(1);
      expect(calls[bucket][0].signal).toBe(controller.signal);
    });
  }
});
