import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectDirectives, expandInput, decodeShellBytes } from "../src/adapters/tui/input-preprocessor.mjs";

let cwd;
beforeEach(async () => { cwd = await mkdtemp(path.join(os.tmpdir(), "procway-input-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

describe("detectDirectives", () => {
  it("recognises @<path> file references", () => {
    const directives = detectDirectives("Compare @src/index.mjs to @docs/spec.md");
    expect(directives.files.map((entry) => entry.filePath)).toEqual(["src/index.mjs", "docs/spec.md"]);
    expect(directives.commands).toHaveLength(0);
  });

  it("recognises !<command> shell references", () => {
    const directives = detectDirectives("Match !pnpm output");
    expect(directives.commands.map((entry) => entry.command)).toContain("pnpm");
    const fenced = detectDirectives("Run !`pnpm test --watch=false` once");
    expect(fenced.commands.map((entry) => entry.command)).toContain("pnpm test --watch=false");
  });
});

describe("expandInput", () => {
  it("inlines file contents", async () => {
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(path.join(cwd, "src", "tiny.mjs"), "export const value = 42;\n", "utf8");
    const { expanded, attached } = await expandInput({
      line: "Take a look at @src/tiny.mjs and improve it.",
      cwd
    });
    expect(expanded).toContain("[Attached: src/tiny.mjs");
    expect(expanded).toContain("export const value = 42;");
    expect(attached).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "file", ref: "src/tiny.mjs" })
    ]));
  });

  it("captures shell output via the runner injection", async () => {
    const runShellImpl = async ({ command }) => ({ exitCode: 0, stdout: `executed ${command}`, stderr: "" });
    const { expanded, attached } = await expandInput({
      line: "Verify with !`pnpm test`",
      cwd,
      runShellImpl
    });
    expect(expanded).toContain("[Shell: pnpm test (exit 0)]");
    expect(expanded).toContain("executed pnpm test");
    expect(attached.some((entry) => entry.kind === "shell")).toBe(true);
  });

  it("reports an error when the file does not exist", async () => {
    const { expanded, attached } = await expandInput({
      line: "@no/such/file.mjs",
      cwd
    });
    expect(expanded).toContain("error:");
    expect(attached[0].error).toBeTruthy();
  });

  it("blocks shell expansion when permissions deny the command", async () => {
    let invoked = 0;
    const runShellImpl = async () => { invoked += 1; return { exitCode: 0, stdout: "", stderr: "" }; };
    const { expanded, attached } = await expandInput({
      line: "!`rm -rf /`",
      cwd,
      runShellImpl,
      permissions: {
        deny: ["run_shell:rm -rf *"],
        ask: [],
        allow: []
      }
    });
    expect(invoked).toBe(0);
    expect(expanded).toContain("(exit 126)");
    expect(expanded).toContain("permissions denied");
    expect(attached[0]).toMatchObject({ kind: "shell", exitCode: 126, blocked: true });
  });

  it("invokes approvalRequester for ask-rated commands and rejects when user denies", async () => {
    let approvals = 0;
    const runShellImpl = async () => ({ exitCode: 0, stdout: "ran", stderr: "" });
    const { attached } = await expandInput({
      line: "!`pnpm test`",
      cwd,
      runShellImpl,
      permissions: { deny: [], allow: [], ask: ["run_shell:*"] },
      approvalRequester: async () => { approvals += 1; return false; }
    });
    expect(approvals).toBe(1);
    expect(attached[0]).toMatchObject({ kind: "shell", exitCode: 126, blocked: true });
  });

  it("runs the command when approvalRequester returns true", async () => {
    let invoked = 0;
    const runShellImpl = async () => { invoked += 1; return { exitCode: 0, stdout: "done", stderr: "" }; };
    const { expanded, attached } = await expandInput({
      line: "!`pnpm test`",
      cwd,
      runShellImpl,
      permissions: { deny: [], allow: [], ask: ["run_shell:*"] },
      approvalRequester: async () => true
    });
    expect(invoked).toBe(1);
    expect(expanded).toContain("[Shell: pnpm test (exit 0)]");
    expect(attached[0]).toMatchObject({ kind: "shell", exitCode: 0, blocked: false });
  });

  it("exposes stdout / stderr on attached shell entries so the CLI can echo them to the user", async () => {
    const runShellImpl = async () => ({ exitCode: 0, stdout: "hello\n", stderr: "warn\n" });
    const { attached } = await expandInput({
      line: "!`echo hello`",
      cwd,
      runShellImpl,
      permissions: { allow: ["run_shell:*"] }
    });
    expect(attached[0].stdout).toBe("hello\n");
    expect(attached[0].stderr).toBe("warn\n");
  });
});

describe("decodeShellBytes (Windows OEM codepage fallback)", () => {
  it("decodes UTF-8 bytes as-is on any platform", () => {
    const buf = Buffer.from("hello 世界", "utf8");
    expect(decodeShellBytes(buf, "linux")).toBe("hello 世界");
    expect(decodeShellBytes(buf, "darwin")).toBe("hello 世界");
    expect(decodeShellBytes(buf, "win32")).toBe("hello 世界");
  });

  it("returns empty string for empty buffer", () => {
    expect(decodeShellBytes(Buffer.alloc(0))).toBe("");
    expect(decodeShellBytes(null)).toBe("");
  });

  it("falls back to Shift-JIS on Windows when UTF-8 decode produces replacement chars", () => {
    // CP932 bytes for "ボリューム" (volume label header from `dir` output)
    const sjis = Buffer.from([0x83, 0x7B, 0x83, 0x8A, 0x83, 0x85, 0x81, 0x5B, 0x83, 0x80]);
    expect(decodeShellBytes(sjis, "win32")).toBe("ボリューム");
  });

  it("does NOT fall back on POSIX even if UTF-8 decode is invalid", () => {
    const sjis = Buffer.from([0x83, 0x7B, 0x83, 0x8A]);
    const result = decodeShellBytes(sjis, "linux");
    expect(result).toContain("�");   // stays as replacement chars on Linux
  });
});
