import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeToolCall, invalidateDisplayToolAvailability } from "../src/tools/registry.mjs";
import { runToolCalls } from "../src/agent/scheduler.mjs";
import { runAnthropicProvider } from "../src/providers/anthropic.mjs";
import { makeInvalidToolArgs, parseToolArgs } from "../src/providers/format/tool-args.mjs";

function buildSseStream(events) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        const lines = [];
        if (event.event) lines.push(`event: ${event.event}`);
        lines.push(`data: ${JSON.stringify(event.data)}`);
        controller.enqueue(encoder.encode(`${lines.join("\n")}\n\n`));
      }
      controller.close();
    }
  });
}

// Runs a tool through the scheduler the way executeToolsRound does, so a throw
// from executeToolCall surfaces as the ok:false tool result the model sees.
async function runThroughScheduler(name, args, cwd = process.cwd()) {
  const [result] = await runToolCalls([
    {
      index: 0,
      id: "call-0",
      name,
      mutation: true,
      run: () => executeToolCall({ name, args, cwd, settings: {}, approvalRequester: async () => true })
    }
  ]);
  return result;
}

describe("required-arg validation (fix 1)", () => {
  it("rejects write_file with a missing filePath as a clear, retryable error", async () => {
    await expect(
      executeToolCall({ name: "write_file", args: { content: "hi" }, cwd: process.cwd(), settings: {}, approvalRequester: async () => true })
    ).rejects.toThrow(/write_file requires "filePath" \(string\) but it was missing/);
  });

  it("surfaces the missing-arg error as an ok:false tool result via the scheduler", async () => {
    const result = await runThroughScheduler("write_file", { content: "hi" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/write_file requires "filePath"/);
    expect(result.error).toMatch(/retry with complete arguments/);
  });

  it("rejects a required arg of the wrong type", async () => {
    const result = await runThroughScheduler("write_file", { filePath: 123, content: "hi" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/write_file requires "filePath" to be string but got number/);
  });

  it("validates display-gated tools even when they are unavailable in this environment", async () => {
    // Regression (fix 5): the schema map used to be built from the
    // availability-FILTERED tool list, so on a host with no X display
    // web_browser/desktop_action were dropped and their calls fail-opened
    // (skipped validation). The map is now built from the unfiltered set.
    invalidateDisplayToolAvailability();
    const result = await runThroughScheduler("web_browser", {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/web_browser requires "steps" \(array\) but it was missing/);
  });

  it("does not reject a valid call before dispatch", async () => {
    // A well-formed call must pass validation and reach the handler (approval
    // gate) — proven by the write actually succeeding.
    const cwd = await mkdtemp(path.join(os.tmpdir(), "procway-argval-"));
    try {
      const result = await runThroughScheduler("write_file", { filePath: "validated.txt", content: "ok" }, cwd);
      expect(result.ok).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("invalid / truncated tool-args marker (fix 2)", () => {
  it("parseToolArgs marks unparseable JSON instead of returning {}", () => {
    expect(parseToolArgs("{\"a\":1}")).toEqual({ a: 1 });
    expect(parseToolArgs("")).toEqual({});
    expect(parseToolArgs("{\"filePath\":")).toEqual({ __procwayInvalidToolArgs: { reason: "parse_error", truncated: false } });
    expect(parseToolArgs("{bad", { truncated: true })).toEqual({ __procwayInvalidToolArgs: { reason: "parse_error", truncated: true } });
  });

  it("turns an invalid-args marker into an ok:false result the model can retry", async () => {
    const result = await runThroughScheduler("write_file", makeInvalidToolArgs({ reason: "parse_error", truncated: false }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/arguments were not valid JSON/);
    expect(result.error).toMatch(/Retry the call with complete, well-formed arguments/);
  });

  it("names truncation when the marker says the arguments were cut off", async () => {
    const result = await runThroughScheduler("write_file", makeInvalidToolArgs({ truncated: true }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/arguments were truncated/);
    expect(result.error).toMatch(/output-token limit/);
  });

  it("Anthropic streaming marks a tool_use whose input JSON was cut off at max_tokens", async () => {
    process.env.TEST_ANTHROPIC_KEY = "key";
    const sseEvents = [
      { event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 1 } } } },
      { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_x", name: "write_file", input: {} } } },
      { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"filePath\":\"a.txt\",\"conte" } } },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
      { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 1 } } }
    ];
    const response = await runAnthropicProvider({
      provider: { baseUrl: "https://api.anthropic.com", apiKeyEnv: "TEST_ANTHROPIC_KEY" },
      model: "claude-sonnet-test",
      prompt: "write it",
      fetchImpl: async () => ({ ok: true, status: 200, body: buildSseStream(sseEvents) })
    });
    for await (const _chunk of response.deltaStream) { void _chunk; }
    const final = await response.finalize();
    expect(final.toolCalls).toEqual([
      { id: "toolu_x", name: "write_file", args: { __procwayInvalidToolArgs: { reason: "parse_error", truncated: true } } }
    ]);
  });
});
