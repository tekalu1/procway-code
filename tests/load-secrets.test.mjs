import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applySecretsFromFiles,
  applySecretsToEnv,
  readSecretsFiles,
  setSecret,
  setWorkspaceSecret
} from "../src/config/load-secrets.mjs";

let tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

async function makeTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "procway-secrets-"));
  tempDirs.push(dir);
  return dir;
}

async function writeSecrets(root, contents) {
  const filePath = path.join(root, ".procway", "ai-agent", "secrets.json");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(contents), "utf8");
  return filePath;
}

describe("readSecretsFiles", () => {
  it("returns an empty object when neither file exists", async () => {
    const homeDir = await makeTempDir();
    const cwd = await makeTempDir();
    const secrets = await readSecretsFiles({ cwd, homeDir });
    expect(secrets).toEqual({});
  });

  it("merges user and workspace; workspace wins on key collision", async () => {
    const homeDir = await makeTempDir();
    const cwd = await makeTempDir();
    await writeSecrets(homeDir, { OPENROUTER_API_KEY: "from-user", USER_ONLY: "user-val" });
    await writeSecrets(cwd, { OPENROUTER_API_KEY: "from-workspace", WS_ONLY: "ws-val" });

    const secrets = await readSecretsFiles({ cwd, homeDir });

    expect(secrets).toEqual({
      OPENROUTER_API_KEY: "from-workspace",
      USER_ONLY: "user-val",
      WS_ONLY: "ws-val"
    });
  });

  it("drops non-string and empty-string values", async () => {
    const cwd = await makeTempDir();
    await writeSecrets(cwd, {
      GOOD: "value",
      EMPTY: "",
      NUMERIC: 123,
      NULL_KEY: null,
      OBJECT: { nested: "x" }
    });

    const secrets = await readSecretsFiles({ cwd, homeDir: await makeTempDir() });

    expect(secrets).toEqual({ GOOD: "value" });
  });

  it("invokes onParseError for malformed JSON and continues with the other file", async () => {
    const homeDir = await makeTempDir();
    const cwd = await makeTempDir();
    const badPath = path.join(cwd, ".procway", "ai-agent", "secrets.json");
    await mkdir(path.dirname(badPath), { recursive: true });
    await writeFile(badPath, "{ this is not json", "utf8");
    await writeSecrets(homeDir, { OPENROUTER_API_KEY: "ok" });

    const onParseError = vi.fn();
    const secrets = await readSecretsFiles({ cwd, homeDir, onParseError });

    expect(secrets).toEqual({ OPENROUTER_API_KEY: "ok" });
    expect(onParseError).toHaveBeenCalledTimes(1);
    expect(onParseError.mock.calls[0][0]).toBe(badPath);
  });
});

describe("setWorkspaceSecret", () => {
  it("stores in user scope by default", async () => {
    const homeDir = await makeTempDir();
    const cwd = await makeTempDir();
    const result = await setSecret({ cwd, homeDir, key: "OPENAI_API_KEY", value: "user-secret" });

    expect(result).toEqual({
      path: path.join(homeDir, ".procway", "ai-agent", "secrets.json"),
      scope: "user",
      key: "OPENAI_API_KEY",
      stored: true
    });
    await expect(readSecretsFiles({ cwd, homeDir })).resolves.toEqual({ OPENAI_API_KEY: "user-secret" });
  });

  it("supports an explicit workspace scope", async () => {
    const homeDir = await makeTempDir();
    const cwd = await makeTempDir();
    const result = await setSecret({ cwd, homeDir, scope: "workspace", key: "WORKSPACE_TOKEN", value: "workspace-secret" });

    expect(result.scope).toBe("workspace");
    expect(result.path).toBe(path.join(cwd, ".procway", "ai-agent", "secrets.json"));
  });

  it("stores a secret without returning its value and restricts file permissions", async () => {
    const cwd = await makeTempDir();
    const result = await setWorkspaceSecret({ cwd, key: "OPENAI_API_KEY", value: "test-secret" });

    expect(result).toEqual({
      path: path.join(cwd, ".procway", "ai-agent", "secrets.json"),
      key: "OPENAI_API_KEY",
      stored: true
    });
    await expect(readSecretsFiles({ cwd, homeDir: await makeTempDir() })).resolves.toEqual({
      OPENAI_API_KEY: "test-secret"
    });
    const { mode } = await import("node:fs/promises").then(({ stat }) => stat(result.path));
    expect(mode & 0o777).toBe(0o600);
  });

  it("preserves existing secrets and rejects invalid names", async () => {
    const cwd = await makeTempDir();
    await setWorkspaceSecret({ cwd, key: "FIRST_TOKEN", value: "one" });
    await setWorkspaceSecret({ cwd, key: "SECOND_TOKEN", value: "two" });

    await expect(readSecretsFiles({ cwd, homeDir: await makeTempDir() })).resolves.toEqual({
      FIRST_TOKEN: "one",
      SECOND_TOKEN: "two"
    });
    await expect(setWorkspaceSecret({ cwd, key: "bad-name", value: "x" }))
      .rejects.toThrow("valid environment variable name");
  });

  it("rejects unknown scopes", async () => {
    await expect(setSecret({ scope: "project", key: "TOKEN", value: "x" }))
      .rejects.toThrow("scope must be user or workspace");
  });
});

describe("applySecretsToEnv", () => {
  it("fills only missing keys (env wins)", () => {
    const env = { OPENROUTER_API_KEY: "from-shell" };
    const applied = applySecretsToEnv(env, {
      OPENROUTER_API_KEY: "from-file",
      OPENAI_API_KEY: "from-file"
    });

    expect(env.OPENROUTER_API_KEY).toBe("from-shell");
    expect(env.OPENAI_API_KEY).toBe("from-file");
    expect(applied).toEqual(["OPENAI_API_KEY"]);
  });

  it("treats empty-string env values as missing and fills them", () => {
    const env = { OPENROUTER_API_KEY: "" };
    const applied = applySecretsToEnv(env, { OPENROUTER_API_KEY: "from-file" });

    expect(env.OPENROUTER_API_KEY).toBe("from-file");
    expect(applied).toEqual(["OPENROUTER_API_KEY"]);
  });

  it("ignores empty-string values in secrets", () => {
    const env = {};
    const applied = applySecretsToEnv(env, { OPENROUTER_API_KEY: "" });

    expect(env).toEqual({});
    expect(applied).toEqual([]);
  });
});

describe("applySecretsFromFiles", () => {
  it("reads files and applies with env-priority", async () => {
    const homeDir = await makeTempDir();
    const cwd = await makeTempDir();
    await writeSecrets(cwd, { OPENROUTER_API_KEY: "from-workspace", ANTHROPIC_API_KEY: "ant" });
    const env = { OPENROUTER_API_KEY: "from-shell" };

    const { secrets, applied } = await applySecretsFromFiles({ cwd, homeDir, env });

    expect(secrets).toEqual({ OPENROUTER_API_KEY: "from-workspace", ANTHROPIC_API_KEY: "ant" });
    expect(env.OPENROUTER_API_KEY).toBe("from-shell");
    expect(env.ANTHROPIC_API_KEY).toBe("ant");
    expect(applied).toEqual(["ANTHROPIC_API_KEY"]);
  });
});
