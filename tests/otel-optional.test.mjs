import { describe, expect, it, beforeEach, vi } from "vitest";
import { attachTelemetry, __resetOtelWarning } from "../src/telemetry/otel.mjs";

const events = { on: () => () => {}, off: () => {} };

describe("telemetry without the OpenTelemetry packages installed", () => {
  beforeEach(() => {
    __resetOtelWarning();
  });

  it("returns a no-op controller instead of throwing", async () => {
    const controller = await attachTelemetry({ events, env: { PROCWAY_TELEMETRY: "on" } });
    expect(controller.enabled).toBe(false);
    // The no-op must still satisfy the full contract — cli.mjs calls these on
    // shutdown regardless of whether tracing ever started.
    await expect(controller.flush()).resolves.toBeUndefined();
    await expect(controller.shutdown()).resolves.toBeUndefined();
    expect(() => controller.detach()).not.toThrow();
  });

  it("tells the user what to install, exactly once per process", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await attachTelemetry({ events, env: { PROCWAY_TELEMETRY: "on" } });
      await attachTelemetry({ events, env: { PROCWAY_TELEMETRY: "on" } });
      await attachTelemetry({ events, env: { PROCWAY_TELEMETRY: "1" } });

      expect(write).toHaveBeenCalledTimes(1);
      const message = write.mock.calls[0][0];
      expect(message).toContain("PROCWAY_TELEMETRY");
      // The install line must name every package otel.mjs imports, or the
      // advice sends people back for a second round.
      expect(message).toContain("@opentelemetry/sdk-node");
      expect(message).toContain("@opentelemetry/exporter-trace-otlp-http");
      expect(message).toContain("@opentelemetry/resources");
    } finally {
      write.mockRestore();
    }
  });

  it("stays silent when telemetry is off", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const controller = await attachTelemetry({ events, env: {} });
      expect(controller.enabled).toBe(false);
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });

  it("honours PROCWAY_TELEMETRY_QUIET for callers that embed the CLI", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await attachTelemetry({
        events,
        env: { PROCWAY_TELEMETRY: "on", PROCWAY_TELEMETRY_QUIET: "1" }
      });
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });
});
