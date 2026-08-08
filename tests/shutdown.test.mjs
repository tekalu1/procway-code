import { describe, expect, it, vi } from "vitest";
import { createShutdown, renderResumeHint, resumeCommandName } from "../src/adapters/tui/shutdown.mjs";

function makeSession(overrides = {}) {
  return {
    runningTurn: false,
    aborted: 0,
    saved: [],
    abort() { this.aborted += 1; },
    async save(options) { this.saved.push(options); },
    ...overrides
  };
}

function makeSink() {
  let text = "";
  return { write(value) { text += value; return true; }, once() {}, get text() { return text; } };
}

describe("shutdown() — the REPL's one exit path (P2-5)", () => {
  it("aborts, saves, reaps children, disposes the input controller, then exits", async () => {
    const order = [];
    const session = makeSession({
      abort() { order.push("abort"); },
      async save() { order.push("save"); },
      mcpRegistry: { async close() { order.push("mcp"); } }
    });
    const shutdown = createShutdown({
      getSession: () => session,
      controller: { dispose: () => order.push("controller") },
      shellManager: { async closeAll() { order.push("shells"); } },
      output: makeSink(),
      errorOutput: makeSink(),
      exit: (code) => order.push(`exit:${code}`)
    });
    await shutdown({ code: 0, reason: "exit-command" });
    expect(order).toEqual(["abort", "save", "shells", "mcp", "controller", "exit:0"]);
  });

  it("forces the snapshot write so the last turn is never lost", async () => {
    const session = makeSession();
    const shutdown = createShutdown({
      getSession: () => session,
      output: makeSink(),
      errorOutput: makeSink(),
      exit: () => {}
    });
    await shutdown({ code: 130 });
    expect(session.saved).toEqual([{ force: true }]);
    expect(session.aborted).toBe(1);
  });

  it("waits for a running turn to unwind, then gives up after joinMs", async () => {
    const session = makeSession({ runningTurn: true });
    let slept = 0;
    const shutdown = createShutdown({
      getSession: () => session,
      output: makeSink(),
      errorOutput: makeSink(),
      exit: () => {},
      joinMs: 100,
      sleep: async (ms) => { slept += ms; if (slept >= 60) session.runningTurn = false; }
    });
    await shutdown({});
    expect(slept).toBeGreaterThan(0);
    expect(session.saved).toHaveLength(1);
  });

  it("still exits when save / cleanup throw", async () => {
    const warnings = [];
    let exited = null;
    const shutdown = createShutdown({
      getSession: () => makeSession({ save: async () => { throw new Error("disk full"); } }),
      shellManager: { closeAll: async () => { throw new Error("no shells"); } },
      controller: { dispose: () => { throw new Error("tty gone"); } },
      output: makeSink(),
      errorOutput: makeSink(),
      onWarn: (message) => warnings.push(message),
      exit: (code) => { exited = code; }
    });
    await shutdown({ code: 143 });
    expect(exited).toBe(143);
    expect(warnings.join(" ")).toContain("disk full");
    expect(warnings.join(" ")).toContain("no shells");
  });

  it("is idempotent — a second Ctrl+C / SIGTERM cannot re-enter it", async () => {
    const exit = vi.fn();
    const session = makeSession();
    const shutdown = createShutdown({
      getSession: () => session,
      output: makeSink(),
      errorOutput: makeSink(),
      exit
    });
    await Promise.all([shutdown({ code: 0 }), shutdown({ code: 130 })]);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(session.saved).toHaveLength(1);
  });

  it("prints the resume command on every deliberate exit path", async () => {
    // /exit, Ctrl+D and Ctrl+C×2 all land in shutdown() with these reasons.
    for (const [reason, code] of [["exit-command", 0], ["eof", 0], ["sigint", 130]]) {
      const output = makeSink();
      const shutdown = createShutdown({
        getSession: () => makeSession({
          sessionId: "2026-08-04T15-34-21-942Z",
          messages: [{ role: "system", content: "…" }, { role: "user", content: "hi" }]
        }),
        output,
        errorOutput: makeSink(),
        exit: () => {},
        argv: ["/usr/bin/node", "/usr/local/bin/procway-code"],
        colorize: false
      });
      await shutdown({ code, reason });
      expect(output.text).toBe("\nResume this session:\n  procway-code resume 2026-08-04T15-34-21-942Z\n");
    }
  });

  it("stays quiet on SIGTERM and on a session nobody talked to", async () => {
    const supervised = makeSink();
    await createShutdown({
      getSession: () => makeSession({ sessionId: "s-1", messages: [{ role: "user", content: "hi" }] }),
      output: supervised,
      errorOutput: makeSink(),
      exit: () => {},
      colorize: false
    })({ code: 143, reason: "sigterm" });
    expect(supervised.text).toBe("");

    const empty = makeSink();
    await createShutdown({
      // Only the system prompt: the user typed nothing, so the id is noise.
      getSession: () => makeSession({ sessionId: "s-2", messages: [{ role: "system", content: "…" }] }),
      output: empty,
      errorOutput: makeSink(),
      exit: () => {},
      colorize: false
    })({ code: 0, reason: "exit-command" });
    expect(empty.text).toBe("");
  });

  it("renderResumeHint skips sessions that are not persisted", () => {
    const messages = [{ role: "user", content: "hi" }];
    expect(renderResumeHint({ session: { sessionId: "s-1", messages } })).toContain("resume s-1");
    expect(renderResumeHint({
      session: { sessionId: "s-1", messages, settings: { session: { enabled: false } } }
    })).toBe("");
    expect(renderResumeHint({ session: { messages } })).toBe("");
  });

  it("resumeCommandName follows however the process was started", () => {
    expect(resumeCommandName(["/usr/bin/node", "/usr/local/bin/procway-code"])).toBe("procway-code");
    expect(resumeCommandName(["/usr/bin/node", "/app/node_modules/procway-code/src/cli.mjs"])).toBe("procway-code");
    expect(resumeCommandName(["/usr/bin/node", `${process.cwd()}/src/cli.mjs`])).toBe("node src/cli.mjs");
    expect(resumeCommandName([])).toBe("procway-code");
  });

  it("works with no session at all (shutdown during startup)", async () => {
    let exited = null;
    const shutdown = createShutdown({
      getSession: () => null,
      output: makeSink(),
      errorOutput: makeSink(),
      exit: (code) => { exited = code; }
    });
    await shutdown({ code: 0 });
    expect(exited).toBe(0);
  });
});
