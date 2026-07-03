import { describe, expect, it } from "vitest";
import { runCliAgentProvider } from "../src/providers/cli-agent.mjs";

describe("runCliAgentProvider", () => {
  it("sends prompt over stdin by default", async () => {
    const result = await runCliAgentProvider({
      provider: {
        command: process.execPath,
        args: ["-e", "process.stdin.pipe(process.stdout)"]
      },
      prompt: "hello",
      timeoutMs: 5000
    });

    expect(result.message.role).toBe("assistant");
    expect(result.message.content).toBe("hello");
    expect(result.toolCalls).toEqual([]);
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(result.deltaStream).toBeUndefined();
  });

  it("can pass prompt through argv placeholder", async () => {
    const result = await runCliAgentProvider({
      provider: {
        command: process.execPath,
        args: ["-e", "process.stdout.write(process.argv[1])", "{prompt}"],
        stdinMode: "none"
      },
      prompt: "from-argv",
      timeoutMs: 5000
    });

    expect(result.message.content).toBe("from-argv");
  });

  it("preserves embedded quotes in args (e.g. key=\"value\")", async () => {
    const result = await runCliAgentProvider({
      provider: {
        command: process.execPath,
        args: ["-e", "process.stdout.write(process.argv[1])", `key="value"`],
        stdinMode: "none"
      },
      prompt: "ignored",
      timeoutMs: 5000
    });

    expect(result.message.content).toBe(`key="value"`);
  });

  it("surfaces spawn errors as a thrown Error rather than crashing the process", async () => {
    await expect(runCliAgentProvider({
      provider: { command: "this-binary-does-not-exist-12345", args: [] },
      prompt: "hi",
      timeoutMs: 2000
    })).rejects.toThrow(/cli-agent provider failed/);
  });

  it("extracts only the final agent_message from codex --json output", async () => {
    // codex commonly emits an intermediate agent_message ("I'll check ...")
    // followed by a command_execution, then a final agent_message with the
    // real reply. Surfacing both produces a duplicated-looking response in
    // the chat panel, so we keep only the last one.
    const codexOutput = [
      JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "I'll check the rules first." } }),
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "ls", exit_code: 0 } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "final reply" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 5 } })
    ].join("\n");
    const result = await runCliAgentProvider({
      provider: {
        command: process.execPath,
        args: ["-e", `process.stdout.write(${JSON.stringify(codexOutput)})`],
        stdinMode: "none"
      },
      prompt: "anything",
      timeoutMs: 5000
    });
    expect(result.message.content).toBe("final reply");
  });

  it("recognises codex JSON even when the leading thread.started line is missing", async () => {
    // Simulates the bounded-buffer truncation case: a long codex turn whose
    // head got rolled off, leaving a partial first line and only later
    // events visible. The parser should still extract the final
    // agent_message rather than dumping the raw JSON envelope.
    const codexOutput = [
      'owledge_files":[],"profile":"...continued partial line',
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "ls", aggregated_output: "huge output here", exit_code: 0 } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "actual reply" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } })
    ].join("\n");
    const result = await runCliAgentProvider({
      provider: {
        command: process.execPath,
        args: ["-e", `process.stdout.write(${JSON.stringify(codexOutput)})`],
        stdinMode: "none"
      },
      prompt: "anything",
      timeoutMs: 5000
    });
    expect(result.message.content).toBe("actual reply");
  });

  it("returns raw stdout for non-codex output", async () => {
    const result = await runCliAgentProvider({
      provider: {
        command: process.execPath,
        args: ["-e", "process.stdout.write('plain text reply')"],
        stdinMode: "none"
      },
      prompt: "anything",
      timeoutMs: 5000
    });
    expect(result.message.content).toBe("plain text reply");
  });

  it("kills the spawned process when the provided AbortSignal fires", async () => {
    const controller = new AbortController();
    // Sleep long enough that the abort wins before the program would exit.
    const promise = runCliAgentProvider({
      provider: {
        command: process.execPath,
        args: ["-e", "setTimeout(()=>{}, 30000)"],
        stdinMode: "none"
      },
      prompt: "ignored",
      timeoutMs: 60000,
      signal: controller.signal
    });
    setTimeout(() => controller.abort(), 50);
    await expect(promise).rejects.toMatchObject({ code: "aborted" });
  });

  it("rejects immediately when the AbortSignal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runCliAgentProvider({
      provider: {
        command: process.execPath,
        args: ["-e", "setTimeout(()=>{}, 30000)"],
        stdinMode: "none"
      },
      prompt: "ignored",
      timeoutMs: 60000,
      signal: controller.signal
    })).rejects.toMatchObject({ code: "aborted" });
  });
});
