/**
 * Unit test for `startSettingsHotReload`. Uses an injected fake watch impl
 * so we can deterministically trigger the debounce + reload path without
 * relying on filesystem timing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { startSettingsHotReload } from "../src/config/hot-reload.mjs";

function makeFakeWatch() {
  const handlers = [];
  const errorHandlers = [];
  const watcher = {
    on(event, handler) {
      if (event === "error") errorHandlers.push(handler);
    },
    close() {}
  };
  const watch = (_dir, _opts, listener) => {
    handlers.push(listener);
    return watcher;
  };
  return {
    watch,
    triggerChange(filename) {
      for (const handler of handlers) handler("change", filename);
    },
    triggerError(err) {
      for (const handler of errorHandlers) handler(err);
    }
  };
}

describe("startSettingsHotReload", () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hot-reload-"));
    fs.mkdirSync(path.join(tmpDir, ".procway", "ai-agent"), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("mutates the live settings object on settings.json change", async () => {
    const fake = makeFakeWatch();
    const settings = {
      defaultProvider: "p",
      approvalMode: "always-ask",
      providers: { p: { type: "cli-agent", command: "x" } }
    };
    const loadImpl = vi.fn().mockResolvedValue({
      settings: {
        defaultProvider: "p",
        approvalMode: "full-auto",
        providers: { p: { type: "cli-agent", command: "y" } }
      },
      sources: []
    });
    const applySecretsImpl = vi.fn().mockResolvedValue({ secrets: {}, applied: [] });

    const onApplied = vi.fn();
    const handle = startSettingsHotReload({
      cwd: tmpDir,
      settings,
      debounceMs: 5,
      watchImpl: fake.watch,
      loadImpl,
      applySecretsImpl,
      onApplied
    });

    fake.triggerChange("settings.json");
    await handle._drain();

    expect(loadImpl).toHaveBeenCalledTimes(1);
    expect(settings.approvalMode).toBe("full-auto");
    expect(settings.providers.p.command).toBe("y");
    expect(onApplied).toHaveBeenCalledWith(expect.objectContaining({ appliedSecrets: [] }));
    handle.close();
  });

  it("deletes keys that disappear from the new settings", async () => {
    const fake = makeFakeWatch();
    const settings = { defaultProvider: "p", approvalMode: "always-ask", providers: { p: { type: "cli-agent", command: "x" } } };
    const loadImpl = vi.fn().mockResolvedValue({
      settings: { defaultProvider: "p", providers: { p: { type: "cli-agent", command: "x" } } },
      sources: []
    });

    const handle = startSettingsHotReload({
      cwd: tmpDir,
      settings,
      debounceMs: 5,
      watchImpl: fake.watch,
      loadImpl,
      applySecretsImpl: vi.fn().mockResolvedValue({ secrets: {}, applied: [] })
    });

    fake.triggerChange("settings.json");
    await handle._drain();

    expect("approvalMode" in settings).toBe(false);
    handle.close();
  });

  it("skips invalid settings and warns", async () => {
    const fake = makeFakeWatch();
    const settings = { defaultProvider: "p", providers: { p: { type: "cli-agent", command: "x" } } };
    // Invalid: defaultProvider not in providers
    const loadImpl = vi.fn().mockResolvedValue({
      settings: { defaultProvider: "ghost", providers: { p: { type: "cli-agent", command: "x" } } },
      sources: []
    });
    const onWarn = vi.fn();
    const onApplied = vi.fn();

    const handle = startSettingsHotReload({
      cwd: tmpDir,
      settings,
      debounceMs: 5,
      watchImpl: fake.watch,
      loadImpl,
      applySecretsImpl: vi.fn().mockResolvedValue({ secrets: {}, applied: [] }),
      onWarn,
      onApplied
    });

    fake.triggerChange("settings.json");
    await handle._drain();

    expect(onWarn).toHaveBeenCalled();
    expect(onApplied).not.toHaveBeenCalled();
    expect(settings.defaultProvider).toBe("p");
    handle.close();
  });

  it("keeps the prior config and warns STALE when settings.json is corrupt JSON", async () => {
    const fake = makeFakeWatch();
    const settings = {
      defaultProvider: "p",
      providers: { p: { type: "openai-compatible", defaultModel: "deepseek-v4-flash" } }
    };
    // loadSettings throws on JSON.parse for a torn/corrupt file.
    const loadImpl = vi
      .fn()
      .mockRejectedValue(new Error("Failed to parse JSON settings at /x/settings.json: Unexpected non-whitespace"));
    const onWarn = vi.fn();
    const onError = vi.fn();
    const onApplied = vi.fn();

    const handle = startSettingsHotReload({
      cwd: tmpDir,
      settings,
      debounceMs: 5,
      watchImpl: fake.watch,
      loadImpl,
      applySecretsImpl: vi.fn().mockResolvedValue({ secrets: {}, applied: [] }),
      onWarn,
      onError,
      onApplied
    });

    fake.triggerChange("settings.json");
    await handle._drain();

    // Corrupt file → loud STALE warning, NOT a generic onError, and the live
    // config is untouched (don't apply garbage / drop to defaults).
    expect(onWarn).toHaveBeenCalledWith(expect.stringMatching(/corrupt.*STALE/i));
    expect(onError).not.toHaveBeenCalled();
    expect(onApplied).not.toHaveBeenCalled();
    expect(settings.providers.p.defaultModel).toBe("deepseek-v4-flash");
    handle.close();
  });

  it("reapplies secrets with overwrite when secrets.json changes", async () => {
    const fake = makeFakeWatch();
    const settings = { defaultProvider: "p", providers: { p: { type: "cli-agent", command: "x" } } };
    const loadImpl = vi.fn().mockResolvedValue({
      settings: { defaultProvider: "p", providers: { p: { type: "cli-agent", command: "x" } } },
      sources: []
    });
    const applySecretsImpl = vi.fn().mockResolvedValue({ secrets: { K: "v2" }, applied: ["K"] });

    const handle = startSettingsHotReload({
      cwd: tmpDir,
      settings,
      debounceMs: 5,
      watchImpl: fake.watch,
      loadImpl,
      applySecretsImpl
    });

    fake.triggerChange("secrets.json");
    await handle._drain();

    expect(applySecretsImpl).toHaveBeenCalledTimes(1);
    expect(applySecretsImpl.mock.calls[0][0]).toMatchObject({ overwrite: true });
    handle.close();
  });

  it("applies user env on user-env.json change and reports it via onApplied (issue #30)", async () => {
    const fake = makeFakeWatch();
    const settings = { defaultProvider: "p", providers: { p: { type: "cli-agent", command: "x" } } };
    const loadImpl = vi.fn().mockResolvedValue({ settings: { ...settings }, sources: [] });
    const applyUserEnvImpl = vi.fn().mockResolvedValue({ applied: ["FOO"], removed: [], skipped: [] });
    const onApplied = vi.fn();

    const handle = startSettingsHotReload({
      cwd: tmpDir,
      settings,
      debounceMs: 5,
      watchImpl: fake.watch,
      loadImpl,
      applySecretsImpl: vi.fn().mockResolvedValue({ secrets: {}, applied: [] }),
      applyUserEnvImpl,
      onApplied
    });

    fake.triggerChange("user-env.json");
    await handle._drain();

    expect(applyUserEnvImpl).toHaveBeenCalledTimes(1);
    expect(onApplied).toHaveBeenCalledWith(
      expect.objectContaining({ userEnv: { applied: ["FOO"], removed: [], skipped: [] } })
    );
    handle.close();
  });

  it("re-applies user env on active-project change (ADR 0024 Phase 2 runtime switch)", async () => {
    const fake = makeFakeWatch();
    const settings = { defaultProvider: "p", providers: { p: { type: "cli-agent", command: "x" } } };
    const loadImpl = vi.fn().mockResolvedValue({ settings: { ...settings }, sources: [] });
    const applyUserEnvImpl = vi.fn().mockResolvedValue({ applied: ["B"], removed: ["A"], skipped: [] });

    const handle = startSettingsHotReload({
      cwd: tmpDir,
      settings,
      debounceMs: 5,
      watchImpl: fake.watch,
      loadImpl,
      applySecretsImpl: vi.fn().mockResolvedValue({ secrets: {}, applied: [] }),
      applyUserEnvImpl,
      onApplied: vi.fn()
    });

    fake.triggerChange("active-project");
    await handle._drain();

    expect(applyUserEnvImpl).toHaveBeenCalledTimes(1);
    handle.close();
  });

  it("still applies user env when settings.json is corrupt (independent failure domains)", async () => {
    const fake = makeFakeWatch();
    const settings = { defaultProvider: "p", providers: { p: { type: "cli-agent", command: "x" } } };
    const loadImpl = vi
      .fn()
      .mockRejectedValue(new Error("Failed to parse JSON settings at /x/settings.json: Unexpected non-whitespace"));
    const applyUserEnvImpl = vi.fn().mockResolvedValue({ applied: ["FOO"], removed: [], skipped: [] });
    const onWarn = vi.fn();

    const handle = startSettingsHotReload({
      cwd: tmpDir,
      settings,
      debounceMs: 5,
      watchImpl: fake.watch,
      loadImpl,
      applySecretsImpl: vi.fn().mockResolvedValue({ secrets: {}, applied: [] }),
      applyUserEnvImpl,
      onWarn
    });

    fake.triggerChange("settings.json");
    await handle._drain();

    expect(applyUserEnvImpl).toHaveBeenCalledTimes(1);
    expect(onWarn).toHaveBeenCalledWith(expect.stringMatching(/corrupt.*STALE/i));
    handle.close();
  });

  it("ignores unrelated filenames", async () => {
    const fake = makeFakeWatch();
    const loadImpl = vi.fn();
    const handle = startSettingsHotReload({
      cwd: tmpDir,
      settings: { defaultProvider: "p", providers: { p: { type: "cli-agent", command: "x" } } },
      debounceMs: 5,
      watchImpl: fake.watch,
      loadImpl,
      applySecretsImpl: vi.fn().mockResolvedValue({ secrets: {}, applied: [] })
    });

    fake.triggerChange("README.md");
    await handle._drain();
    expect(loadImpl).not.toHaveBeenCalled();
    handle.close();
  });

  it("debounces multiple rapid changes into one reload", async () => {
    const fake = makeFakeWatch();
    const loadImpl = vi.fn().mockResolvedValue({
      settings: { defaultProvider: "p", providers: { p: { type: "cli-agent", command: "x" } } },
      sources: []
    });
    const handle = startSettingsHotReload({
      cwd: tmpDir,
      settings: { defaultProvider: "p", providers: { p: { type: "cli-agent", command: "x" } } },
      debounceMs: 20,
      watchImpl: fake.watch,
      loadImpl,
      applySecretsImpl: vi.fn().mockResolvedValue({ secrets: {}, applied: [] })
    });

    fake.triggerChange("settings.json");
    fake.triggerChange("settings.json");
    fake.triggerChange("settings.json");
    await handle._drain();
    expect(loadImpl).toHaveBeenCalledTimes(1);
    handle.close();
  });
});
