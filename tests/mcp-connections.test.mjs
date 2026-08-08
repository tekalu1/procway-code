import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConnectionsMcpServers } from "../src/mcp/connections-servers.mjs";

let cwd;
const SAVED_WORKSPACE_URI = process.env.PROCWAY_WORKSPACE_URI;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "procway-mcp-conn-"));
  // Pin resolution to the tmp dir (the env takes precedence over cwd walk-up,
  // which could otherwise find a stray file above os.tmpdir()).
  process.env.PROCWAY_WORKSPACE_URI = cwd;
});

afterEach(async () => {
  if (SAVED_WORKSPACE_URI === undefined) delete process.env.PROCWAY_WORKSPACE_URI;
  else process.env.PROCWAY_WORKSPACE_URI = SAVED_WORKSPACE_URI;
  await rm(cwd, { recursive: true, force: true });
});

async function writeSnapshot(rows) {
  await writeFile(path.join(cwd, ".procway-connections.json"), JSON.stringify({ version: 1, ...rows }));
}

const remoteRow = (overrides = {}) => ({
  kind: "mcp-remote",
  label: "Linear",
  transport: "http",
  baseUrl: "https://mcp.linear.app/mcp",
  headers: { "X-Team": "eng" },
  auth: "headers",
  enabled: true,
  savedAt: "2026-07-01T00:00:00.000Z",
  ...overrides
});

describe("loadConnectionsMcpServers", () => {
  it("returns {} when the snapshot is missing", async () => {
    expect(await loadConnectionsMcpServers(cwd)).toEqual({});
  });

  it("maps mcp:<slug> rows to mcpServers-shaped configs keyed by slug", async () => {
    await writeSnapshot({
      "mcp:linear": remoteRow(),
      github: { kind: "oauth-device", accessToken: "tok" } // builtin rows ignored
    });
    const servers = await loadConnectionsMcpServers(cwd);
    expect(Object.keys(servers)).toEqual(["linear"]);
    expect(servers.linear).toMatchObject({
      transport: "http",
      baseUrl: "https://mcp.linear.app/mcp",
      headers: { "X-Team": "eng" }
    });
    expect(typeof servers.linear.authProvider).toBe("function");
  });

  it("injects the OAuth access token as an Authorization header", async () => {
    await writeSnapshot({
      "mcp:oauthy": remoteRow({
        auth: "oauth",
        headers: undefined,
        oauth: { tokenEndpoint: "https://as.example.com/token", clientId: "c", accessToken: "at-1", refreshToken: null }
      })
    });
    const servers = await loadConnectionsMcpServers(cwd);
    expect(servers.oauthy.headers.Authorization).toBe("Bearer at-1");
  });

  it("skips disabled, malformed-slug and wrong-kind rows", async () => {
    const logger = { warn: vi.fn() };
    await writeSnapshot({
      "mcp:off": remoteRow({ enabled: false }),
      "mcp:bad_slug": remoteRow(),
      "mcp:wrong-kind": { kind: "api-token", token: "x" },
      "mcp:no-url": remoteRow({ baseUrl: "" }),
      "mcp:good": remoteRow()
    });
    const servers = await loadConnectionsMcpServers(cwd, { logger });
    expect(Object.keys(servers)).toEqual(["good"]);
    // disabled rows are silent; the three malformed rows warn
    expect(logger.warn).toHaveBeenCalledTimes(3);
  });

  it("sse transport is passed through; anything else normalizes to http", async () => {
    await writeSnapshot({
      "mcp:legacy": remoteRow({ transport: "sse" }),
      "mcp:odd": remoteRow({ transport: "stdio" })
    });
    const servers = await loadConnectionsMcpServers(cwd);
    expect(servers.legacy.transport).toBe("sse");
    expect(servers.odd.transport).toBe("http"); // never stdio from a snapshot
  });

  it("authProvider re-reads the snapshot for fresh credentials", async () => {
    await writeSnapshot({
      "mcp:oauthy": remoteRow({
        auth: "oauth",
        headers: undefined,
        oauth: { tokenEndpoint: "https://as.example.com/token", clientId: "c", accessToken: "old", refreshToken: null }
      })
    });
    const servers = await loadConnectionsMcpServers(cwd);
    expect(servers.oauthy.headers.Authorization).toBe("Bearer old");

    // Dashboard refresh sweep rewrites the snapshot…
    await writeSnapshot({
      "mcp:oauthy": remoteRow({
        auth: "oauth",
        headers: undefined,
        oauth: { tokenEndpoint: "https://as.example.com/token", clientId: "c", accessToken: "new", refreshToken: null }
      })
    });
    // …and the transport's next authProvider call picks it up.
    expect((await servers.oauthy.authProvider()).Authorization).toBe("Bearer new");
  });

  it("authProvider degrades to {} when the row disappears", async () => {
    await writeSnapshot({ "mcp:linear": remoteRow() });
    const servers = await loadConnectionsMcpServers(cwd);
    await writeSnapshot({});
    expect(await servers.linear.authProvider()).toEqual({});
  });
});
