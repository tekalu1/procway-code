/**
 * attach_file tool — push a workspace file UP into the dashboard attachment
 * store over the single HTTP transport, so it renders in the conversation and
 * reflects to connected surfaces. Surface-agnostic counterpart of
 * save_attachment (no channel / no surface in the call).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { attachFile } from "../src/tools/attach-file.mjs";
import { executeToolCall, getToolDefinitions, isMutationTool } from "../src/tools/registry.mjs";

let tmpDir;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "attach-file-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  delete process.env.PROCWAY_DASHBOARD_URL;
  delete process.env.PROCWAY_PROXY_TOKEN;
  delete process.env.PROCWAY_SESSION_ID;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// The upload endpoint replies with the minted { id, mime, bytes }.
function fakeUpload(body = { id: "att-new", mime: "image/png", bytes: 5 }) {
  return vi.fn(async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  }));
}

describe("attachFile", () => {
  it("uploads a workspace file with the session token and returns an outbound attachment", async () => {
    await writeFile(path.join(tmpDir, "chart.png"), "bytes");
    const fetchFn = fakeUpload({ id: "att-1", mime: "image/png", bytes: 5 });
    const result = await attachFile({
      filePath: "chart.png",
      cwd: tmpDir,
      dashboardUrl: "http://dash.local",
      proxyToken: "tok-1",
      sessionId: "sess-1",
      fetchImpl: fetchFn
    });
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("http://dash.local/api/ai/attachments");
    expect(init.method).toBe("POST");
    expect(init.headers["x-procway-session"]).toBe("tok-1");
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get("sessionId")).toBe("sess-1");
    expect(result.kind).toBe("attach_file");
    expect(result.data).toMatchObject({ id: "att-1", name: "chart.png", mime: "image/png", bytes: 5 });
    // The hint that the orchestrator turns into an attachment_ref block + event.
    expect(result.outboundAttachments).toEqual([{ id: "att-1", mime: "image/png", name: "chart.png" }]);
  });

  it("honors an explicit name and infers a sensible mime for known extensions", async () => {
    await writeFile(path.join(tmpDir, "data.csv"), "a,b,c");
    const fetchFn = fakeUpload({ id: "att-2", mime: "text/csv", bytes: 5 });
    const result = await attachFile({
      filePath: "data.csv",
      name: "export.csv",
      cwd: tmpDir,
      dashboardUrl: "http://dash.local",
      fetchImpl: fetchFn
    });
    const [, init] = fetchFn.mock.calls[0];
    const filePart = init.body.get("file");
    expect(filePart).toBeInstanceOf(Blob);
    expect(filePart.type).toBe("text/csv");
    expect(result.data.name).toBe("export.csv");
  });

  it("rejects a source escaping the workspace without uploading", async () => {
    const fetchFn = fakeUpload();
    await expect(attachFile({
      filePath: "../outside.bin",
      cwd: tmpDir,
      dashboardUrl: "http://dash.local",
      fetchImpl: fetchFn
    })).rejects.toThrow(/escapes workspace/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("requires filePath, an existing file, and surfaces upload failures", async () => {
    await expect(attachFile({ cwd: tmpDir, dashboardUrl: "http://d" }))
      .rejects.toThrow(/filePath is required/);
    await expect(attachFile({ filePath: "missing.png", cwd: tmpDir, dashboardUrl: "http://d" }))
      .rejects.toThrow(/File not found/);
    await writeFile(path.join(tmpDir, "x.png"), "b");
    const failing = vi.fn(async () => new Response("nope", { status: 500 }));
    await expect(attachFile({
      filePath: "x.png", cwd: tmpDir, dashboardUrl: "http://dash.local", fetchImpl: failing
    })).rejects.toThrow(/attachment upload failed: 500/);
  });
});

describe("attach_file registry wiring", () => {
  it("registers the tool and classifies it as a mutation", () => {
    const names = getToolDefinitions().map((t) => t.function.name);
    expect(names).toContain("attach_file");
    expect(isMutationTool("attach_file")).toBe(true);
  });

  it("executes through the approval gate and returns the outbound attachment", async () => {
    process.env.PROCWAY_DASHBOARD_URL = "http://dash.local";
    await writeFile(path.join(tmpDir, "report.pdf"), "pdfbytes");
    vi.stubGlobal("fetch", fakeUpload({ id: "att-9", mime: "application/pdf", bytes: 8 }));
    const result = await executeToolCall({
      name: "attach_file",
      args: { filePath: "report.pdf" },
      cwd: tmpDir,
      settings: { approvalMode: "always-ask", tools: {} },
      approvalRequester: async () => true
    });
    expect(result.kind).toBe("attach_file");
    expect(result.data).toMatchObject({ id: "att-9", mime: "application/pdf" });
    expect(result.outboundAttachments[0].id).toBe("att-9");
  });

  it("returns a skipped result when approval is denied", async () => {
    process.env.PROCWAY_DASHBOARD_URL = "http://dash.local";
    await writeFile(path.join(tmpDir, "a.bin"), "x");
    const fetchFn = fakeUpload();
    vi.stubGlobal("fetch", fetchFn);
    const result = await executeToolCall({
      name: "attach_file",
      args: { filePath: "a.bin" },
      cwd: tmpDir,
      settings: { approvalMode: "always-ask", tools: {} },
      approvalRequester: async () => false
    });
    expect(result.data.skipped).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
