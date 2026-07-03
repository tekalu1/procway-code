import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applySecretsFromFiles,
  applySecretsToEnv,
  readSecretsFiles
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
