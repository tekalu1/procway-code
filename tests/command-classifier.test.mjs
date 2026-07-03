import { describe, expect, it } from "vitest";
import { classifyCommand, detectTaskArtifactWrite, isLongRunningCommand } from "../src/safety/command-classifier.mjs";

describe("classifyCommand", () => {
  it("marks destructive commands as approval-required", () => {
    const result = classifyCommand("git reset --hard HEAD");
    expect(result.approvalRequired).toBe(true);
    expect(result.reasons).toContain("destructive");
  });

  it("allows simple read-only commands", () => {
    const result = classifyCommand("git status --short");
    expect(result.approvalRequired).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  it("marks force push as destructive and networked", () => {
    const result = classifyCommand("git push --force origin main");
    expect(result.approvalRequired).toBe(true);
    expect(result.reasons).toContain("destructive");
    expect(result.reasons).toContain("network");
  });

  it("marks pipes and cmd shells as redirection", () => {
    expect(classifyCommand("git status | Out-String").reasons).toContain("redirection");
    expect(classifyCommand("cmd /c del file.txt").reasons).toContain("redirection");
  });

  it("marks platform package installers as dependency installs", () => {
    const result = classifyCommand("winget install Git.Git");
    expect(result.approvalRequired).toBe(true);
    expect(result.reasons).toContain("dependency-install");
  });

  it("flags shell writes to a task memo path as task-artifact-write", () => {
    const result = classifyCommand("echo hello > backlogs/TK-9/tasks/plan-todo/memo.md");
    expect(result.reasons).toContain("task-artifact-write");
  });
});

describe("detectTaskArtifactWrite", () => {
  it("detects POSIX redirect to memo.md", () => {
    const match = detectTaskArtifactWrite("cat <<'EOF' > backlogs/TK-9/tasks/plan-todo/memo.md\nhi\nEOF");
    expect(match).toMatchObject({ kind: "memo", verb: "redirect" });
  });

  it("detects PowerShell Set-Content / Out-File", () => {
    expect(detectTaskArtifactWrite("Set-Content -Encoding utf8 backlogs/TK-9/tasks/lpt/memo.md 'x'"))
      .toMatchObject({ kind: "memo", verb: "powershell-write" });
    expect(detectTaskArtifactWrite("'x' | Out-File -Encoding utf8 backlogs\\TK-9\\tasks\\lpt\\memo.md"))
      .toMatchObject({ kind: "memo", verb: "powershell-write" });
  });

  it("detects writes into evidence/ and report/", () => {
    expect(detectTaskArtifactWrite("tee backlogs/TK-1/tasks/foo/evidence/screenshot.txt"))
      .toMatchObject({ kind: "evidence", verb: "tee" });
    expect(detectTaskArtifactWrite("echo x > backlogs/TK-1/tasks/foo/report/result.md"))
      .toMatchObject({ kind: "report", verb: "redirect" });
  });

  it("does NOT flag reads or `task put` invocations", () => {
    expect(detectTaskArtifactWrite("cat backlogs/TK-9/tasks/lpt/memo.md")).toBeNull();
    expect(detectTaskArtifactWrite(
      `node "$PROCWAY_CLI" task put procway TK-9 plan-todo memo --content 'x'`
    )).toBeNull();
  });

  it("does NOT flag mentions of the path in echo content (no write verb on the path)", () => {
    // `> /tmp/log` is a write, but the artifact path is just inside the echoed
    // string, so the redirect doesn't target the artifact and we shouldn't
    // block it.
    expect(detectTaskArtifactWrite("echo 'see backlogs/TK-9/tasks/lpt/memo.md' > /tmp/log"))
      .toBeNull();
  });

  it("ignores non-string / empty inputs", () => {
    expect(detectTaskArtifactWrite("")).toBeNull();
    expect(detectTaskArtifactWrite(null)).toBeNull();
    expect(detectTaskArtifactWrite(undefined)).toBeNull();
  });
});

describe("isLongRunningCommand", () => {
  it("detects the run loop / task / next drives via PROCWAY_CLI", () => {
    expect(isLongRunningCommand('node "$PROCWAY_CLI" run loop TK-8 --project popism-v2')).toBe(true);
    expect(isLongRunningCommand("node $PROCWAY_CLI run task TK-8 plan-todo")).toBe(true);
    // run next is the same single-task drive as run task (both POST /api/run/next)
    expect(isLongRunningCommand('node "$PROCWAY_CLI" run next TK-8')).toBe(true);
  });

  it("detects the bare procway binary form", () => {
    expect(isLongRunningCommand("procway run loop TK-1")).toBe(true);
    expect(isLongRunningCommand("pnpm procway run task TK-1 impl")).toBe(true);
  });

  it("does NOT flag other procway subcommands or unrelated commands", () => {
    expect(isLongRunningCommand('node "$PROCWAY_CLI" task put procway TK-9 plan-todo memo --content x')).toBe(false);
    expect(isLongRunningCommand("procway run --help")).toBe(false);
    expect(isLongRunningCommand("npm run loop")).toBe(false);
    expect(isLongRunningCommand("git status")).toBe(false);
  });

  it("does not let a chained command ride in on the relaxed budget", () => {
    // the `run loop` is in a separate segment after `&&`, so the procway anchor
    // and the run-loop token are not in the same segment → not long-running.
    expect(isLongRunningCommand("ls && echo run loop")).toBe(false);
    // a trailing destructive segment after the loop must not extend the match
    expect(isLongRunningCommand('node "$PROCWAY_CLI" run loop TK-8 && rm -rf /')).toBe(true);
  });

  it("ignores non-string / empty inputs", () => {
    expect(isLongRunningCommand("")).toBe(false);
    expect(isLongRunningCommand(null)).toBe(false);
    expect(isLongRunningCommand(undefined)).toBe(false);
  });
});
