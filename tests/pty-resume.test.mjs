/**
 * `/resume`, on a real pty (P4-3).
 *
 * This is the route the whole rich-shell effort started from: resuming a
 * session used to dump the stored messages as raw JSON, so a transcript with
 * a tool call in it was unreadable. The fixture below therefore contains the
 * awkward shape on purpose — a `tool_use` block plus its `tool_result` — and
 * the test asserts both halves of the contract: no serialized objects on
 * screen, and the tool call still legible.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMessage } from "../src/core/types/message.mjs";
import { saveSessionState } from "../src/session/store.mjs";
import {
  PROMPT,
  frames,
  lastFrameWith,
  makePtyEnv,
  normalizePty,
  plainPty,
  ptySupported,
  runPty
} from "./helpers/pty.mjs";

const describePty = ptySupported() ? describe : describe.skip;

const CTRL_D = "\x04";
const SESSION_ID = "2026-01-02T03-04-05-678Z";

/**
 * Fixed 3.5 days back so the picker's relative timestamp is "3 days ago"
 * whenever the suite runs — an absolute date would drift into "4 months ago"
 * and rewrite the snapshot by the calendar.
 */
function threeDaysAgo() {
  return new Date(Date.now() - 3.5 * 24 * 60 * 60 * 1000).toISOString();
}

describePty("pty: /resume", () => {
  let env;

  beforeAll(async () => {
    env = await makePtyEnv();
    const when = threeDaysAgo();
    await saveSessionState({
      homeDir: env.home,
      sessionId: SESSION_ID,
      state: {
        title: "run the unit tests",
        cwd: env.workspace,
        provider: "openai-main",
        model: "gpt-test",
        createdAt: when,
        updatedAt: when,
        // Built through `createMessage` — ids and all — because that is what
        // the store really holds; a hand-rolled object without an id is
        // dropped on load and the replay comes back empty.
        messages: [
          createMessage({ id: "m-0", sessionId: SESSION_ID, role: "system", content: "system prompt that must stay hidden" }),
          createMessage({ id: "m-1", sessionId: SESSION_ID, role: "user", content: "run the unit tests" }),
          createMessage({
            id: "m-2",
            sessionId: SESSION_ID,
            role: "assistant",
            content: [{ kind: "tool_use", toolCallId: "call-1", name: "run_shell", args: { command: "pnpm test" } }]
          }),
          createMessage({
            id: "m-3",
            sessionId: SESSION_ID,
            role: "tool",
            toolCallId: "call-1",
            content: [{
              kind: "tool_result",
              toolCallId: "call-1",
              ok: true,
              result: { kind: "run_shell", summary: "Ran: pnpm test (exit 0)", data: { stdout: "1483 passed\n", stderr: "" } }
            }]
          }),
          createMessage({ id: "m-4", sessionId: SESSION_ID, role: "assistant", content: "All 1483 tests passed." })
        ]
      }
    });
  });

  afterAll(async () => { await env?.cleanup(); });

  it("lists the session, replays it as text, and never prints raw JSON", async () => {
    const run = await runPty({
      home: env.home,
      workspace: env.workspace,
      steps: [
        { waitFor: PROMPT, send: "/resume\r" },
        // Two rows: the session this REPL just created ("just now") is the
        // most recent, so the fixture is one ↓ away. Then Enter resumes it.
        { waitFor: /Resume a session/, send: "\x1b[B\r" },
        { waitFor: /All 1483 tests passed/, send: CTRL_D }
      ]
    });
    expect(run.exitCode).toBe(0);

    // The picker repaints in place and the replay is printed straight after
    // the last repaint, so one frame carries both: the settled picker (row
    // two selected) and everything the resumed session printed.
    const replay = lastFrameWith(run.output, "Resume a session");
    const plain = plainPty(replay, env);

    // The picker row.
    expect(plain).toContain("run the unit tests");
    expect(plain).toContain("3 days ago");

    // The transcript, as prose rather than storage format.
    expect(plain).toContain("run_shell");
    expect(plain).toContain("pnpm test");
    expect(plain).toContain("All 1483 tests passed.");

    // The system prompt is not part of a transcript the user reads back.
    expect(plain).not.toContain("system prompt that must stay hidden");

    // The regression: `JSON.stringify`d message objects on screen.
    for (const leak of ['"kind"', '"toolCallId"', '"tool_use"', '"role"', '[object Object]']) {
      expect(plain, `raw storage format leaked into the replay: ${leak}`).not.toContain(leak);
    }

    expect(normalizePty(replay, env)).toMatchSnapshot();

    // The shutdown hint names the session that was resumed, so a user can get
    // back to it. It is printed after the final prompt repaint.
    const farewell = frames(run.output).at(-1);
    expect(plainPty(farewell, env)).toContain("Resume this session:");
    expect(normalizePty(farewell, env)).toMatchSnapshot();
  }, 30000);
});
