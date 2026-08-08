import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderSessionRecap, printSessionRecap } from "../src/adapters/tui/session-recap.mjs";
import { swapActiveSession, disposeSessionRenderers } from "../src/adapters/tui/session-swap.mjs";
import { attachInterruptHandler } from "../src/adapters/tui/interrupt.mjs";
import { stripAnsi } from "../src/adapters/tui/ansi.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(here, "..", "src", "cli.mjs");

function makeSession(overrides = {}) {
  return {
    sessionId: "sess-abc",
    settings: {
      defaultProvider: "openai-main",
      approvalMode: "auto-readonly",
      providers: { "openai-main": { defaultModel: "gpt-5.4" } }
    },
    messages: [
      { role: "system", content: "hidden prompt" },
      { role: "user", content: "run the tests" },
      {
        role: "assistant",
        content: [{ kind: "tool_use", toolCallId: "c1", name: "run_shell", args: { command: "pnpm test" } }]
      },
      {
        role: "tool",
        toolCallId: "c1",
        content: [{
          kind: "tool_result",
          toolCallId: "c1",
          ok: true,
          result: { kind: "run_shell", summary: "Ran: pnpm test (exit 0)", data: { stdout: "137 passed\n", stderr: "" } }
        }]
      },
      { role: "assistant", content: "All green." }
    ],
    ...overrides
  };
}

describe("renderSessionRecap (P1-5)", () => {
  it("prints the welcome card for the session being replayed", () => {
    const plain = stripAnsi(renderSessionRecap({ session: makeSession(), cwd: "/w" }));
    expect(plain).toContain("procway-code");
    expect(plain).toContain("sess-abc");
    expect(plain).toContain("openai-main:gpt-5.4");
    expect(plain).toContain("auto-readonly");
  });

  it("replays the conversation with tool calls resolved, not raw JSON", () => {
    const plain = stripAnsi(renderSessionRecap({ session: makeSession(), cwd: "/w" }));
    expect(plain).toContain("You: run the tests");
    expect(plain).toContain('✓ run_shell(command="pnpm test")');
    expect(plain).toContain("Ran: pnpm test (exit 0)");
    expect(plain).toContain("Assistant:");
    expect(plain).toContain("All green.");
    expect(plain).not.toContain('{"kind":"run_shell"');
    expect(plain).not.toContain("hidden prompt");
  });

  it("can skip the welcome card", () => {
    const plain = stripAnsi(renderSessionRecap({ session: makeSession(), cwd: "/w", welcome: false }));
    expect(plain).not.toContain("procway-code");
    expect(plain).toContain("You: run the tests");
  });

  it("falls back to session.settings", () => {
    const plain = stripAnsi(renderSessionRecap({ session: makeSession(), cwd: "/w" }));
    expect(plain).toContain("gpt-5.4");
  });

  it("shows the no-history sentinel for a fresh session", () => {
    const plain = stripAnsi(renderSessionRecap({ session: makeSession({ messages: [] }), cwd: "/w" }));
    expect(plain).toContain("(no prior conversation)");
  });

  it("printSessionRecap derives colour from the stream (NO_COLOR-aware)", () => {
    let plainStream = "";
    printSessionRecap({
      session: makeSession(),
      cwd: "/w",
      output: { columns: 80, isTTY: false, write: (value) => { plainStream += value; } }
    });
    expect(plainStream).not.toContain("\x1b[");
  });
});

/**
 * Regression guard for the bug this phase exists to kill: the four replay
 * routes drifting apart again (`/resume` used to pass no `markdown` flag, so
 * it rendered plain text while `resume <id>` rendered Markdown). Every route
 * must reach the terminal through printSessionRecap and nothing else.
 */
describe("cli.mjs replay routes all go through one renderer", () => {
  it("has exactly four printSessionRecap call sites and no ad-hoc transcript printing", async () => {
    const source = await readFile(cliPath, "utf8");
    const calls = source.match(/printSessionRecap\(\{/g) ?? [];
    expect(calls.length).toBe(4);
    // `resume <id>`, `/history`, `/resume`, `/checkout` — the four routes.
    expect(source).toMatch(/trimmed === "\/history"[\s\S]{0,220}printSessionRecap/);
    expect(source).toMatch(/trimmed === "\/resume"[\s\S]{0,600}printSessionRecap/);
    expect(source).toMatch(/trimmed\.startsWith\("\/checkout"\)[\s\S]{0,600}printSessionRecap/);
    expect(source).not.toContain("printTranscript");
    // The markdown boolean is gone for good (P1-3).
    expect(source).not.toMatch(/markdown\s*:/);
  });
});

describe("swapActiveSession (P1-7)", () => {
  function fakeSession(id) {
    const detached = [];
    return {
      sessionId: id,
      aborted: 0,
      abort() { this.aborted += 1; },
      timelineRenderer: { detach: () => detached.push("timeline") },
      streamingRenderer: { detach: () => detached.push("streaming") },
      tuiDisposables: [
        { dispose: () => detached.push("approval") },
        { dispose: () => detached.push("todos") }
      ],
      detached
    };
  }

  it("detaches the previous session's renderers and subscriptions", () => {
    const previous = fakeSession("old");
    const next = fakeSession("new");
    expect(swapActiveSession(previous, next)).toBe(next);
    expect(previous.detached).toEqual(["timeline", "streaming", "approval", "todos"]);
    expect(next.detached).toEqual([]);
  });

  it("keeps the previous session when the picker was cancelled", () => {
    const previous = fakeSession("old");
    expect(swapActiveSession(previous, null)).toBe(previous);
    expect(previous.detached).toEqual([]);
  });

  it("is a no-op when swapping a session for itself", () => {
    const session = fakeSession("same");
    expect(swapActiveSession(session, session)).toBe(session);
    expect(session.detached).toEqual([]);
  });

  it("survives renderers that throw on detach", () => {
    const previous = fakeSession("old");
    previous.timelineRenderer = { detach: () => { throw new Error("boom"); } };
    expect(() => disposeSessionRenderers(previous)).not.toThrow();
  });

  it("Ctrl+C aborts the session that is active NOW, not the one captured at attach time", () => {
    let activeSession = fakeSession("old");
    const proc = { on() {}, removeListener() {}, exit() {} };
    const handle = attachInterruptHandler({
      getSession: () => activeSession,
      output: { write() {} },
      process: proc,
      exit: () => {}
    });

    const next = fakeSession("new");
    activeSession = swapActiveSession(activeSession, next);
    handle.trigger();

    expect(next.aborted).toBe(1);
    handle.dispose();
  });
});
