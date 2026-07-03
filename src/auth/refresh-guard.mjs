import { readAuthProfile, updateAuthProfile } from "./token-store.mjs";
import { refreshOpenAICodexToken } from "./oauth/openai-codex.mjs";

// Refresh `EXPIRY_LEEWAY_MS` before the access token actually expires, so a
// long-running request doesn't have the token go stale mid-flight.
const EXPIRY_LEEWAY_MS = 60_000;

// In-process coalescing: while one refresh is running for a profile, all other
// callers wait on the same promise instead of issuing parallel refreshes (which
// would race on refresh_token rotation and invalidate each other).
const inFlightRefreshes = new Map();

const REFRESHERS = {
  "openai-codex": refreshOpenAICodexToken
};

class AuthProfileMissingError extends Error {
  constructor(profileId) {
    super(`Auth profile not found: ${profileId}. Run "procway-code auth login <provider>" first.`);
    this.code = "AUTH_PROFILE_MISSING";
    this.profileId = profileId;
  }
}

class AuthRefreshFailedError extends Error {
  constructor(profileId, cause) {
    super(`Failed to refresh credentials for profile "${profileId}": ${cause?.message ?? cause}`);
    this.code = "AUTH_REFRESH_FAILED";
    this.profileId = profileId;
    this.cause = cause;
  }
}

function isExpired(credentials, now = Date.now()) {
  if (!credentials || typeof credentials.expires !== "number") return true;
  return credentials.expires - EXPIRY_LEEWAY_MS <= now;
}

async function refreshAndPersist({ profileId, profile, options, refresherOverride }) {
  const refresher = refresherOverride ?? REFRESHERS[profile.provider];
  if (!refresher) {
    throw new AuthRefreshFailedError(
      profileId,
      new Error(`No refresh handler registered for provider: ${profile.provider}`)
    );
  }
  const refreshToken = profile.credentials?.refresh;
  if (!refreshToken) {
    throw new AuthRefreshFailedError(
      profileId,
      new Error("Profile has no refresh token; re-run login.")
    );
  }
  let refreshed;
  try {
    refreshed = await refresher(refreshToken);
  } catch (error) {
    throw new AuthRefreshFailedError(profileId, error);
  }
  await updateAuthProfile(
    profileId,
    () => ({ provider: profile.provider, mode: "oauth", credentials: refreshed }),
    options
  );
  return refreshed;
}

/**
 * Return a fresh, non-expired credential bundle for the given profile.
 * Refreshes (and persists) the credentials in place if the access token is
 * within `EXPIRY_LEEWAY_MS` of expiring. Concurrent callers within the same
 * process share a single refresh.
 *
 * @param {string} profileId
 * @param {{ cwd?: string; homeDir?: string; pathOverride?: string; force?: boolean; refresher?: (refreshToken: string) => Promise<{ access: string; refresh: string; expires: number; accountId?: string }> }} [options]
 * @returns {Promise<{ access: string; refresh: string; expires: number; accountId?: string }>}
 */
export async function getValidCredentials(profileId, options = {}) {
  const { force, refresher: refresherOverride, ...storeOptions } = options;
  const profile = await readAuthProfile(profileId, storeOptions);
  if (!profile) throw new AuthProfileMissingError(profileId);
  if (profile.mode !== "oauth" || !profile.credentials) {
    throw new AuthRefreshFailedError(
      profileId,
      new Error(`Profile "${profileId}" is not an OAuth profile (mode: ${profile.mode}).`)
    );
  }

  if (!force && !isExpired(profile.credentials)) return profile.credentials;

  let inFlight = inFlightRefreshes.get(profileId);
  if (!inFlight) {
    inFlight = refreshAndPersist({ profileId, profile, options: storeOptions, refresherOverride })
      .finally(() => {
        inFlightRefreshes.delete(profileId);
      });
    inFlightRefreshes.set(profileId, inFlight);
  }
  return inFlight;
}

export { AuthProfileMissingError, AuthRefreshFailedError, EXPIRY_LEEWAY_MS };
