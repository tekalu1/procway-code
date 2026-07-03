import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSettings, settingsFromEnv } from "../src/config/load-settings.mjs";

let tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("loadSettings", () => {
  it("prefers workspace settings over user settings (per-provider model)", async () => {
    const homeDir = await makeTempDir();
    const cwd = await makeTempDir();
    await writeSettings(homeDir, ".procway/ai-agent/settings.json", {
      providers: { "openai-main": { defaultModel: "user-model" } },
      context: { compatibilityMode: "codex" }
    });
    await writeSettings(cwd, ".procway/ai-agent/settings.json", {
      providers: { "openai-main": { defaultModel: "workspace-model" } }
    });

    const { settings } = await loadSettings({ cwd, homeDir, env: {} });

    expect(settings.providers["openai-main"].defaultModel).toBe("workspace-model");
    expect(settings.context.compatibilityMode).toBe("codex");
  });

  it("CLI --model overrides the active provider's defaultModel", async () => {
    const cwd = await makeTempDir();
    await writeSettings(cwd, ".procway/ai-agent/settings.json", {
      providers: { "openai-main": { defaultModel: "workspace-model" } }
    });

    const { settings } = await loadSettings({
      cwd,
      homeDir: await makeTempDir(),
      env: {},
      cliOptions: { model: "cli-model" }
    });

    expect(settings.providers["openai-main"].defaultModel).toBe("cli-model");
  });

  it("PROCWAY_CODE_MODEL overrides the active provider's defaultModel", async () => {
    const cwd = await makeTempDir();
    const { settings } = await loadSettings({
      cwd,
      homeDir: await makeTempDir(),
      env: { PROCWAY_CODE_MODEL: "env-model" }
    });

    expect(settings.providers["openai-main"].defaultModel).toBe("env-model");
  });

  it("workspace settings defaultModel beats PROCWAY_CODE_MODEL (issue #30 hot-reload)", async () => {
    // The env model is the dashboard's spawn-time bootstrap, frozen into the
    // Pod; the workspace file is the dashboard's LIVE distribution channel.
    // An explicit workspace defaultModel for the active provider must win or
    // a dashboard model change would never reach a running session.
    const cwd = await makeTempDir();
    await writeSettings(cwd, ".procway/ai-agent/settings.json", {
      defaultProvider: "anthropic-via-proxy",
      providers: { "anthropic-via-proxy": { type: "anthropic-via-proxy", baseUrl: "http://d/api/agent-llm-proxy/anthropic", defaultModel: "snapshot-model" } }
    });

    const { settings } = await loadSettings({
      cwd,
      homeDir: await makeTempDir(),
      env: {
        PROCWAY_CODE_PROVIDER: "anthropic-via-proxy",
        PROCWAY_PROVIDER_BASE_URL: "http://d/api/agent-llm-proxy/anthropic",
        PROCWAY_CODE_MODEL: "frozen-env-model"
      }
    });

    expect(settings.providers["anthropic-via-proxy"].defaultModel).toBe("snapshot-model");
  });

  it("PROCWAY_CODE_MODEL still applies when the workspace file does not pin a model", async () => {
    const cwd = await makeTempDir();
    await writeSettings(cwd, ".procway/ai-agent/settings.json", {
      approvalMode: "full-auto"
    });

    const { settings } = await loadSettings({
      cwd,
      homeDir: await makeTempDir(),
      env: { PROCWAY_CODE_MODEL: "env-model" }
    });

    expect(settings.providers["openai-main"].defaultModel).toBe("env-model");
  });

  it("CLI --model beats a workspace defaultModel and env", async () => {
    const cwd = await makeTempDir();
    await writeSettings(cwd, ".procway/ai-agent/settings.json", {
      defaultProvider: "openai-main",
      providers: { "openai-main": { defaultModel: "snapshot-model" } }
    });

    const { settings } = await loadSettings({
      cwd,
      homeDir: await makeTempDir(),
      env: { PROCWAY_CODE_MODEL: "env-model" },
      cliOptions: { model: "cli-model" }
    });

    expect(settings.providers["openai-main"].defaultModel).toBe("cli-model");
  });

  it("CLI --model wins over env when both are set", async () => {
    const cwd = await makeTempDir();
    const { settings } = await loadSettings({
      cwd,
      homeDir: await makeTempDir(),
      env: { PROCWAY_CODE_MODEL: "env-model" },
      cliOptions: { model: "cli-model" }
    });

    expect(settings.providers["openai-main"].defaultModel).toBe("cli-model");
  });

  it("loads CLI max tool rounds override", async () => {
    const { settings } = await loadSettings({
      cwd: await makeTempDir(),
      homeDir: await makeTempDir(),
      env: {},
      cliOptions: { maxToolRounds: 0 }
    });

    expect(settings.tools.maxToolRounds).toBe(0);
  });

  it("model override is a no-op when defaultProvider has no provider entry", async () => {
    const cwd = await makeTempDir();
    await writeSettings(cwd, ".procway/ai-agent/settings.json", {
      defaultProvider: "ghost",
      providers: { "openai-main": { defaultModel: "ws-model" } }
    });

    const { settings } = await loadSettings({
      cwd,
      homeDir: await makeTempDir(),
      env: {},
      cliOptions: { model: "ignored" }
    });

    expect(settings.defaultProvider).toBe("ghost");
    expect(settings.providers["openai-main"].defaultModel).toBe("ws-model");
    expect(settings.providers.ghost).toBeUndefined();
  });

  it("builds an anthropic-via-proxy provider from env without any settings.json (ADR 0008 §F7c)", async () => {
    // No workspace/user settings.json ships into the session container after
    // the auth volume is removed; the broker provider must materialize from
    // env alone.
    const { settings } = await loadSettings({
      cwd: await makeTempDir(),
      homeDir: await makeTempDir(),
      env: {
        PROCWAY_CODE_PROVIDER: "anthropic-via-proxy",
        PROCWAY_PROVIDER_BASE_URL: "http://procway-dashboard:3333/api/agent-llm-proxy/anthropic",
        PROCWAY_CODE_MODEL: "claude-sonnet-4-6"
      }
    });

    expect(settings.defaultProvider).toBe("anthropic-via-proxy");
    const provider = settings.providers["anthropic-via-proxy"];
    expect(provider).toMatchObject({
      type: "anthropic-via-proxy",
      baseUrl: "http://procway-dashboard:3333/api/agent-llm-proxy/anthropic",
      defaultModel: "claude-sonnet-4-6"
    });
    // No apiKeyEnv: the proxy supplies the credential.
    expect(provider.apiKeyEnv).toBeUndefined();
  });

  it("settingsFromEnv leaves providers untouched when PROCWAY_PROVIDER_BASE_URL is absent", () => {
    const s = settingsFromEnv({ PROCWAY_CODE_PROVIDER: "openai-main" });
    expect(s.defaultProvider).toBe("openai-main");
    expect(s.providers).toBeUndefined();
  });
});

async function makeTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "procway-code-"));
  tempDirs.push(dir);
  return dir;
}

async function writeSettings(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(content), "utf8");
}
