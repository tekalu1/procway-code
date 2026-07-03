import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { updateAuthProfile } from "../src/auth/token-store.mjs";
import {
  AuthProfileMissingError,
  AuthRefreshFailedError,
  getValidCredentials
} from "../src/auth/refresh-guard.mjs";

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function tmpFile() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "procway-refresh-guard-"));
  tempDirs.push(dir);
  return path.join(dir, "auth-profiles.json");
}

function makeOauthProfile(overrides = {}) {
  return {
    provider: "openai-codex",
    mode: "oauth",
    credentials: {
      access: "fresh-access",
      refresh: "r1",
      expires: Date.now() + 3_600_000,
      accountId: "acc-1",
      ...overrides
    }
  };
}

describe("refresh-guard", () => {
  it("throws AUTH_PROFILE_MISSING for a profile that does not exist", async () => {
    const filePath = await tmpFile();
    await expect(
      getValidCredentials("nope", { pathOverride: filePath })
    ).rejects.toBeInstanceOf(AuthProfileMissingError);
  });

  it("returns the existing credentials without invoking the refresher when fresh", async () => {
    const filePath = await tmpFile();
    await updateAuthProfile("codex", () => makeOauthProfile(), { pathOverride: filePath });
    const refresher = vi.fn();
    const got = await getValidCredentials("codex", { pathOverride: filePath, refresher });
    expect(got.access).toBe("fresh-access");
    expect(refresher).not.toHaveBeenCalled();
  });

  it("refreshes and persists when the access token is expired", async () => {
    const filePath = await tmpFile();
    await updateAuthProfile(
      "codex",
      () => makeOauthProfile({ access: "stale", expires: Date.now() - 1_000 }),
      { pathOverride: filePath }
    );
    const refresher = vi.fn(async (refreshToken) => {
      expect(refreshToken).toBe("r1");
      return { access: "rotated", refresh: "r2", expires: Date.now() + 3_600_000, accountId: "acc-1" };
    });
    const got = await getValidCredentials("codex", { pathOverride: filePath, refresher });
    expect(got.access).toBe("rotated");
    expect(refresher).toHaveBeenCalledTimes(1);
    // Second call must not refresh again — it's now fresh.
    const again = await getValidCredentials("codex", { pathOverride: filePath, refresher });
    expect(again.access).toBe("rotated");
    expect(refresher).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent refreshes for the same profile into a single fetch", async () => {
    const filePath = await tmpFile();
    await updateAuthProfile(
      "codex",
      () => makeOauthProfile({ access: "stale", expires: Date.now() - 1_000 }),
      { pathOverride: filePath }
    );
    let inFlight = 0;
    let maxInFlight = 0;
    const refresher = vi.fn(async (refreshToken) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 25));
      inFlight -= 1;
      expect(refreshToken).toBe("r1");
      return { access: "rotated-" + refresher.mock.calls.length, refresh: "r2", expires: Date.now() + 3_600_000, accountId: "acc-1" };
    });
    const results = await Promise.all([
      getValidCredentials("codex", { pathOverride: filePath, refresher }),
      getValidCredentials("codex", { pathOverride: filePath, refresher }),
      getValidCredentials("codex", { pathOverride: filePath, refresher })
    ]);
    expect(refresher).toHaveBeenCalledTimes(1);
    expect(maxInFlight).toBe(1);
    expect(results[0].access).toBe(results[1].access);
    expect(results[1].access).toBe(results[2].access);
  });

  it("force refreshes even when the token would otherwise be fresh", async () => {
    const filePath = await tmpFile();
    await updateAuthProfile("codex", () => makeOauthProfile(), { pathOverride: filePath });
    const refresher = vi.fn(async () => ({
      access: "rotated", refresh: "r2", expires: Date.now() + 3_600_000, accountId: "acc-1"
    }));
    const got = await getValidCredentials("codex", { pathOverride: filePath, refresher, force: true });
    expect(refresher).toHaveBeenCalledTimes(1);
    expect(got.access).toBe("rotated");
  });

  it("wraps refresh failures in AuthRefreshFailedError with cause preserved", async () => {
    const filePath = await tmpFile();
    await updateAuthProfile(
      "codex",
      () => makeOauthProfile({ access: "stale", expires: Date.now() - 1_000 }),
      { pathOverride: filePath }
    );
    const refresher = vi.fn(async () => { throw new Error("simulated outage"); });
    try {
      await getValidCredentials("codex", { pathOverride: filePath, refresher });
      throw new Error("expected refresh to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthRefreshFailedError);
      expect(err.code).toBe("AUTH_REFRESH_FAILED");
      expect(err.cause).toBeInstanceOf(Error);
      expect(err.cause.message).toMatch(/simulated outage/);
    }
  });
});
