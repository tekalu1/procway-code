import { describe, expect, it, vi } from "vitest";

// Stub the refresh guard so the provider doesn't try to read or write
// the real auth-profiles.json during tests. We yield a deterministic
// credentials bundle for every call.
vi.mock("../src/auth/refresh-guard.mjs", () => ({
  getValidCredentials: vi.fn(async () => ({
    access: "stub-access-token",
    refresh: "stub-refresh-token",
    expires: Date.now() + 3_600_000,
    accountId: "acct-stub"
  }))
}));

const { runOpenAiCodexProvider } = await import("../src/providers/openai-codex.mjs");
const { getValidCredentials } = await import("../src/auth/refresh-guard.mjs");

function sseStream(events) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const ev of events) {
        if (ev.event) controller.enqueue(encoder.encode(`event: ${ev.event}\n`));
        if (ev.data !== undefined) {
          const payload = typeof ev.data === "string" ? ev.data : JSON.stringify(ev.data);
          controller.enqueue(encoder.encode(`data: ${payload}\n`));
        }
        controller.enqueue(encoder.encode("\n"));
      }
      controller.close();
    }
  });
}

function okResponse(events) {
  return { ok: true, status: 200, statusText: "OK", body: sseStream(events) };
}

function baseProvider(overrides = {}) {
  return {
    type: "openai-codex",
    authProfile: "codex",
    defaultModel: "gpt-test",
    ...overrides
  };
}

describe("runOpenAiCodexProvider (non-streaming)", () => {
  it("aggregates output_text deltas into the assistant content + reports usage", async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse([
        { event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "Hello " } },
        { event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "world" } },
        { event: "response.completed", data: { type: "response.completed", response: { usage: { input_tokens: 7, output_tokens: 2 } } } }
      ])
    );
    const result = await runOpenAiCodexProvider({
      provider: baseProvider(),
      prompt: "hi",
      fetchImpl,
      stream: false
    });
    expect(result.message.content).toBe("Hello world");
    expect(result.toolCalls).toEqual([]);
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 2 });
  });

  it("emits a tool_call shape when the model invokes a function", async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse([
        {
          event: "response.output_item.added",
          data: {
            type: "response.output_item.added",
            output_index: 0,
            item: { id: "fc_1", type: "function_call", call_id: "call_abc", name: "list_files", arguments: "" }
          }
        },
        { event: "response.function_call_arguments.delta", data: { type: "response.function_call_arguments.delta", output_index: 0, delta: "{\"" } },
        { event: "response.function_call_arguments.delta", data: { type: "response.function_call_arguments.delta", output_index: 0, delta: "dirPath\":\".\"}" } },
        { event: "response.function_call_arguments.done", data: { type: "response.function_call_arguments.done", output_index: 0, arguments: "{\"dirPath\":\".\"}" } },
        { event: "response.completed", data: { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 4 } } } }
      ])
    );
    const result = await runOpenAiCodexProvider({
      provider: baseProvider(),
      messages: [{ role: "user", content: "list please" }],
      tools: [{ type: "function", function: { name: "list_files", parameters: { type: "object", properties: { dirPath: { type: "string" } }, required: ["dirPath"] } } }],
      fetchImpl,
      stream: false
    });
    expect(result.toolCalls).toEqual([{ id: "call_abc", name: "list_files", args: { dirPath: "." } }]);
    expect(result.message.tool_calls).toEqual([
      { id: "call_abc", type: "function", function: { name: "list_files", arguments: '{"dirPath":"."}' } }
    ]);
    expect(result.message.content).toBeNull();
  });

  it("fix 7: marks a truncated function call (status incomplete / max_output_tokens) via the shared helper", async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse([
        {
          event: "response.output_item.added",
          data: {
            type: "response.output_item.added",
            output_index: 0,
            item: { id: "fc_2", type: "function_call", call_id: "call_cut", name: "write_file", arguments: "" }
          }
        },
        { event: "response.function_call_arguments.delta", data: { type: "response.function_call_arguments.delta", output_index: 0, delta: "{\"filePath\":\"a.txt\",\"conte" } },
        { event: "response.completed", data: { type: "response.completed", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 5, output_tokens: 9 } } } }
      ])
    );
    const result = await runOpenAiCodexProvider({
      provider: baseProvider(),
      messages: [{ role: "user", content: "write please" }],
      tools: [{ type: "function", function: { name: "write_file", parameters: { type: "object" } } }],
      fetchImpl,
      stream: false
    });
    expect(result.toolCalls).toEqual([
      { id: "call_cut", name: "write_file", args: { __procwayInvalidToolArgs: { reason: "parse_error", truncated: true } } }
    ]);
  });

  it("surfaces response.failed events as thrown errors", async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse([
        { event: "response.failed", data: { type: "response.failed", response: { error: { message: "internal" } } } }
      ])
    );
    await expect(
      runOpenAiCodexProvider({ provider: baseProvider(), prompt: "x", fetchImpl, stream: false })
    ).rejects.toThrow(/openai-codex provider stream error: internal/);
  });

  it("force-refreshes credentials and retries on 401 once", async () => {
    getValidCredentials.mockClear();
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 401, statusText: "Unauthorized", text: async () => "expired" };
      return okResponse([
        { event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "after-refresh" } },
        { event: "response.completed", data: { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } } }
      ]);
    });
    const result = await runOpenAiCodexProvider({
      provider: baseProvider(),
      prompt: "hi",
      fetchImpl,
      stream: false
    });
    expect(result.message.content).toBe("after-refresh");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // First call is the up-front fresh fetch, second is the force refresh.
    expect(getValidCredentials.mock.calls.some(([, opts]) => opts?.force === true)).toBe(true);
  });
});

describe("runOpenAiCodexProvider (streaming)", () => {
  it("yields delta text fragments in order and finalize() returns the aggregated result", async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse([
        { event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "1" } },
        { event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "2" } },
        { event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "3" } },
        { event: "response.completed", data: { type: "response.completed", response: { usage: { input_tokens: 2, output_tokens: 3 } } } }
      ])
    );
    const handle = await runOpenAiCodexProvider({
      provider: baseProvider(),
      prompt: "count",
      fetchImpl
    });
    const deltas = [];
    for await (const chunk of handle.deltaStream) deltas.push(chunk.deltaText);
    const final = await handle.finalize();
    expect(deltas).toEqual(["1", "2", "3"]);
    expect(final.message.content).toBe("123");
    expect(final.usage).toEqual({ inputTokens: 2, outputTokens: 3 });
  });

  it("tags reasoning_summary deltas with kind: 'reasoning' so the orchestrator can route them to assistant.reasoning.delta", async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse([
        { event: "response.reasoning_summary_text.delta", data: { type: "response.reasoning_summary_text.delta", delta: "let me " } },
        { event: "response.reasoning_summary_text.delta", data: { type: "response.reasoning_summary_text.delta", delta: "think" } },
        { event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "answer" } },
        { event: "response.completed", data: { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } } }
      ])
    );
    const handle = await runOpenAiCodexProvider({
      provider: baseProvider(),
      prompt: "go",
      fetchImpl
    });
    const chunks = [];
    for await (const chunk of handle.deltaStream) chunks.push({ kind: chunk.kind, deltaText: chunk.deltaText });
    const final = await handle.finalize();
    expect(chunks).toEqual([
      { kind: "reasoning", deltaText: "let me " },
      { kind: "reasoning", deltaText: "think" },
      { kind: "text", deltaText: "answer" }
    ]);
    expect(final.message.content).toBe("answer");
    expect(final.reasoningContent).toBe("let me think");
  });

  it("emits a heartbeat chunk for keepalive frames so the turn-idle watchdog stays fed during long reasoning", async () => {
    // A long reasoning phase streams response.created/in_progress keepalives with
    // NO text/reasoning delta. Those must surface as heartbeat chunks (→
    // activity.tick) or the watchdog aborts a healthy turn.
    const fetchImpl = vi.fn(async () =>
      okResponse([
        { event: "response.created", data: { type: "response.created" } },
        { event: "response.in_progress", data: { type: "response.in_progress" } },
        { event: "response.in_progress", data: { type: "response.in_progress" } },
        { event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "ok" } },
        { event: "response.completed", data: { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } } }
      ])
    );
    const handle = await runOpenAiCodexProvider({ provider: baseProvider(), prompt: "go", fetchImpl });
    const chunks = [];
    for await (const chunk of handle.deltaStream) chunks.push({ kind: chunk.kind, deltaText: chunk.deltaText });
    const final = await handle.finalize();
    // At least one heartbeat (the 5s throttle coalesces the burst), plus the text.
    expect(chunks.some((c) => c.kind === "heartbeat")).toBe(true);
    expect(chunks.find((c) => c.kind === "text")?.deltaText).toBe("ok");
    expect(final.message.content).toBe("ok");
  });

  it("falls back to response.output[] text on completed when no output_text.delta streamed", async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse([
        { event: "response.in_progress", data: { type: "response.in_progress" } },
        { event: "response.completed", data: { type: "response.completed", response: {
          usage: { input_tokens: 1, output_tokens: 1 },
          output: [{ type: "message", content: [{ type: "output_text", text: "final answer" }] }]
        } } }
      ])
    );
    const handle = await runOpenAiCodexProvider({ provider: baseProvider(), prompt: "go", fetchImpl });
    for await (const _chunk of handle.deltaStream) { /* drain */ }
    const final = await handle.finalize();
    expect(final.message.content).toBe("final answer");
  });
});

describe("request shaping", () => {
  function captureBody(fetchImpl) {
    return fetchImpl.mock.calls[0][1].body;
  }

  it("places system messages into `instructions` and converts user/assistant/tool messages into Responses input items", async () => {
    const fetchImpl = vi.fn(async () => okResponse([
      { event: "response.completed", data: { type: "response.completed", response: { usage: {} } } }
    ]));
    await runOpenAiCodexProvider({
      provider: baseProvider(),
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "what color is grass?" },
        { role: "assistant", content: [{ kind: "tool_use", toolCallId: "call_1", name: "lookup", args: { topic: "grass" } }] },
        { role: "tool", content: [{ kind: "tool_result", toolCallId: "call_1", ok: true, result: "green" }] },
        { role: "user", content: "thanks" }
      ],
      fetchImpl,
      stream: false
    });
    const body = JSON.parse(captureBody(fetchImpl));
    expect(body.instructions).toBe("Be brief.");
    expect(body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "what color is grass?" }] },
      { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"topic":"grass"}' },
      { type: "function_call_output", call_id: "call_1", output: '"green"' },
      { role: "user", content: [{ type: "input_text", text: "thanks" }] }
    ]);
  });

  it("sends reasoning.effort + summary:auto when reasoningEffort is configured, omits it otherwise", async () => {
    const completed = [{ event: "response.completed", data: { type: "response.completed", response: { usage: {} } } }];

    const withEffort = vi.fn(async () => okResponse(completed));
    await runOpenAiCodexProvider({ provider: baseProvider({ reasoningEffort: "low" }), prompt: "hi", fetchImpl: withEffort, stream: false });
    expect(JSON.parse(captureBody(withEffort)).reasoning).toEqual({ effort: "low", summary: "auto" });

    const badEffort = vi.fn(async () => okResponse(completed));
    await runOpenAiCodexProvider({ provider: baseProvider({ reasoningEffort: "turbo" }), prompt: "hi", fetchImpl: badEffort, stream: false });
    expect(JSON.parse(captureBody(badEffort)).reasoning).toBeUndefined();

    const noEffort = vi.fn(async () => okResponse(completed));
    await runOpenAiCodexProvider({ provider: baseProvider(), prompt: "hi", fetchImpl: noEffort, stream: false });
    expect(JSON.parse(captureBody(noEffort)).reasoning).toBeUndefined();
  });

  it("adds Codex-specific headers (chatgpt-account-id, originator, User-Agent) and the client_version query string", async () => {
    const fetchImpl = vi.fn(async () => okResponse([
      { event: "response.completed", data: { type: "response.completed", response: { usage: {} } } }
    ]));
    await runOpenAiCodexProvider({
      provider: baseProvider({ originator: "procway-test", clientVersion: "1.2.3" }),
      prompt: "hi",
      fetchImpl,
      stream: false
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses?client_version=1.2.3");
    expect(init.headers.Authorization).toBe("Bearer stub-access-token");
    expect(init.headers["chatgpt-account-id"]).toBe("acct-stub");
    expect(init.headers.originator).toBe("procway-test");
    expect(init.headers["User-Agent"]).toBe("procway-test/1.2.3");
    expect(init.headers.Accept).toBe("text/event-stream");
  });

  it("sends Chat-Completions-style tools without strict mode by default", async () => {
    const fetchImpl = vi.fn(async () => okResponse([
      { event: "response.completed", data: { type: "response.completed", response: { usage: {} } } }
    ]));
    await runOpenAiCodexProvider({
      provider: baseProvider(),
      prompt: "x",
      tools: [{ type: "function", function: { name: "ping", description: "noop", parameters: { type: "object", properties: { msg: { type: "string" } }, required: [] } } }],
      fetchImpl,
      stream: false
    });
    const body = JSON.parse(captureBody(fetchImpl));
    expect(body.tools).toEqual([
      { type: "function", name: "ping", description: "noop", parameters: { type: "object", properties: { msg: { type: "string" } }, required: [] } }
    ]);
    expect(body.tools[0].strict).toBeUndefined();
  });

  it("synthesizes a function_call_output for orphan function_calls (regression: TK-15 400)", async () => {
    // Simulates the on-disk state after a runner is reaped between
    // assistant.message.completed and tool.call.completed: the conversation
    // has the assistant's tool_use blocks but no matching tool result
    // messages, and the user has already typed a follow-up. Without the
    // repair pass the Codex Responses API rejects with "No tool output
    // found for function call <id>".
    const fetchImpl = vi.fn(async () => okResponse([
      { event: "response.completed", data: { type: "response.completed", response: { usage: {} } } }
    ]));
    await runOpenAiCodexProvider({
      provider: baseProvider(),
      messages: [
        { role: "user", content: "find tests" },
        { role: "assistant", content: [
          { kind: "tool_use", toolCallId: "call_a", name: "Glob", args: { pattern: "**/*.test.*" } },
          { kind: "tool_use", toolCallId: "call_b", name: "Grep", args: { pattern: "x" } }
        ] },
        // No tool messages for call_a or call_b — they were lost when the runner died.
        { role: "user", content: "失敗した理由を教えてください" }
      ],
      fetchImpl,
      stream: false
    });
    const body = JSON.parse(captureBody(fetchImpl));
    // The repair pass must place a synthesized output immediately after
    // each orphan function_call, before the next user message.
    const types = body.input.map((i) => i.type ?? i.role);
    expect(types).toEqual([
      "user",
      "function_call", "function_call_output",
      "function_call", "function_call_output",
      "user"
    ]);
    const synthA = body.input[2];
    expect(synthA.call_id).toBe("call_a");
    const parsedA = JSON.parse(synthA.output);
    expect(parsedA.synthesized).toBe(true);
    expect(parsedA.tool).toBe("Glob");
    expect(parsedA.error).toMatch(/missing/i);
    const synthB = body.input[4];
    expect(synthB.call_id).toBe("call_b");
  });

  it("drops an orphan function_call_output (regression: compaction split a tool pair → 400)", async () => {
    // Simulates a session whose summarizer kept the tool_result for call_orphan
    // in the tail while folding its assistant tool_use into the summary. Without
    // the repair pass the Codex Responses API rejects with "No tool call found
    // for function call output with call_id call_orphan".
    const fetchImpl = vi.fn(async () => okResponse([
      { event: "response.completed", data: { type: "response.completed", response: { usage: {} } } }
    ]));
    await runOpenAiCodexProvider({
      provider: baseProvider(),
      messages: [
        { role: "system", content: "【コンパクトサマリー】older turns" },
        // Orphan: no assistant tool_use carries call_orphan anywhere.
        { role: "tool", content: [{ kind: "tool_result", toolCallId: "call_orphan", ok: true, result: "stale" }] },
        { role: "assistant", content: [{ kind: "tool_use", toolCallId: "call_real", name: "Grep", args: {} }] },
        { role: "tool", content: [{ kind: "tool_result", toolCallId: "call_real", ok: true, result: "hit" }] },
        { role: "user", content: "次は？" }
      ],
      fetchImpl,
      stream: false
    });
    const body = JSON.parse(captureBody(fetchImpl));
    // The orphan output is gone; the intact call_real pair and trailing user
    // message survive in order.
    const types = body.input.map((i) => i.type ?? i.role);
    expect(types).toEqual([
      "function_call", "function_call_output",
      "user"
    ]);
    const outputs = body.input.filter((i) => i.type === "function_call_output");
    expect(outputs).toHaveLength(1);
    expect(outputs[0].call_id).toBe("call_real");
    expect(body.input.some((i) => i.call_id === "call_orphan")).toBe(false);
  });

  it("does not synthesize when a real tool output is already present", async () => {
    const fetchImpl = vi.fn(async () => okResponse([
      { event: "response.completed", data: { type: "response.completed", response: { usage: {} } } }
    ]));
    await runOpenAiCodexProvider({
      provider: baseProvider(),
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: [{ kind: "tool_use", toolCallId: "call_x", name: "lookup", args: {} }] },
        { role: "tool", content: [{ kind: "tool_result", toolCallId: "call_x", ok: true, result: "answer" }] }
      ],
      fetchImpl,
      stream: false
    });
    const body = JSON.parse(captureBody(fetchImpl));
    // Exactly one function_call_output for call_x, and it carries the real
    // result, not the synthesized error payload.
    const outputs = body.input.filter((i) => i.type === "function_call_output");
    expect(outputs).toHaveLength(1);
    expect(outputs[0].call_id).toBe("call_x");
    expect(outputs[0].output).toBe('"answer"');
  });

  it("injects strict mode + additionalProperties:false when provider.strictTools=true", async () => {
    const fetchImpl = vi.fn(async () => okResponse([
      { event: "response.completed", data: { type: "response.completed", response: { usage: {} } } }
    ]));
    await runOpenAiCodexProvider({
      provider: baseProvider({ strictTools: true }),
      prompt: "x",
      tools: [{ type: "function", function: { name: "ping", parameters: { type: "object", properties: { msg: { type: "string" } } } } }],
      fetchImpl,
      stream: false
    });
    const body = JSON.parse(captureBody(fetchImpl));
    expect(body.tools[0].strict).toBe(true);
    expect(body.tools[0].parameters.additionalProperties).toBe(false);
  });
});

describe("runOpenAiCodexProvider (openai-codex-via-proxy)", () => {
  it("skips getValidCredentials and omits Authorization + chatgpt-account-id (ADR 0008 §F7c)", async () => {
    getValidCredentials.mockClear();
    const fetchImpl = vi.fn(async () =>
      okResponse([
        { event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "ok" } },
        { event: "response.completed", data: { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } } }
      ])
    );
    const result = await runOpenAiCodexProvider({
      provider: baseProvider({
        type: "openai-codex-via-proxy",
        baseUrl: "http://procway-dashboard:3333/api/agent-llm-proxy/openai-codex"
      }),
      prompt: "hi",
      fetchImpl,
      stream: false
    });
    // The session holds no credentials — the dashboard broker injects them.
    expect(getValidCredentials).not.toHaveBeenCalled();
    const headers = fetchImpl.mock.calls[0][1].headers;
    expect(headers.Authorization).toBeUndefined();
    expect(headers["chatgpt-account-id"]).toBeUndefined();
    expect(headers.originator).toBeTruthy();
    expect(headers["User-Agent"]).toBeTruthy();
    expect(fetchImpl.mock.calls[0][0]).toContain("/api/agent-llm-proxy/openai-codex/responses?client_version=");
    expect(result.message.content).toBe("ok");
  });

  it("sends Authorization: Bearer from PROCWAY_PROXY_TOKEN when set (T1-17)", async () => {
    process.env.PROCWAY_PROXY_TOKEN = "sess-secret";
    getValidCredentials.mockClear();
    const fetchImpl = vi.fn(async () =>
      okResponse([
        { event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "ok" } },
        { event: "response.completed", data: { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } } }
      ])
    );
    const result = await runOpenAiCodexProvider({
      provider: baseProvider({
        type: "openai-codex-via-proxy",
        baseUrl: "http://procway-dashboard:3333/api/agent-llm-proxy/openai-codex"
      }),
      prompt: "hi",
      fetchImpl,
      stream: false
    });
    // Still no local OAuth lookup; we present only the session broker token,
    // which the broker strips and replaces with the real codex credential.
    expect(getValidCredentials).not.toHaveBeenCalled();
    const headers = fetchImpl.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe("Bearer sess-secret");
    expect(headers["chatgpt-account-id"]).toBeUndefined();
    expect(result.message.content).toBe("ok");
    delete process.env.PROCWAY_PROXY_TOKEN;
  });
});
