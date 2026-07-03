import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  compactCommand,
  configCommand,
  modelCommand,
  historyCommand,
  exitCommand,
  createAgentSession
} from "../src/core/index.mjs";

/**
 * Phase 5 (phase4_D-1): the previous fakeSession plain-object stub is gone.
 * Each test now stands up a real AgentSession with `session: { enabled: false }`
 * in a tmp cwd, mirroring the integration style adopted by
 * `tests/turn-orchestrator.test.mjs` in Phase 4.
 */
describe("core/commands", () => {
  let cwd;
  let session;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "procway-cmd-"));
    session = await createAgentSession({
      settings: {
        defaultProvider: "p",
        providers: { p: { type: "openai-compatible", apiKeyEnv: "K", baseUrl: "u", defaultModel: "m" } },
        session: { enabled: false },
        agents: {}
      },
      cwd,
      sessionId: "fake-1"
    });
    session.messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" }
    ];
  });

  afterEach(async () => {
    if (cwd) await rm(cwd, { recursive: true, force: true });
  });

  it("configCommand returns settings", async () => {
    const result = await configCommand({ session });
    expect(result.settings.defaultProvider).toBe("p");
    expect(result.settings.providers.p.defaultModel).toBe("m");
  });

  it("modelCommand returns provider:model", async () => {
    const result = await modelCommand({ session });
    expect(result).toEqual({ provider: "p", model: "m" });
  });

  it("historyCommand returns transcript projection", async () => {
    const result = await historyCommand({ session });
    expect(result.sessionId).toBe("fake-1");
    expect(result.transcript).toEqual([
      { kind: "user", role: "user", text: "hello" },
      { kind: "assistant", role: "assistant", text: "hi" }
    ]);
  });

  it("compactCommand --status reports status only via session.compactStatus()", async () => {
    const result = await compactCommand({ session, args: ["--status"] });
    expect(result.status).toBeTypeOf("object");
    expect(result.status.messageCount).toBe(2);
  });

  it("compactCommand parses keep-last + strategy from argv slice", async () => {
    // Bypass the heavy compactor by overriding `compact` on the live session.
    let captured = null;
    session.compact = async (options) => {
      captured = options;
      return {
        compacted: true,
        strategy: options.strategy ?? "summarize-context",
        keepLastMessages: options.keepLastMessages ?? 10,
        removedMessages: 0
      };
    };
    const result = await compactCommand({
      session,
      args: ["--strategy", "summarize-aggressive", "--keep-last", "5"]
    });
    expect(captured).toEqual({ strategy: "summarize-aggressive", keepLastMessages: 5 });
    expect(result.strategy).toBe("summarize-aggressive");
    expect(result.keepLastMessages).toBe(5);
  });

  it("exitCommand returns the exit sentinel", async () => {
    const result = await exitCommand();
    expect(result).toEqual({ action: "exit" });
  });
});
