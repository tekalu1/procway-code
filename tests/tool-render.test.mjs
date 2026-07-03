import { describe, expect, it } from "vitest";
import { renderToolCall, summariseToolHeader, plainText } from "../src/adapters/tui/tool-render.mjs";

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
    expect(plain).toContain("> tool: run_shell(command=\"pnpm test\")");
    expect(plain).toContain("tests 185 passed");
    expect(plain).toContain("line-1");
    expect(plain).toContain("more lines, type :show");
    expect(plain).not.toContain("line-20");
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
    expect(plain).toContain("Edit(path=missing.txt) ✗");
    expect(plain).toContain("Edit failed: file not found");
  });

  it("summariseToolHeader truncates long task strings", () => {
    const long = "x".repeat(200);
    const header = summariseToolHeader({ name: "spawn_agent", args: { task: long } });
    expect(header).toContain("spawn_agent(task=");
    expect(header.length).toBeLessThanOrEqual(80);
    expect(header).toContain("…");
  });
});
