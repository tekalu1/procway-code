/**
 * Phase 6 §2.8 — opt-in OpenTelemetry tracing.
 *
 * Activated only when `env.PROCWAY_TELEMETRY === "on"` and the optional
 * dependency `@opentelemetry/sdk-node` (plus the OTLP HTTP exporter) is
 * importable. When either condition fails, `attachTelemetry` returns a no-op
 * controller — production builds without OTel installed continue working
 * exactly as before.
 *
 * Spans:
 *   - agent.session   (root, opened on `session.created` / `session.resumed`)
 *   - agent.turn      (per turn, opened on `user.prompt.submitted`)
 *   - tool.call.<name>(per tool call, opened on `tool.call.started`)
 *   - provider.request (Phase 7 — placeholder; not wired yet)
 *
 * Spans are stored in plain Maps to keep this file independent from the OTel
 * context API; we only need ordered start/end + attribute attachment.
 */

import { spanMapForBus } from "./span-mapper.mjs";

const NOOP_CONTROLLER = Object.freeze({
  enabled: false,
  flush: async () => {},
  shutdown: async () => {},
  detach: () => {}
});

export async function attachTelemetry({ events, env = process.env, settings = {}, sdkLoader = loadOtelSdk } = {}) {
  if (!isTelemetryEnabled(env)) return { ...NOOP_CONTROLLER };
  if (!events || typeof events.on !== "function") return { ...NOOP_CONTROLLER };
  const sdk = await sdkLoader({ env, settings });
  if (!sdk) return { ...NOOP_CONTROLLER };

  const controller = createSpanController({ tracer: sdk.tracer });
  const detach = spanMapForBus(events, controller);

  return {
    enabled: true,
    detach,
    async flush() {
      await sdk.flush?.();
    },
    async shutdown() {
      detach();
      await sdk.shutdown?.();
    }
  };
}

function isTelemetryEnabled(env) {
  const flag = env?.PROCWAY_TELEMETRY;
  if (typeof flag !== "string") return false;
  return ["on", "1", "true", "yes"].includes(flag.toLowerCase());
}

async function loadOtelSdk({ env, settings }) {
  let sdkPkg;
  let exporterPkg;
  let resourcesPkg;
  try {
    sdkPkg = await import("@opentelemetry/sdk-node");
    exporterPkg = await import("@opentelemetry/exporter-trace-otlp-http");
    resourcesPkg = await import("@opentelemetry/resources").catch(() => null);
  } catch {
    return null;
  }
  const SdkCtor = sdkPkg.NodeSDK ?? sdkPkg.default?.NodeSDK ?? sdkPkg.default;
  const ExporterCtor = exporterPkg.OTLPTraceExporter ?? exporterPkg.default?.OTLPTraceExporter ?? exporterPkg.default;
  if (typeof SdkCtor !== "function" || typeof ExporterCtor !== "function") return null;
  const exporter = new ExporterCtor({
    url: env?.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318/v1/traces"
  });
  const Resource = resourcesPkg?.Resource;
  const resource = Resource ? Resource.default?.({ "service.name": "procway-code" }) ?? new Resource({ "service.name": "procway-code" }) : undefined;
  const sdk = new SdkCtor({
    traceExporter: exporter,
    resource
  });
  await sdk.start?.();
  const tracerName = settings?.telemetry?.tracerName ?? "procway-code";
  const tracer = sdk.getTracer ? sdk.getTracer(tracerName) : globalThis.opentelemetry?.trace?.getTracer?.(tracerName);
  return {
    tracer,
    flush: async () => {
      try { await exporter.forceFlush?.(); } catch { /* ignored */ }
    },
    shutdown: async () => {
      try { await sdk.shutdown?.(); } catch { /* ignored */ }
    }
  };
}

function createSpanController({ tracer }) {
  const sessions = new Map();
  const turns = new Map();
  const toolCalls = new Map();
  const startSpan = (name, attributes = {}, parent = null) => {
    if (!tracer) return null;
    const options = { attributes };
    if (parent && tracer.startSpan?.length >= 2) options.parent = parent;
    try {
      return tracer.startSpan(name, options);
    } catch {
      return null;
    }
  };
  return {
    sessionStarted({ sessionId, attributes }) {
      const span = startSpan("agent.session", { ...attributes, "session.id": sessionId });
      if (span) sessions.set(sessionId, span);
    },
    sessionEnded({ sessionId }) {
      const span = sessions.get(sessionId);
      if (!span) return;
      sessions.delete(sessionId);
      try { span.end?.(); } catch { /* ignored */ }
    },
    turnStarted({ sessionId, messageId, attributes }) {
      const parent = sessions.get(sessionId);
      const span = startSpan("agent.turn", { ...attributes, "session.id": sessionId, "turn.message.id": messageId }, parent);
      if (span) turns.set(messageId, span);
    },
    turnEnded({ messageId, attributes = {} }) {
      const span = turns.get(messageId);
      if (!span) return;
      turns.delete(messageId);
      try { span.setAttributes?.(attributes); } catch { /* ignored */ }
      try { span.end?.(); } catch { /* ignored */ }
    },
    toolCallStarted({ toolCallId, name, sessionId }) {
      const parent = sessions.get(sessionId);
      const span = startSpan(`tool.call.${name ?? "unknown"}`, {
        "tool.id": toolCallId,
        "tool.name": name,
        "session.id": sessionId
      }, parent);
      if (span) toolCalls.set(toolCallId, span);
    },
    toolCallEnded({ toolCallId, attributes = {} }) {
      const span = toolCalls.get(toolCallId);
      if (!span) return;
      toolCalls.delete(toolCallId);
      try { span.setAttributes?.(attributes); } catch { /* ignored */ }
      try { span.end?.(); } catch { /* ignored */ }
    },
    snapshot() {
      return {
        sessions: sessions.size,
        turns: turns.size,
        toolCalls: toolCalls.size
      };
    }
  };
}
