import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attachTelemetry } from "../src/telemetry/otel.mjs";
import { spanMapForBus } from "../src/telemetry/span-mapper.mjs";
import { EventBus } from "../src/core/events/bus.mjs";
import { createEvent } from "../src/core/events/types.mjs";
import { createAgentSession } from "../src/core/index.mjs";

const echoBin = fileURLToPath(new URL("./fixtures/cli-agent-echo.mjs", import.meta.url));

function settingsForCliAgent() {
  return {
    defaultProvider: "echo-agent",
    defaultModel: "echo",
    approvalMode: "auto-readonly",
    agents: { defaultTimeoutMs: 5000, maxDepth: 1, maxConcurrentAgents: 1 },
    tools: { maxToolRounds: 1, maxParallelTools: 1 },
    providers: {
      "echo-agent": {
        type: "cli-agent",
        command: process.execPath,
        args: [echoBin],
        stdinMode: "json"
      }
    },
    mcpServers: {},
    session: { enabled: false },
    context: { compatibilityMode: "claude" }
  };
}

function fakeRecordingTracer() {
  const spans = [];
  let counter = 0;
  return {
    spans,
    startSpan(name, options = {}) {
      counter += 1;
      const span = {
        spanId: counter,
        name,
        attributes: { ...(options.attributes ?? {}) },
        ended: false,
        setAttributes(attrs) { Object.assign(this.attributes, attrs); },
        end() { this.ended = true; }
      };
      spans.push(span);
      return span;
    }
  };
}

describe("telemetry attach", () => {
  it("returns a no-op controller when PROCWAY_TELEMETRY is not set", async () => {
    const events = new EventBus();
    const controller = await attachTelemetry({ events, env: {}, settings: {} });
    expect(controller.enabled).toBe(false);
    events.emit(createEvent("session.created", { sessionId: "s-off", cwd: ".", provider: "p", model: "m" }));
    await controller.flush();
    await controller.shutdown();
  });

  it("returns a no-op controller when the OTel SDK is not installed", async () => {
    const events = new EventBus();
    const controller = await attachTelemetry({
      events,
      env: { PROCWAY_TELEMETRY: "on" },
      settings: {},
      sdkLoader: async () => null
    });
    expect(controller.enabled).toBe(false);
  });

  it("wires session/turn/tool span lifecycle when tracer is available", async () => {
    const events = new EventBus();
    const tracer = fakeRecordingTracer();
    const controller = await attachTelemetry({
      events,
      env: { PROCWAY_TELEMETRY: "on" },
      settings: {},
      sdkLoader: async () => ({
        tracer,
        flush: async () => {},
        shutdown: async () => {}
      })
    });
    expect(controller.enabled).toBe(true);

    events.emit(createEvent("session.created", {
      sessionId: "s-on",
      cwd: ".",
      provider: "openai",
      model: "gpt-5"
    }));
    events.emit(createEvent("user.prompt.submitted", {
      sessionId: "s-on",
      messageId: "msg-1",
      content: [{ kind: "text", text: "hello" }]
    }));
    events.emit(createEvent("tool.call.started", {
      sessionId: "s-on",
      toolCallId: "tc-1",
      name: "read_file"
    }));
    events.emit(createEvent("tool.call.completed", {
      sessionId: "s-on",
      toolCallId: "tc-1",
      ok: true,
      result: { kind: "read_file", summary: "ok", data: {} }
    }));
    events.emit(createEvent("turn.completed", {
      sessionId: "s-on",
      messageId: "msg-1",
      round: 0,
      exitCode: 0
    }));

    expect(tracer.spans.map((span) => span.name)).toEqual(expect.arrayContaining([
      "agent.session",
      "agent.turn",
      "tool.call.read_file"
    ]));
    const toolSpan = tracer.spans.find((span) => span.name === "tool.call.read_file");
    expect(toolSpan.ended).toBe(true);
    expect(toolSpan.attributes.ok).toBe(true);

    await controller.shutdown();
  });
});

describe("span lifecycle from real session events (phase6_E-3 / E-4)", () => {
  let cwd;
  beforeEach(async () => { cwd = await mkdtemp(path.join(os.tmpdir(), "procway-telemetry-")); });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  it("closes turn span using user.prompt.submitted messageId from runTurn", async () => {
    const events = new EventBus();
    const tracer = fakeRecordingTracer();
    const controller = await attachTelemetry({
      events,
      env: { PROCWAY_TELEMETRY: "on" },
      settings: {},
      sdkLoader: async () => ({ tracer, flush: async () => {}, shutdown: async () => {} })
    });
    const session = await createAgentSession({
      settings: settingsForCliAgent(),
      cwd,
      sessionId: "tel-e4",
      events
    });
    await session.runTurn("hello span");
    await session.flushEventLog();

    const turnSpans = tracer.spans.filter((span) => span.name === "agent.turn");
    expect(turnSpans).toHaveLength(1);
    expect(turnSpans[0].ended).toBe(true);
    await controller.shutdown();
  });

  it("opens tool span with the actual tool name when turn-orchestrator emits tool.call.started", async () => {
    const { executeToolsRound } = await import("../src/agent/turn-orchestrator.mjs");
    const { AgentSession } = await import("../src/agent/conversation.mjs");
    const events = new EventBus();
    const tracer = fakeRecordingTracer();
    const controller = await attachTelemetry({
      events,
      env: { PROCWAY_TELEMETRY: "on" },
      settings: {},
      sdkLoader: async () => ({ tracer, flush: async () => {}, shutdown: async () => {} })
    });
    const session = new AgentSession({
      settings: { tools: { maxParallelTools: 2 }, session: { enabled: false }, agents: {} },
      cwd,
      sessionId: "tel-e3",
      events
    });
    await session.initialize();
    session.messages = [];
    session.executeSingleToolCall = async () => ({ kind: "read_file", summary: "ok", data: { path: "x" } });
    await executeToolsRound({
      session,
      round: 1,
      toolCalls: [{ id: "tc-99", name: "read_file", args: { filePath: "x" } }],
      messageId: "asst-1",
      response: { usage: { inputTokens: 1, outputTokens: 1 } }
    });
    const toolSpans = tracer.spans.filter((span) => span.name.startsWith("tool.call."));
    expect(toolSpans).toHaveLength(1);
    expect(toolSpans[0].name).toBe("tool.call.read_file");
    expect(toolSpans[0].attributes["tool.name"]).toBe("read_file");
    await controller.shutdown();
  });
});

describe("spanMapForBus", () => {
  it("returns a detach function that unsubscribes all handlers", () => {
    const events = new EventBus();
    const calls = [];
    const detach = spanMapForBus(events, {
      sessionStarted: (args) => calls.push(["start", args]),
      sessionEnded: () => calls.push(["end-session"]),
      turnStarted: (args) => calls.push(["turn-start", args]),
      turnEnded: (args) => calls.push(["turn-end", args]),
      toolCallStarted: (args) => calls.push(["tool-start", args]),
      toolCallEnded: (args) => calls.push(["tool-end", args])
    });
    events.emit(createEvent("session.created", { sessionId: "s-1", cwd: ".", provider: "p", model: "m" }));
    expect(calls.find((entry) => entry[0] === "start")).toBeTruthy();
    detach();
    events.emit(createEvent("session.created", { sessionId: "s-2", cwd: ".", provider: "p", model: "m" }));
    const startCount = calls.filter((entry) => entry[0] === "start").length;
    expect(startCount).toBe(1);
  });
});
