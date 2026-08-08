/**
 * Tests for the Jira/Confluence MCP tools (Phase G1 C-1/C-2/C-3).
 *
 * Strategy: stub global fetch so the integration clients hit our
 * recorded responses. The connections file is materialized in a tmp
 * workspace so the auth helper reads real credentials.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { executeToolCall, getToolDefinitions, isMutationTool } from "../src/tools/registry.mjs";

let tmpDir;

async function writeConnections(file) {
  await writeFile(path.join(tmpDir, ".procway-connections.json"), JSON.stringify({ version: 1, ...file }), "utf8");
  await chmod(path.join(tmpDir, ".procway-connections.json"), 0o600).catch(() => {});
}

function mockFetch(handler) {
  const fn = vi.fn(async (url, init) => handler(url, init));
  vi.stubGlobal("fetch", fn);
  return fn;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "mcp-integ-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  delete process.env.PROCWAY_WORKSPACE_URI;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function exec(name, args, settings = { approvalMode: "auto-readonly", tools: {} }) {
  return executeToolCall({
    name, args, cwd: tmpDir, settings,
    approvalRequester: async () => true,
  });
}

describe("MCP tool registry — Jira/Confluence definitions", () => {
  it("registers the expected jira_* and confluence_* tools", () => {
    const names = getToolDefinitions().map((t) => t.function.name);
    expect(names).toEqual(expect.arrayContaining([
      "jira_list_projects", "jira_search_issues", "jira_get_issue", "jira_list_transitions",
      "jira_create_issue", "jira_update_issue", "jira_add_comment", "jira_transition_issue",
      "confluence_list_spaces", "confluence_search", "confluence_get_page",
      "confluence_create_page", "confluence_update_page",
    ]));
  });

  it("classifies read tools as non-mutation, write tools as mutation", () => {
    expect(isMutationTool("jira_search_issues")).toBe(false);
    expect(isMutationTool("jira_get_issue")).toBe(false);
    expect(isMutationTool("confluence_search")).toBe(false);
    expect(isMutationTool("jira_create_issue")).toBe(true);
    expect(isMutationTool("jira_add_comment")).toBe(true);
    expect(isMutationTool("confluence_update_page")).toBe(true);
  });
});

describe("MCP tool execution — Jira (read)", () => {
  it("jira_search_issues hits /rest/api/3/search/jql with the JQL body", async () => {
    await writeConnections({
      jira: { kind: "oauth-3lo", accessToken: "tok", refreshToken: null, expiresAt: null,
        cloudId: "abc", siteUrl: "https://team.atlassian.net", scopes: [], savedAt: "x" },
    });
    const fetchFn = mockFetch((url, init) => {
      expect(url).toBe("https://api.atlassian.com/ex/jira/abc/rest/api/3/search/jql");
      const body = JSON.parse(init.body);
      expect(body.jql).toBe("project = PROJ");
      return json({ issues: [{ key: "PROJ-1", fields: { summary: "x", status: { name: "Open" }, updated: "2026-05-24" } }] });
    });
    const res = await exec("jira_search_issues", { jql: "project = PROJ" });
    expect(fetchFn).toHaveBeenCalled();
    expect(res.kind).toBe("mcp")
    expect(res.data.tool).toBe("jira_search_issues")
    expect(res.data.count).toBe(1)
    expect(res.data.results[0].key).toBe("PROJ-1")
    expect(res.data.results[0].url).toBe("https://team.atlassian.net/browse/PROJ-1")
  });
});

describe("MCP tool execution — Jira (write through approval gate)", () => {
  it("jira_create_issue creates the issue and refetches the detail", async () => {
    await writeConnections({
      jira: { kind: "oauth-3lo", accessToken: "tok", refreshToken: null, expiresAt: null,
        cloudId: "abc", siteUrl: "https://team.atlassian.net", scopes: [], savedAt: "x" },
    });
    let bodySent;
    mockFetch((url, init) => {
      if (url.endsWith("/rest/api/3/issue") && init?.method === "POST") {
        bodySent = JSON.parse(init.body);
        return json({ key: "PROJ-9" }, 201);
      }
      if (url.includes("/rest/api/3/issue/PROJ-9")) {
        return json({
          key: "PROJ-9",
          fields: { summary: "x", status: { name: "To Do" }, updated: "2026-05-24",
            created: "2026-05-01", issuetype: { name: "Task" } },
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    const res = await exec("jira_create_issue", {
      projectKey: "PROJ", summary: "x", description: "line", issueTypeName: "Task",
    });
    expect(res.data.key).toBe("PROJ-9");
    expect(bodySent.fields.issuetype).toEqual({ name: "Task" });
    expect(bodySent.fields.description.type).toBe("doc");
  });

  it("denies write when approval gate returns false", async () => {
    await writeConnections({
      jira: { kind: "oauth-3lo", accessToken: "tok", refreshToken: null, expiresAt: null,
        cloudId: "abc", siteUrl: "x", scopes: [], savedAt: "x" },
    });
    const fetchFn = mockFetch(() => json({}, 200));
    const res = await executeToolCall({
      name: "jira_add_comment", args: { key: "PROJ-1", body: "hi" },
      cwd: tmpDir, settings: { approvalMode: "always-ask", tools: {} },
      approvalRequester: async () => false,
    });
    expect(res.data.skipped).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("MCP tool execution — error mapping", () => {
  it("returns NOT_CONNECTED (not a thrown error) when no credential is stored", async () => {
    // no connections file at all
    const res = await exec("jira_search_issues", { jql: "x" });
    expect(res.data.skipped).toBe(true);
    expect(res.data.code).toBe("NOT_CONNECTED");
    expect(res.data.connectionId).toBe("jira");
  });

  it("finds the connections file via PROCWAY_WORKSPACE_URI when cwd is unrelated", async () => {
    // Simulate the runtime container: connections file lives in a
    // separate workspace volume, and cwd (e.g. /opt/ai-agent) doesn't
    // contain it. The env var is the source of truth.
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "mcp-ws-"));
    try {
      await writeFile(
        path.join(workspaceDir, ".procway-connections.json"),
        JSON.stringify({
          version: 1,
          jira: { kind: "oauth-3lo", accessToken: "tok", refreshToken: null,
            expiresAt: null, cloudId: "abc", siteUrl: "https://team.atlassian.net",
            scopes: [], savedAt: "x" },
        }),
        "utf8",
      );
      process.env.PROCWAY_WORKSPACE_URI = `file://${workspaceDir}`;
      mockFetch(() => json({ issues: [] }));
      const res = await exec("jira_search_issues", { jql: "x" });
      expect(res.data.skipped).toBeUndefined();
      expect(res.data.tool).toBe("jira_search_issues");
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("walks up from cwd to find the connections file in an ancestor", async () => {
    const subDir = path.join(tmpDir, "projects", "demo", "backlogs", "TK-1");
    const fs = await import("node:fs/promises");
    await fs.mkdir(subDir, { recursive: true });
    await writeConnections({
      jira: { kind: "oauth-3lo", accessToken: "tok", refreshToken: null,
        expiresAt: null, cloudId: "abc", siteUrl: "x", scopes: [], savedAt: "x" },
    });
    mockFetch(() => json({ issues: [] }));
    const res = await executeToolCall({
      name: "jira_search_issues", args: { jql: "x" },
      cwd: subDir, settings: { approvalMode: "auto-readonly", tools: {} },
      approvalRequester: async () => true,
    });
    expect(res.data.skipped).toBeUndefined();
  });

  it("returns PROVIDER_ERROR with the upstream status on non-2xx", async () => {
    await writeConnections({
      jira: { kind: "oauth-3lo", accessToken: "tok", refreshToken: null, expiresAt: null,
        cloudId: "abc", siteUrl: "x", scopes: [], savedAt: "x" },
    });
    mockFetch(() => new Response("forbidden", { status: 403 }));
    const res = await exec("jira_get_issue", { key: "PROJ-1" });
    expect(res.data.skipped).toBe(true);
    expect(res.data.code).toBe("PROVIDER_ERROR");
    expect(res.data.providerStatus).toBe(403);
  });
});

describe("MCP tool execution — Confluence", () => {
  it("confluence_get_page hits content endpoint and returns bodyStorage", async () => {
    await writeConnections({
      confluence: { kind: "oauth-3lo", accessToken: "tok", refreshToken: null, expiresAt: null,
        cloudId: "abc", siteUrl: "https://team.atlassian.net", scopes: [], savedAt: "x" },
    });
    mockFetch((url) => {
      expect(url).toContain("/ex/confluence/abc/wiki/rest/api/content/123");
      return json({
        id: "123", title: "Hi", type: "page",
        space: { key: "DOCS" }, version: { number: 5 },
        body: { storage: { value: "<p>hello</p>" } },
        _links: { webui: "/spaces/DOCS/pages/123" },
      });
    });
    const res = await exec("confluence_get_page", { pageId: "123" });
    expect(res.data.bodyStorage).toBe("<p>hello</p>");
    expect(res.data.title).toBe("Hi");
    expect(res.data.version).toBe(5);
  });

  it("confluence_update_page fetches current version internally and sends version+1", async () => {
    await writeConnections({
      confluence: { kind: "oauth-3lo", accessToken: "tok", refreshToken: null, expiresAt: null,
        cloudId: "abc", siteUrl: "x", scopes: [], savedAt: "x" },
    });
    let putBody;
    mockFetch((url, init) => {
      if (init?.method === "PUT") {
        putBody = JSON.parse(init.body);
        return new Response(null, { status: 204 });
      }
      // GET (twice: once before update for current version, once after for confirmation)
      return json({
        id: "p1", title: "Old", type: "page",
        space: { key: "S" }, version: { number: 3 },
        body: { storage: { value: "<p>old</p>" } },
        _links: { webui: "/x" },
      });
    });
    await exec("confluence_update_page", { pageId: "p1", title: "New", bodyText: "fresh" });
    expect(putBody.version.number).toBe(4);
    expect(putBody.title).toBe("New");
    expect(putBody.body.storage.value).toContain("fresh");
  });
});

const SLACK_CONN = {
  slack: { kind: "oauth-bot", accessToken: "xoxb-test", refreshToken: null, expiresAt: null,
    scopes: ["chat:write"], teamId: "T123", teamName: "Acme", botUserId: "U999", savedAt: "x" },
};

describe("MCP tool registry — Slack definitions", () => {
  it("registers the expected slack_* tools", () => {
    const names = getToolDefinitions().map((t) => t.function.name);
    expect(names).toEqual(expect.arrayContaining([
      "slack_list_channels", "slack_read_channel", "slack_read_thread", "slack_post_message",
    ]));
  });

  it("classifies slack reads as non-mutation, post as mutation", () => {
    expect(isMutationTool("slack_list_channels")).toBe(false);
    expect(isMutationTool("slack_read_channel")).toBe(false);
    expect(isMutationTool("slack_read_thread")).toBe(false);
    expect(isMutationTool("slack_post_message")).toBe(true);
  });
});

describe("MCP tool execution — Slack", () => {
  it("slack_list_channels hits conversations.list with the bot token", async () => {
    await writeConnections(SLACK_CONN);
    const fetchFn = mockFetch((url, init) => {
      expect(url).toContain("https://slack.com/api/conversations.list");
      expect(init.headers.Authorization).toBe("Bearer xoxb-test");
      return json({ ok: true, channels: [
        { id: "C1", name: "general", is_private: false, num_members: 12, topic: { value: "hello" } },
      ] });
    });
    const res = await exec("slack_list_channels", {});
    expect(fetchFn).toHaveBeenCalled();
    expect(res.data.count).toBe(1);
    expect(res.data.results[0]).toMatchObject({ id: "C1", name: "general", topic: "hello" });
  });

  it("slack_read_channel resolves #name to id and returns oldest-first messages", async () => {
    await writeConnections(SLACK_CONN);
    mockFetch((url) => {
      if (url.includes("conversations.list")) {
        return json({ ok: true, channels: [{ id: "C42", name: "dev" }] });
      }
      expect(url).toContain("conversations.history");
      expect(url).toContain("channel=C42");
      return json({ ok: true, has_more: false, messages: [
        { ts: "2.0", user: "U2", text: "newer" },
        { ts: "1.0", user: "U1", text: "older", reply_count: 3 },
      ] });
    });
    const res = await exec("slack_read_channel", { channel: "#dev" });
    expect(res.data.channel).toBe("C42");
    expect(res.data.messages.map((m) => m.text)).toEqual(["older", "newer"]);
    expect(res.data.messages[0].replyCount).toBe(3);
  });

  it("slack_read_thread hits conversations.replies with ts", async () => {
    await writeConnections(SLACK_CONN);
    mockFetch((url) => {
      expect(url).toContain("conversations.replies");
      expect(url).toContain("ts=1.0");
      return json({ ok: true, messages: [
        { ts: "1.0", user: "U1", text: "parent", thread_ts: "1.0" },
        { ts: "1.1", user: "U2", text: "reply", thread_ts: "1.0" },
      ] });
    });
    const res = await exec("slack_read_thread", { channel: "C42", threadTs: "1.0" });
    expect(res.data.threadTs).toBe("1.0");
    expect(res.data.messages).toHaveLength(2);
  });

  it("slack_post_message posts through the approval gate with thread_ts", async () => {
    await writeConnections(SLACK_CONN);
    let postBody;
    mockFetch((url, init) => {
      expect(url).toContain("chat.postMessage");
      postBody = JSON.parse(init.body);
      return json({ ok: true, channel: "C42", ts: "9.0" });
    });
    const res = await exec("slack_post_message", { channel: "C42", text: "hi", threadTs: "1.0" });
    expect(postBody).toMatchObject({ channel: "C42", text: "hi", thread_ts: "1.0" });
    expect(res.data.ts).toBe("9.0");
  });

  it("maps Slack ok:false (HTTP 200) to PROVIDER_ERROR", async () => {
    await writeConnections(SLACK_CONN);
    mockFetch(() => json({ ok: false, error: "channel_not_found" }));
    const res = await exec("slack_read_channel", { channel: "C404" });
    expect(res.data.skipped).toBe(true);
    expect(res.data.code).toBe("PROVIDER_ERROR");
    expect(res.data.error).toContain("channel_not_found");
  });

  it("returns NOT_CONNECTED when no slack credential is stored", async () => {
    await writeConnections({});
    const res = await exec("slack_list_channels", {});
    expect(res.data.skipped).toBe(true);
    expect(res.data.code).toBe("NOT_CONNECTED");
    expect(res.data.connectionId).toBe("slack");
  });
});

const DISCORD_CONN = {
  discord: { kind: "bot-install", guildId: "900000000000000001", guildName: "Acme Guild",
    botUserId: "900000000000000009", applicationId: "app1", savedAt: "x" },
};

const GUILD_CHANNELS = [
  { id: "900000000000000101", name: "general", type: 0, position: 0, topic: "hello" },
  { id: "900000000000000102", name: "dev", type: 0, position: 1, topic: null },
  { id: "900000000000000103", name: "lobby", type: 2, position: 2 }, // voice — filtered out
];

describe("MCP tool execution — Discord (broker mode)", () => {
  beforeEach(() => {
    process.env.PROCWAY_DASHBOARD_URL = "http://dash.test:3000";
    process.env.PROCWAY_PROXY_TOKEN = "ptok-123";
  });
  afterEach(() => {
    delete process.env.PROCWAY_DASHBOARD_URL;
    delete process.env.PROCWAY_PROXY_TOKEN;
  });

  it("registers the expected discord_* tools", () => {
    const names = getToolDefinitions().map((t) => t.function.name);
    expect(names).toEqual(expect.arrayContaining([
      "discord_list_channels", "discord_read_channel", "discord_read_thread", "discord_post_message",
    ]));
  });

  it("classifies discord reads as non-mutation, post as mutation", () => {
    expect(isMutationTool("discord_list_channels")).toBe(false);
    expect(isMutationTool("discord_read_channel")).toBe(false);
    expect(isMutationTool("discord_read_thread")).toBe(false);
    expect(isMutationTool("discord_post_message")).toBe(true);
  });

  it("discord_list_channels rides the dashboard broker with the proxy token and filters to text channels", async () => {
    await writeConnections(DISCORD_CONN);
    const fetchFn = mockFetch((url, init) => {
      expect(url).toBe("http://dash.test:3000/api/integrations/discord/guilds/900000000000000001/channels");
      expect(init.headers.Authorization).toBe("Bearer ptok-123");
      return json(GUILD_CHANNELS);
    });
    const res = await exec("discord_list_channels", {});
    expect(fetchFn).toHaveBeenCalled();
    expect(res.data.count).toBe(2); // voice channel dropped
    expect(res.data.results[0]).toMatchObject({ id: "900000000000000101", name: "general", type: "text", topic: "hello" });
  });

  it("discord_read_channel resolves #name via guild channels and returns oldest-first messages", async () => {
    await writeConnections(DISCORD_CONN);
    mockFetch((url) => {
      if (url.includes("/guilds/")) return json(GUILD_CHANNELS);
      expect(url).toContain("/channels/900000000000000102/messages");
      expect(url).toContain("limit=20");
      return json([
        { id: "2", author: { id: "u2", username: "beta" }, content: "newer", timestamp: "t2" },
        { id: "1", author: { id: "u1", username: "alpha" }, content: "older", timestamp: "t1" },
      ]);
    });
    const res = await exec("discord_read_channel", { channel: "#dev" });
    expect(res.data.channel).toBe("900000000000000102");
    expect(res.data.messages.map((m) => m.content)).toEqual(["older", "newer"]);
    expect(res.data.messages[0].author.username).toBe("alpha");
  });

  it("discord_read_thread reads the thread id as a channel", async () => {
    await writeConnections(DISCORD_CONN);
    mockFetch((url) => {
      expect(url).toContain("/channels/900000000000000555/messages");
      return json([
        { id: "11", author: { id: "u1" }, content: "reply", timestamp: "t2" },
        { id: "10", author: { id: "u1" }, content: "parent", timestamp: "t1" },
      ]);
    });
    const res = await exec("discord_read_thread", { threadId: "900000000000000555" });
    expect(res.data.threadId).toBe("900000000000000555");
    expect(res.data.messages.map((m) => m.content)).toEqual(["parent", "reply"]);
  });

  it("discord_post_message splits >2000 chars into sequential chunked posts", async () => {
    await writeConnections(DISCORD_CONN);
    const posted = [];
    mockFetch((url, init) => {
      expect(url).toContain("/channels/900000000000000101/messages");
      expect(init.method).toBe("POST");
      posted.push(JSON.parse(init.body).content);
      return json({ id: `m${posted.length}` });
    });
    const long = "line\n".repeat(500); // 2500 chars
    const res = await exec("discord_post_message", { channel: "900000000000000101", text: long });
    expect(posted).toHaveLength(2);
    expect(posted[0].length).toBeLessThanOrEqual(2000);
    expect(posted.join("\n").replace(/\n+/g, "\n")).toContain("line");
    expect(res.data.messageId).toBe("m1");
    expect(res.data.chunks).toBe(2);
    expect(res.data.lastMessageId).toBe("m2");
  });

  it("discord_post_message posts into a thread when threadId is given", async () => {
    await writeConnections(DISCORD_CONN);
    mockFetch((url, init) => {
      expect(url).toContain("/channels/900000000000000555/messages");
      expect(JSON.parse(init.body).content).toBe("hi");
      return json({ id: "m9" });
    });
    const res = await exec("discord_post_message", { threadId: "900000000000000555", text: "hi" });
    expect(res.data.channel).toBe("900000000000000555");
    expect(res.data.messageId).toBe("m9");
  });

  it("relays broker guild-scope rejections as PROVIDER_ERROR", async () => {
    await writeConnections(DISCORD_CONN);
    mockFetch(() => json({ error: { code: "CHANNEL_OUT_OF_SCOPE" } }, 403));
    const res = await exec("discord_read_channel", { channel: "900000000000000999" });
    expect(res.data.skipped).toBe(true);
    expect(res.data.code).toBe("PROVIDER_ERROR");
    expect(res.data.providerStatus).toBe(403);
  });

  it("returns NOT_CONNECTED when no discord credential is stored", async () => {
    await writeConnections({});
    const res = await exec("discord_list_channels", {});
    expect(res.data.skipped).toBe(true);
    expect(res.data.code).toBe("NOT_CONNECTED");
    expect(res.data.connectionId).toBe("discord");
  });
});

describe("MCP tool execution — Discord (standalone bot-token mode)", () => {
  it("hits discord.com directly with the Bot token", async () => {
    await writeConnections({
      discord: { kind: "bot-token", botToken: "bot-secret", guildId: "900000000000000001", savedAt: "x" },
    });
    const fetchFn = mockFetch((url, init) => {
      expect(url).toBe("https://discord.com/api/v10/guilds/900000000000000001/channels");
      expect(init.headers.Authorization).toBe("Bot bot-secret");
      return json(GUILD_CHANNELS);
    });
    const res = await exec("discord_list_channels", {});
    expect(fetchFn).toHaveBeenCalled();
    expect(res.data.count).toBe(2);
  });
});

// Outbound file delivery to Slack moved off the runtime: files are attached via
// the surface-agnostic attach_file tool (Phase 1-2) and reflected to Slack by
// the dashboard mirror (Phase 3). The former slack_upload_file tool was
// removed; its dashboard replacement is covered by
// dashboard/server/services/slack-mirror.service.test.ts.
