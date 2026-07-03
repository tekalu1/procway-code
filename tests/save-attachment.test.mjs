/**
 * save_attachment tool — materialize a dashboard attachment into the
 * workspace over the single HTTP transport (issue #76 follow-up: the model
 * could SEE hydrated images but had no way to touch the actual file).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { saveAttachment } from "../src/tools/save-attachment.mjs";
import { executeToolCall, getToolDefinitions, isMutationTool } from "../src/tools/registry.mjs";

let tmpDir;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "save-att-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  delete process.env.PROCWAY_DASHBOARD_URL;
  delete process.env.PROCWAY_PROXY_TOKEN;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function fakeFetch(bodyText = "file-bytes", type = "text/plain") {
  return vi.fn(async () => new Response(bodyText, {
    status: 200,
    headers: { "content-type": type }
  }));
}

describe("saveAttachment", () => {
  it("fetches by id with the session token and writes inside the workspace", async () => {
    const fetchFn = fakeFetch("hello attachment", "image/png");
    const result = await saveAttachment({
      attachmentId: "att-1",
      filePath: "out/orig.png",
      cwd: tmpDir,
      dashboardUrl: "http://dash.local",
      proxyToken: "tok-1",
      fetchImpl: fetchFn
    });
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("http://dash.local/api/ai/attachments/att-1");
    expect(init.headers["x-procway-session"]).toBe("tok-1");
    expect(result.kind).toBe("save_attachment");
    expect(result.data).toMatchObject({ bytes: 16, mime: "image/png" });
    expect(await readFile(path.join(tmpDir, "out/orig.png"), "utf8")).toBe("hello attachment");
  });

  it("rejects a destination escaping the workspace without fetching", async () => {
    const fetchFn = fakeFetch();
    await expect(saveAttachment({
      attachmentId: "att-1",
      filePath: "../outside.bin",
      cwd: tmpDir,
      dashboardUrl: "http://dash.local",
      fetchImpl: fetchFn
    })).rejects.toThrow(/escapes workspace/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("requires attachmentId and surfaces fetch failures", async () => {
    await expect(saveAttachment({ filePath: "a.bin", cwd: tmpDir, dashboardUrl: "http://d" }))
      .rejects.toThrow(/attachmentId is required/);
    const notFound = vi.fn(async () => new Response("nope", { status: 404 }));
    await expect(saveAttachment({
      attachmentId: "att-x", filePath: "a.bin", cwd: tmpDir,
      dashboardUrl: "http://dash.local", fetchImpl: notFound
    })).rejects.toThrow(/attachment fetch failed: 404/);
  });
});

describe("save_attachment registry wiring", () => {
  it("registers the tool and classifies it as a mutation", () => {
    const names = getToolDefinitions().map((t) => t.function.name);
    expect(names).toContain("save_attachment");
    expect(isMutationTool("save_attachment")).toBe(true);
  });

  it("executes through the approval gate and writes the file", async () => {
    process.env.PROCWAY_DASHBOARD_URL = "http://dash.local";
    vi.stubGlobal("fetch", fakeFetch("via-registry", "application/pdf"));
    const result = await executeToolCall({
      name: "save_attachment",
      args: { attachmentId: "att-9", filePath: "docs/report.pdf" },
      cwd: tmpDir,
      settings: { approvalMode: "auto-readonly", tools: {} },
      approvalRequester: async () => true
    });
    expect(result.data).toMatchObject({ mime: "application/pdf" });
    expect(await readFile(path.join(tmpDir, "docs/report.pdf"), "utf8")).toBe("via-registry");
  });

  it("returns a skipped result when approval is denied", async () => {
    process.env.PROCWAY_DASHBOARD_URL = "http://dash.local";
    const fetchFn = fakeFetch();
    vi.stubGlobal("fetch", fetchFn);
    const result = await executeToolCall({
      name: "save_attachment",
      args: { attachmentId: "att-9", filePath: "a.bin" },
      cwd: tmpDir,
      settings: { approvalMode: "always-ask", tools: {} },
      approvalRequester: async () => false
    });
    expect(result.data.skipped).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
