import { describe, expect, it } from "vitest";
import { EventBus } from "../src/core/events/bus.mjs";
import {
  approvalQuestion,
  attachApprovalPrompt,
  normalizeApprovalAnswer,
  renderApprovalRequest
} from "../src/adapters/tui/approval-prompt.mjs";
import { visibleWidth } from "../src/adapters/tui/ansi.mjs";

function makeSession() {
  const events = new EventBus();
  const decisions = [];
  return {
    events,
    decisions,
    approve: (requestId, decision) => decisions.push([requestId, decision])
  };
}

async function settle() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

describe("approval prompt presentation (P3b-6)", () => {
  it("names the tool, the target and every key", () => {
    const panel = renderApprovalRequest({
      kind: "write_file",
      summary: "src/foo.mjs",
      payload: { filePath: "src/foo.mjs" },
      color: false
    });
    expect(panel).toContain("▌ Approval required");
    expect(panel).toContain("write_file");
    expect(panel).toContain("src/foo.mjs");
    // The legend is the whole point: `a` and `e` were undocumented.
    expect(panel).toContain("[a] always allow this tool for the session");
    expect(panel).toContain("[e] edit the payload, then approve");
  });

  it("states the default in the question", () => {
    expect(approvalQuestion({ kind: "run_shell", color: false })).toContain("(default n)");
  });

  it("fits a narrow terminal", () => {
    const panel = renderApprovalRequest({
      kind: "run_shell",
      summary: "pnpm test",
      payload: { command: "pnpm test --reporter verbose --coverage --run" },
      width: 50,
      color: false
    });
    for (const line of panel.split("\n")) expect(visibleWidth(line)).toBeLessThanOrEqual(50);
  });
});

describe("approval answers", () => {
  it("maps the documented keys and their long forms", () => {
    expect(normalizeApprovalAnswer("y")).toBe("allow");
    expect(normalizeApprovalAnswer(" YES ")).toBe("allow");
    expect(normalizeApprovalAnswer("n")).toBe("deny");
    expect(normalizeApprovalAnswer("a")).toBe("always-allow");
    expect(normalizeApprovalAnswer("e")).toBe("edit");
    expect(normalizeApprovalAnswer("")).toBe("deny");
    expect(normalizeApprovalAnswer("yolo")).toBe("invalid");
  });

  // The regression: any unrecognised answer used to be a silent deny, so a
  // typo cost you the tool call.
  it("re-asks on an unrecognised answer instead of denying", async () => {
    const session = makeSession();
    const asked = [];
    const answers = ["yy", "wat", "y"];
    attachApprovalPrompt({
      session,
      output: { write() {}, columns: 80 },
      prompt: async ({ question }) => { asked.push(question); return answers.shift(); }
    });
    session.events.emit({ type: "approval.requested", kind: "write_file", summary: "x", requestId: "req-1", payload: {} });
    await settle();
    expect(asked).toHaveLength(3);
    expect(session.decisions).toEqual([["req-1", "allow"]]);
  });

  it("gives up after a run of bad answers rather than looping forever", async () => {
    const session = makeSession();
    let asked = 0;
    attachApprovalPrompt({
      session,
      output: { write() {}, columns: 80 },
      prompt: async () => { asked += 1; return "???"; }
    });
    session.events.emit({ type: "approval.requested", kind: "write_file", summary: "x", requestId: "req-2", payload: {} });
    await settle();
    expect(asked).toBe(5);
    expect(session.decisions).toEqual([["req-2", "deny"]]);
  });

  it("takes the stated default on an empty answer, without re-asking", async () => {
    const session = makeSession();
    let asked = 0;
    attachApprovalPrompt({
      session,
      output: { write() {}, columns: 80 },
      prompt: async () => { asked += 1; return ""; }
    });
    session.events.emit({ type: "approval.requested", kind: "run_shell", summary: "x", requestId: "req-3", payload: {} });
    await settle();
    expect(asked).toBe(1);
    expect(session.decisions).toEqual([["req-3", "deny"]]);
  });

  it("denies when the prompt is cancelled (Ctrl+C at the overlay)", async () => {
    const session = makeSession();
    attachApprovalPrompt({
      session,
      output: { write() {}, columns: 80 },
      prompt: async () => { throw Object.assign(new Error("Aborted with Ctrl+C"), { name: "AbortError" }); }
    });
    session.events.emit({ type: "approval.requested", kind: "write_file", summary: "x", requestId: "req-4", payload: {} });
    await settle();
    expect(session.decisions).toEqual([["req-4", "deny"]]);
  });

  it("prints the panel and the diff before asking", async () => {
    const session = makeSession();
    let written = "";
    attachApprovalPrompt({
      session,
      output: { write(value) { written += value; }, columns: 80 },
      prompt: async () => "n"
    });
    session.events.emit({
      type: "approval.requested",
      kind: "write_file",
      summary: "src/a.txt",
      requestId: "req-5",
      payload: { filePath: "src/a.txt", before: "old\n", after: "new\n", operation: "update" }
    });
    await settle();
    expect(written).toContain("Approval required");
    expect(written).toContain("src/a.txt");
    expect(written).toContain("-old");
    expect(written).toContain("+new");
  });
});
