/**
 * The persistent input dock has to survive a whole TURN, on a real terminal.
 *
 * Every renderer unit test was green while the REPL did this: the moment a
 * turn used a tool, the input line (and the pinned TODO panel) disappeared for
 * the rest of the session — pressing Enter, which re-arms the prompt, was the
 * only way to get them back. Nothing caught it because the bug lives between
 * the pieces: `assistant.message.completed` fires once per round, a tool-call
 * round has no assistant text, `renderAssistantContent()` renders that to "",
 * and an empty write used to be treated as an unterminated line — dock down,
 * editor hidden, and (before this fix) no later write could rebuild it.
 *
 * So the scenario is driven end to end: the real CLI on a pty, a mock
 * OpenAI-compatible endpoint that answers with tool calls and then prose, and
 * the assertion is on the SCREEN (see `helpers/screen.mjs`), not on the byte
 * stream — the stream contains every repaint that was later erased.
 */

import http from "node:http";
import { describe, expect, it } from "vitest";
import { makePtyEnv, ptySupported, runPty } from "./helpers/pty.mjs";
import { renderScreen } from "./helpers/screen.mjs";

const COLS = 80;
const ROWS = 24;

function dataLine(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function textChunk(text) {
  return dataLine({ choices: [{ delta: { content: text } }] });
}

function toolChunk(id, name, args) {
  return dataLine({
    choices: [{
      delta: {
        tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }]
      }
    }]
  });
}

/**
 * A minimal streaming chat-completions endpoint. `rounds[n]` is the SSE body
 * for the nth request of a turn (the last entry repeats), so a turn can be
 * scripted as "tool call, tool call, answer" — which is what makes it a
 * multi-round turn, the shape that broke the dock.
 */
async function startMockModel(rounds) {
  let call = 0;
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const pieces = rounds[Math.min(call, rounds.length - 1)];
      call += 1;
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      for (const piece of pieces) response.write(piece);
      response.write(dataLine({ choices: [{ delta: {}, finish_reason: "stop" }] }));
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port };
}

const ANSWER = [
  textChunk("こんにちは。"),
  textChunk("以下に説明します。\n\n"),
  textChunk("- 一つ目の項目\n"),
  textChunk("- 二つ目の項目\n\n"),
  textChunk("最後にまとめです。")
];

const TODO_ROUND = [toolChunk("call_todo", "TodoWrite", {
  todos: [
    { content: "調べる", activeForm: "調べています", status: "in_progress" },
    { content: "直す", activeForm: "直しています", status: "pending" }
  ]
})];

const LIST_ROUND = [toolChunk("call_list", "list_files", { path: "." })];

describe.runIf(ptySupported())("pty — the input dock survives a turn", () => {
  /** Rows that actually carry something, bottom row last. */
  const filled = (lines) => lines.filter((line) => line.trim() !== "");

  /** Run one turn against `rounds` and return the final screen rows. */
  async function screenAfterTurn(rounds) {
    const { server, port } = await startMockModel(rounds);
    const env = await makePtyEnv({
      settings: {
        defaultProvider: "mock",
        approvalMode: "auto-readonly",
        providers: {
          mock: {
            type: "openai-compatible",
            apiKeyEnv: "OPENAI_API_KEY",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            defaultModel: "gpt-test"
          }
        }
      }
    });
    try {
      const run = await runPty({
        home: env.home,
        workspace: env.workspace,
        cols: COLS,
        rows: ROWS,
        env: { OPENAI_API_KEY: "test-key" },
        // The turn must still be the live session when the run is cut, or the
        // screen under test would be the goodbye screen.
        stopAfterSteps: true,
        steps: [
          { waitFor: /╰─❯/, settleMs: 200, send: "hello\r" },
          // The last block of the answer; `settleMs` lets the dock repaint
          // that follows it land before the session is cut.
          { waitFor: /最後にまとめです/, timeoutMs: 20000, settleMs: 500 }
        ]
      });
      return renderScreen(run.output, { width: COLS, height: ROWS });
    } finally {
      server.close();
      await env.cleanup();
    }
  }

  it("keeps the input line on screen after a text-only turn", async () => {
    const lines = await screenAfterTurn([ANSWER]);
    expect(lines.join("\n")).toContain("最後にまとめです。");
    // The armed prompt is the bottom of the screen: its header row, then an
    // empty input row (the submitted `╰─❯ hello` is a committed feed row far
    // above it, which is why this checks the LAST rows, not a substring).
    expect(filled(lines).at(-1)).toBe("╰─❯");
    expect(filled(lines).at(-2)).toContain("╭─ workspace");
  }, 60000);

  it("keeps the input line on screen after a turn that called a tool", async () => {
    const lines = await screenAfterTurn([LIST_ROUND, ANSWER]);
    expect(lines.join("\n")).toContain("list_files");
    expect(lines.join("\n")).toContain("最後にまとめです。");
    // Before the fix the dock was simply not on screen: the tool-call round's
    // empty message write took it down and nothing rebuilt it.
    expect(filled(lines).at(-1)).toBe("╰─❯");
    expect(filled(lines).at(-2)).toContain("╭─ workspace");
  }, 60000);

  it("keeps the TODO panel pinned above the input after a multi-round turn", async () => {
    const lines = await screenAfterTurn([TODO_ROUND, LIST_ROUND, ANSWER]);
    expect(lines.join("\n")).toContain("最後にまとめです。");
    expect(filled(lines).at(-1)).toBe("╰─❯");
    expect(filled(lines).at(-2)).toContain("╭─ workspace");
    // Pinned means pinned: one copy of the panel, directly above the prompt.
    const todoRows = lines.filter((line) => line.includes("▌ TODO"));
    expect(todoRows.length).toBe(1);
    expect(lines.findIndex((line) => line.includes("▌ TODO")))
      .toBeLessThan(lines.findIndex((line) => line.includes("╭─ workspace")));
  }, 60000);
});
