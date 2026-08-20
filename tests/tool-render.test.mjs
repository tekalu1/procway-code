import { describe, expect, it } from "vitest";
import {
  renderToolCall,
  summariseToolHeader,
  plainText,
  TOOL_PREVIEW_LINES,
  TOOL_RESULT_MAX_CHARS
} from "../src/adapters/tui/tool-render.mjs";

describe("tool-render adapter", () => {
  it("collapses a long shell run into a header + previewLines summary", () => {
    const lines = Array.from({ length: 20 }, (_, idx) => `line-${idx + 1}`).join("\n");
    const rendered = renderToolCall({
      name: "run_shell",
      args: { command: "pnpm test" },
      ok: true,
      previewLines: 5,
      result: {
        kind: "run_shell",
        summary: "tests 185 passed",
        data: { command: "pnpm test", stdout: lines, stderr: "" }
      }
    });
    const plain = plainText(rendered);
    expect(plain).toContain("✓ run_shell(command=\"pnpm test\")");
    expect(plain).toContain("tests 185 passed");
    expect(plain).toContain("line-1");
    expect(plain).toContain("more lines");
    expect(plain).not.toContain("line-20");
    // ":show" is not an implemented command — never advertise it (P1-4).
    expect(plain).not.toContain(":show");
  });

  it("renders a read_file result with content body and size summary", () => {
    const rendered = renderToolCall({
      name: "read_file",
      args: { filePath: "src/index.mjs" },
      result: {
        kind: "read_file",
        summary: "Read 1.2 KB from src/index.mjs",
        data: { path: "src/index.mjs", content: "export const ok = 1;\n", truncated: false }
      },
      previewLines: 10
    });
    const plain = plainText(rendered);
    expect(plain).toContain("read_file(path=src/index.mjs)");
    expect(plain).toContain("Read 1.2 KB from src/index.mjs");
    expect(plain).toContain("export const ok = 1;");
  });

  it("renders failed tool calls with the ✗ marker", () => {
    const rendered = renderToolCall({
      name: "Edit",
      args: { filePath: "missing.txt" },
      ok: false,
      result: {
        kind: "edit",
        summary: "Edit failed: file not found",
        data: { error: "ENOENT" }
      }
    });
    const plain = plainText(rendered);
    expect(plain).toContain("✗ Edit(path=missing.txt)");
    expect(plain).toContain("Edit failed: file not found");
  });

  it("summariseToolHeader truncates long task strings", () => {
    const long = "x".repeat(200);
    const header = summariseToolHeader({ name: "spawn_agent", args: { task: long } });
    expect(header).toContain("spawn_agent(task=");
    expect(header.length).toBeLessThanOrEqual(80);
    expect(header).toContain("…");
  });

  it("summariseToolHeader omits empty parentheses for argument-less tools", () => {
    expect(summariseToolHeader({ name: "unknown_tool", args: {} })).toBe("unknown_tool");
  });

  // Issue #142 — background children.
  it("marks a background spawn_agent in the header and shows the jobId to wait on", () => {
    const args = { task: "audit the config loader", runInBackground: true };
    expect(summariseToolHeader({ name: "spawn_agent", args })).toContain("background");
    const rendered = renderToolCall({
      name: "spawn_agent",
      args,
      result: {
        kind: "spawn_agent",
        summary: "Child agent started in background: audit the config loader",
        data: { jobId: "9f2c1b7e-aaaa-bbbb-cccc-ddddeeeeffff", status: "running", background: true, task: "audit the config loader" }
      }
    });
    const plain = plainText(rendered);
    expect(plain).toContain("spawn_agent(task=\"audit the config loader\", background)");
    expect(plain).toContain("Child agent started in background");
    expect(plain).toContain("jobId=9f2c1b7e-aaaa-bbbb-cccc-ddddeeeeffff");
    expect(plain).toContain("agent_job");
  });

  it("renders an agent_job wait with the collected child text", () => {
    const rendered = renderToolCall({
      name: "agent_job",
      args: { action: "wait", jobId: "9f2c1b7e-aaaa-bbbb-cccc-ddddeeeeffff" },
      result: {
        kind: "spawn_agent",
        summary: "child 9f2c1b7e: completed: found 3 issues",
        data: { tool: "agent_wait", jobId: "9f2c1b7e-aaaa-bbbb-cccc-ddddeeeeffff", status: "completed", text: "found 3 issues" }
      }
    });
    const plain = plainText(rendered);
    expect(plain).toContain("agent_job(action=wait, job=9f2c1b7e)");
    expect(plain).toContain("child 9f2c1b7e: completed");
    expect(plain).toContain("found 3 issues");
  });

  it("renders an agent_job list as one line per child", () => {
    const rendered = renderToolCall({
      name: "agent_job",
      args: { action: "list" },
      result: {
        kind: "spawn_agent",
        summary: "2 child agent job(s), 1 running",
        data: {
          tool: "agent_list",
          running: 1,
          jobs: [
            { jobId: "aaaaaaaa-1111", status: "running", task: "audit config" },
            { jobId: "bbbbbbbb-2222", status: "completed", task: "audit docs" }
          ]
        }
      }
    });
    const plain = plainText(rendered);
    expect(plain).toContain("agent_job(action=list)");
    expect(plain).toContain("- aaaaaaaa running — audit config");
    expect(plain).toContain("- bbbbbbbb completed — audit docs");
  });

  it("surfaces an agent_job error body (unknown / out-of-scope jobId)", () => {
    const rendered = renderToolCall({
      name: "agent_job",
      args: { action: "status", jobId: "nope" },
      ok: false,
      result: {
        kind: "spawn_agent",
        summary: "Unknown child agent jobId: nope",
        data: { tool: "agent_status", jobId: "nope", error: "jobId not found" }
      }
    });
    const plain = plainText(rendered);
    expect(plain).toContain("✗ agent_job(action=status, job=nope)");
    expect(plain).toContain("(error) jobId not found");
  });

  describe("live (result-less) case — P1-6", () => {
    it("renders a start line with the same signature as the completed line", () => {
      const args = { command: "pnpm test" };
      const start = plainText(renderToolCall({ name: "run_shell", args, status: "start" })).trimEnd();
      const done = plainText(renderToolCall({ name: "run_shell", args, status: "ok" })).trimEnd();
      expect(start).toBe('● run_shell(command="pnpm test")');
      expect(done).toBe('✓ run_shell(command="pnpm test")');
      expect(start.slice(1)).toBe(done.slice(1));
    });

    it("renders an error marker for a failed live call", () => {
      const out = plainText(renderToolCall({ name: "list_files", args: {}, status: "error" })).trimEnd();
      expect(out).toBe("✗ list_files(dir=.)");
    });

    it("falls back to the bare tool name when no arguments are known", () => {
      expect(plainText(renderToolCall({ name: "some_tool", status: "start" })).trimEnd()).toBe("● some_tool");
    });
  });

  describe("clipping defaults — P1-4", () => {
    it("clips to TOOL_PREVIEW_LINES by default and counts the remainder", () => {
      const body = Array.from({ length: 100 }, (_, idx) => `l${idx}`).join("\n");
      const plain = plainText(renderToolCall({
        name: "read_file",
        args: { filePath: "x" },
        result: { kind: "read_file", summary: "Read x", data: { content: body } }
      }));
      const bodyLines = plain.split("\n").filter((line) => line.startsWith("  "));
      expect(bodyLines.length).toBe(TOOL_PREVIEW_LINES + 1);
      expect(plain).toContain(`… (${101 - TOOL_PREVIEW_LINES} more lines)`);
    });

    it("caps a single enormous line at TOOL_RESULT_MAX_CHARS", () => {
      const plain = plainText(renderToolCall({
        name: "read_file",
        args: { filePath: "x" },
        result: { kind: "read_file", summary: "Read x", data: { content: "y".repeat(100_000) } }
      }));
      expect(plain.length).toBeLessThan(TOOL_RESULT_MAX_CHARS + 200);
      expect(plain).toContain("… (truncated)");
    });

    it("expanded:true shows every line", () => {
      const body = Array.from({ length: 30 }, (_, idx) => `l${idx}`).join("\n");
      const plain = plainText(renderToolCall({
        name: "read_file",
        args: { filePath: "x" },
        expanded: true,
        maxChars: null,
        result: { kind: "read_file", summary: "Read x", data: { content: body } }
      }));
      expect(plain).toContain("l29");
      expect(plain).not.toContain("more lines");
    });
  });

  it("colorize:false emits no ANSI", () => {
    const out = renderToolCall({ name: "run_shell", args: { command: "ls" }, status: "ok", colorize: false });
    expect(out).not.toContain("\x1b[");
  });
});
