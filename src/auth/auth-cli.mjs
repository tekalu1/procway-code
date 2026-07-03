import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { exec } from "node:child_process";
import { loginOpenAICodex, OPENAI_CODEX_OAUTH_CONSTANTS } from "./oauth/openai-codex.mjs";
import {
  deleteAuthProfile,
  readAuthProfile,
  readAuthProfilesStore,
  writeOAuthProfile
} from "./token-store.mjs";

const DEFAULT_PROFILE_FOR_PROVIDER = {
  codex: "codex",
  "openai-codex": "codex"
};

const PROVIDER_ALIASES = {
  codex: "openai-codex",
  "openai-codex": "openai-codex"
};

function printHelp() {
  output.write(`Usage:
  procway-code auth login [provider] [--profile <id>] [--originator <name>]
      provider defaults to "codex" (alias for openai-codex).
      profile defaults to the provider's canonical id.

  procway-code auth status [profile]
      Show stored credentials (no secrets printed). Lists all profiles when
      no id is given.

  procway-code auth logout <profile>
      Remove the stored credentials for the profile.
`);
}

function tryOpenBrowser(url) {
  const command =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  return new Promise((resolve) => {
    exec(command, (error) => {
      resolve(!error);
    });
  });
}

function maskAccountId(id) {
  if (typeof id !== "string" || id.length === 0) return "(none)";
  if (id.length <= 8) return id;
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

function formatExpires(ms) {
  if (typeof ms !== "number") return "(unknown)";
  const remaining = ms - Date.now();
  const iso = new Date(ms).toISOString();
  if (remaining <= 0) return `${iso} (expired)`;
  const minutes = Math.round(remaining / 60_000);
  return `${iso} (in ${minutes}m)`;
}

async function handleLogin({ positional, options, cwd }) {
  const providerArg = positional[0] ?? "codex";
  const provider = PROVIDER_ALIASES[providerArg];
  if (!provider) {
    throw new Error(`Unknown OAuth provider: ${providerArg}. Supported: ${Object.keys(PROVIDER_ALIASES).join(", ")}`);
  }
  const profileId = options.profile ?? DEFAULT_PROFILE_FOR_PROVIDER[providerArg];
  const originator = options.originator ?? OPENAI_CODEX_OAUTH_CONSTANTS.DEFAULT_ORIGINATOR;

  output.write(`Starting OAuth login for ${provider} (profile: ${profileId}, originator: ${originator})...\n`);

  // Defer readline until the manual-paste fallback actually fires. Creating it
  // up-front attaches a stdin listener that keeps the Node event loop alive
  // even after the browser callback succeeds, so the CLI never exits.
  let rl = null;
  const ensureReadline = () => {
    if (!rl) rl = readline.createInterface({ input, output });
    return rl;
  };

  let credentials;
  try {
    credentials = await loginOpenAICodex({
      originator,
      onAuth: async ({ url, instructions }) => {
        output.write(`\nAuthorize URL:\n  ${url}\n`);
        if (instructions) output.write(`${instructions}\n`);
        const opened = await tryOpenBrowser(url);
        if (!opened) {
          output.write("(Couldn't open a browser automatically — copy the URL above.)\n");
        }
        output.write("\nWaiting for the browser callback... (Ctrl+C to abort)\n");
      },
      onPrompt: async ({ message }) => {
        const answer = await ensureReadline().question(`\n${message}\n> `);
        return answer.trim();
      },
      onProgress: (message) => {
        output.write(`${message}\n`);
      }
    });
  } finally {
    rl?.close();
  }

  const { filePath } = await writeOAuthProfile(profileId, provider, credentials, { cwd });
  output.write(`\nLogged in. Saved to ${filePath}\n`);
  output.write(`  profile:   ${profileId}\n`);
  output.write(`  provider:  ${provider}\n`);
  output.write(`  accountId: ${maskAccountId(credentials.accountId)}\n`);
  output.write(`  expires:   ${formatExpires(credentials.expires)}\n`);
}

async function handleStatus({ positional, cwd }) {
  if (positional[0]) {
    const profileId = positional[0];
    const profile = await readAuthProfile(profileId, { cwd });
    if (!profile) {
      output.write(`No profile found: ${profileId}\n`);
      process.exitCode = 1;
      return;
    }
    printProfileLine(profileId, profile);
    return;
  }
  const { filePath, store } = await readAuthProfilesStore({ cwd });
  const ids = Object.keys(store.profiles);
  output.write(`auth-profiles.json: ${filePath}\n`);
  if (ids.length === 0) {
    output.write("(no profiles stored)\n");
    return;
  }
  output.write("\n");
  for (const id of ids) {
    printProfileLine(id, store.profiles[id]);
  }
}

function printProfileLine(id, profile) {
  const credentials = profile.credentials ?? {};
  output.write(`profile: ${id}\n`);
  output.write(`  provider:  ${profile.provider}\n`);
  output.write(`  mode:      ${profile.mode}\n`);
  output.write(`  accountId: ${maskAccountId(credentials.accountId)}\n`);
  output.write(`  expires:   ${formatExpires(credentials.expires)}\n`);
  if (profile.updatedAt) output.write(`  updated:   ${profile.updatedAt}\n`);
}

async function handleLogout({ positional, cwd }) {
  const profileId = positional[0];
  if (!profileId) throw new Error("Usage: procway-code auth logout <profile>");
  const before = await readAuthProfile(profileId, { cwd });
  if (!before) {
    output.write(`No profile to remove: ${profileId}\n`);
    return;
  }
  await deleteAuthProfile(profileId, { cwd });
  output.write(`Removed profile: ${profileId}\n`);
}

/**
 * Entry point invoked by cli.mjs when the user runs `procway-code auth ...`.
 *
 * @param {{ positional: string[]; options: Record<string, string>; cwd: string }} ctx
 */
export async function handleAuthCommand({ positional, options, cwd }) {
  const [subcommand, ...rest] = positional;
  if (!subcommand || subcommand === "help" || subcommand === "-h" || subcommand === "--help") {
    printHelp();
    return;
  }
  switch (subcommand) {
    case "login":
      return handleLogin({ positional: rest, options, cwd });
    case "status":
      return handleStatus({ positional: rest, cwd });
    case "logout":
      return handleLogout({ positional: rest, cwd });
    default:
      throw new Error(`Unknown auth subcommand: ${subcommand}. Run 'procway-code auth help' for usage.`);
  }
}
