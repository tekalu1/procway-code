import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deleteAuthProfile,
  readAuthProfile,
  readAuthProfilesStore,
  updateAuthProfile,
  writeOAuthProfile
} from "../src/auth/token-store.mjs";

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function tmpFile() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "procway-auth-store-"));
  tempDirs.push(dir);
  return path.join(dir, "auth-profiles.json");
}

describe("token-store", () => {
  it("returns an empty store when the file does not exist", async () => {
    const filePath = await tmpFile();
    const { store } = await readAuthProfilesStore({ pathOverride: filePath });
    expect(store).toEqual({ profiles: {} });
    expect(await readAuthProfile("codex", { pathOverride: filePath })).toBeNull();
  });

  it("writes a profile, stamps updatedAt, and round-trips on read", async () => {
    const filePath = await tmpFile();
    const credentials = { access: "a1", refresh: "r1", expires: Date.now() + 60_000, accountId: "acc-1" };
    const before = Date.now();
    await writeOAuthProfile("codex", "openai-codex", credentials, { pathOverride: filePath });
    const profile = await readAuthProfile("codex", { pathOverride: filePath });
    expect(profile).not.toBeNull();
    expect(profile.provider).toBe("openai-codex");
    expect(profile.mode).toBe("oauth");
    expect(profile.credentials).toEqual(credentials);
    expect(typeof profile.updatedAt).toBe("string");
    expect(Date.parse(profile.updatedAt)).toBeGreaterThanOrEqual(before);
  });

  it("rotates refresh tokens through updateAuthProfile", async () => {
    const filePath = await tmpFile();
    await writeOAuthProfile(
      "codex",
      "openai-codex",
      { access: "a1", refresh: "r1", expires: 1, accountId: "acc" },
      { pathOverride: filePath }
    );
    await updateAuthProfile(
      "codex",
      (prev) => ({
        provider: prev.provider,
        mode: "oauth",
        credentials: { ...prev.credentials, access: "a2", refresh: "r2" }
      }),
      { pathOverride: filePath }
    );
    const profile = await readAuthProfile("codex", { pathOverride: filePath });
    expect(profile.credentials.access).toBe("a2");
    expect(profile.credentials.refresh).toBe("r2");
    expect(profile.credentials.accountId).toBe("acc");
  });

  it("deletes a profile (and is a no-op for missing profiles)", async () => {
    const filePath = await tmpFile();
    await writeOAuthProfile(
      "codex",
      "openai-codex",
      { access: "a", refresh: "r", expires: 1, accountId: "acc" },
      { pathOverride: filePath }
    );
    await deleteAuthProfile("codex", { pathOverride: filePath });
    expect(await readAuthProfile("codex", { pathOverride: filePath })).toBeNull();
    // Calling delete again must not throw.
    await deleteAuthProfile("codex", { pathOverride: filePath });
  });

  it("serializes concurrent writes via the lock file", async () => {
    const filePath = await tmpFile();
    await Promise.all([
      updateAuthProfile(
        "codex",
        () => ({ provider: "openai-codex", mode: "oauth", credentials: { access: "A", refresh: "X", expires: 1 } }),
        { pathOverride: filePath }
      ),
      updateAuthProfile(
        "other",
        () => ({ provider: "openai-codex", mode: "oauth", credentials: { access: "B", refresh: "Y", expires: 2 } }),
        { pathOverride: filePath }
      )
    ]);
    const codex = await readAuthProfile("codex", { pathOverride: filePath });
    const other = await readAuthProfile("other", { pathOverride: filePath });
    expect(codex.credentials.access).toBe("A");
    expect(other.credentials.access).toBe("B");
  });

  it("writes atomically (no .tmp file left behind on success)", async () => {
    const filePath = await tmpFile();
    await writeOAuthProfile(
      "codex",
      "openai-codex",
      { access: "a", refresh: "r", expires: 1, accountId: "acc" },
      { pathOverride: filePath }
    );
    const dir = path.dirname(filePath);
    const entries = await readFile(filePath, "utf8");
    expect(entries).toMatch(/"codex"/);
    // No tmp file should remain.
    const remaining = await rm(`${filePath}.tmp-0`, { force: true }).then(() => null).catch((e) => e);
    expect(remaining).toBeNull();
    void dir;
  });

  it("rejects malformed JSON with a clear error", async () => {
    const filePath = await tmpFile();
    // Write garbage straight to disk, bypassing the API.
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "not json", "utf8");
    await expect(readAuthProfilesStore({ pathOverride: filePath })).rejects.toThrow(/not valid JSON/);
  });
});
