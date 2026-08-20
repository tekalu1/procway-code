// TK-6: tests for the Markdown transcript renderer + writer.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  renderTranscriptMarkdown,
  writeTranscriptMarkdown,
  transcriptPath
} from "../src/session/transcript-md.mjs";
import { saveSessionState } from "../src/session/store.mjs";

let tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })));
  tempDirs = [];
});

async function makeHome() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "procway-transcript-"));
  tempDirs.push(dir);
  return dir;
}

describe("renderTranscriptMarkdown", () => {
  it("renders You / Assistant / Tool sections in order", () => {
    const md = renderTranscriptMarkdown({
      sessionId: "s-1",
      messages: [
        { role: "user", content: "ヘルプ" },
        { role: "assistant", content: "了解しました。" },
        {
          role: "assistant",
          content: [
            { kind: "tool_use", toolCallId: "tc-1", name: "read_file", args: { filePath: "/x.md" } }
          ]
        },
        { role: "tool", toolCallId: "tc-1", content: [{ kind: "tool_result", ok: true, result: "ファイル本文" }] }
      ]
    });
    // Frontmatter-style header lines
    expect(md).toContain("sessionId: `s-1`");
    expect(md).toContain("messageCount: 4");
    // Section order: user → assistant text → tool calls → tool result
    const userIdx = md.indexOf("## You");
    const assistantIdx = md.indexOf("## Assistant\n");
    const toolCallsIdx = md.indexOf("## Assistant — tool calls");
    const toolResultIdx = md.indexOf("## Tool result");
    expect(userIdx).toBeGreaterThan(-1);
    expect(assistantIdx).toBeGreaterThan(userIdx);
    expect(toolCallsIdx).toBeGreaterThan(assistantIdx);
    expect(toolResultIdx).toBeGreaterThan(toolCallsIdx);
    // Tool-use args are JSON-fenced
    expect(md).toContain("`read_file`");
    expect(md).toContain('"filePath": "/x.md"');
    // Tool result body lands somewhere
    expect(md).toContain("ファイル本文");
  });

  it("truncates oversized blocks and points at events.jsonl for the full payload", () => {
    const blob = "x".repeat(10000);
    const md = renderTranscriptMarkdown({
      sessionId: "s-2",
      messages: [{ role: "assistant", content: blob }],
      maxBlockChars: 200
    });
    expect(md).toMatch(/\[truncated \d+ chars — see events\.jsonl/);
    // Ensure we didn't embed the full 10KB body.
    expect(md.length).toBeLessThan(blob.length);
  });

  it("renders an empty placeholder when there are no projected messages", () => {
    const md = renderTranscriptMarkdown({ sessionId: "s-3", messages: [] });
    expect(md).toContain("_(no messages projected)_");
  });

  it("fences multi-line user/tool bodies but keeps single-line bodies inline", () => {
    const md = renderTranscriptMarkdown({
      sessionId: "s-4",
      messages: [
        { role: "user", content: "short" },
        { role: "user", content: "line1\nline2\nline3" }
      ]
    });
    // First "## You" body is inline (no fence right under it).
    const firstYou = md.indexOf("## You\n\n");
    expect(md.slice(firstYou, firstYou + 30)).toContain("short");
    // Second "## You" body should be fenced.
    expect(md).toMatch(/## You\n\n```+\nline1\nline2\nline3\n```+/);
  });
});

describe("writeTranscriptMarkdown", () => {
  it("writes transcript.md inside the session dir and returns the byte count", async () => {
    const homeDir = await makeHome();
    const res = await writeTranscriptMarkdown({
      homeDir,
      sessionId: "s-write",
      messages: [{ role: "user", content: "hi" }]
    });
    expect(res.filePath).toBe(transcriptPath({ homeDir, sessionId: "s-write" }));
    expect(res.bytes).toBeGreaterThan(0);
    const body = await readFile(res.filePath, "utf8");
    expect(body).toContain("## You");
    expect(body).toContain("hi");
  });

  it("skips when encryptionKey is set so plaintext doesn't leak", async () => {
    const homeDir = await makeHome();
    const res = await writeTranscriptMarkdown({
      homeDir,
      sessionId: "s-enc",
      messages: [{ role: "user", content: "secret" }],
      encryptionKey: Buffer.alloc(32, 7)
    });
    expect(res.skipped).toBe("encrypted-session");
    expect(existsSync(res.filePath)).toBe(false);
  });
});

describe("saveSessionState integration", () => {
  it("emits transcript.md next to snapshot.json on every save", async () => {
    const homeDir = await makeHome();
    await saveSessionState({
      homeDir,
      sessionId: "s-save",
      state: {
        sessionId: "s-save",
        provider: "openrouter",
        model: "deepseek/deepseek-v4-pro",
        cwd: "/proj",
        updatedAt: "2026-01-01T00:00:00.000Z",
        messages: [
          { role: "user", content: "test prompt" },
          { role: "assistant", content: "test reply" }
        ]
      }
    });
    const tPath = transcriptPath({ homeDir, sessionId: "s-save" });
    expect(existsSync(tPath)).toBe(true);
    const body = await readFile(tPath, "utf8");
    expect(body).toContain("sessionId: `s-save`");
    expect(body).toContain("test prompt");
    expect(body).toContain("test reply");
    // Meta details should leak through so the reviewer can sanity-check the run.
    expect(body).toContain("openrouter");
    expect(body).toContain("deepseek/deepseek-v4-pro");
  });

  it("renders a wake turn as an automatic-resume section, never a bodiless `## You`", () => {
    // event-wake (issue #143): the injected turn is a user-role message whose
    // whole body is a <system-reminder>. It used to project as a `user` node
    // with "" text, which rendered as a `## You` heading with nothing under it.
    const md = renderTranscriptMarkdown({
      sessionId: "s-wake",
      messages: [
        { role: "user", content: "start the run" },
        {
          role: "user",
          wake: true,
          content: "<system-reminder>\nAUTOMATIC RESUME — this is NOT a message from the user.\nSettled (1):\n- run r-1 — completed\n</system-reminder>"
        },
        { role: "assistant", content: "the run finished." }
      ]
    });
    expect(md).toContain("## Automatic resume");
    expect(md).toContain("Background work settled");
    // The body is kept for the reviewer, but not under a "You" heading.
    expect(md).toContain("AUTOMATIC RESUME");
    expect(md.match(/## You/g)).toHaveLength(1);
    expect(md).not.toMatch(/## You\n\n\n/);
  });

  it("does not emit transcript.md when the session is encrypted", async () => {
    const homeDir = await makeHome();
    await saveSessionState({
      homeDir,
      sessionId: "s-save-enc",
      encryptionKey: Buffer.alloc(32, 9),
      state: {
        sessionId: "s-save-enc",
        provider: "openrouter",
        model: "deepseek/deepseek-v4-pro",
        cwd: "/proj",
        updatedAt: "2026-01-01T00:00:00.000Z",
        messages: [{ role: "user", content: "secret" }]
      }
    });
    const tPath = transcriptPath({ homeDir, sessionId: "s-save-enc" });
    expect(existsSync(tPath)).toBe(false);
  });
});
