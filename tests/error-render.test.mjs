import { describe, expect, it } from "vitest";
import { classifyTurnError, renderTurnError } from "../src/adapters/tui/error-render.mjs";
import { visibleWidth } from "../src/adapters/tui/ansi.mjs";

/**
 * P3b-10. The regression this guards: `Turn failed: Missing API key
 * environment variable: OPENROUTER_API_KEY` told the user nothing about what
 * to do next.
 */
describe("turn error guidance", () => {
  it("points a missing API key at /config setup and names the variable", () => {
    const classified = classifyTurnError(new Error("Missing API key environment variable: OPENROUTER_API_KEY"));
    expect(classified.kind).toBe("missing-api-key");
    const rendered = renderTurnError(new Error("Missing API key environment variable: OPENROUTER_API_KEY"), { color: false });
    expect(rendered).toContain("/config setup");
    expect(rendered).toContain("config set-secret OPENROUTER_API_KEY");
  });

  it("recognises a rate limit by status and by message", () => {
    expect(classifyTurnError(Object.assign(new Error("slow down"), { status: 429 })).kind).toBe("rate-limit");
    expect(classifyTurnError(new Error("Rate limit exceeded for requests")).kind).toBe("rate-limit");
    expect(renderTurnError(Object.assign(new Error("slow down"), { status: 429 }), { color: false }))
      .toContain("Wait a few seconds");
  });

  it("recognises auth rejections", () => {
    expect(classifyTurnError(Object.assign(new Error("nope"), { status: 401 })).kind).toBe("auth");
    expect(classifyTurnError(new Error("invalid_api_key")).kind).toBe("auth");
    expect(renderTurnError(Object.assign(new Error("nope"), { status: 403 }), { color: false }))
      .toContain("auth login");
  });

  it("recognises network failures and mentions the proxy", () => {
    for (const message of ["fetch failed", "getaddrinfo ENOTFOUND api.openai.com", "socket hang up"]) {
      expect(classifyTurnError(new Error(message)).kind, message).toBe("network");
    }
    expect(renderTurnError(new Error("fetch failed"), { color: false })).toContain("HTTPS_PROXY");
  });

  it("keeps the idle watchdog and the user interrupt apart", () => {
    const idle = classifyTurnError(Object.assign(new Error("The model sent nothing for 180s"), { code: "idle_timeout" }));
    expect(idle.kind).toBe("idle-timeout");
    expect(idle.hints.join(" ")).toContain("PROCWAY_TURN_IDLE_TIMEOUT_MS");
    expect(classifyTurnError(Object.assign(new Error("Interrupted by user"), { code: "interrupted" })).kind).toBe("interrupted");
  });

  it("treats 5xx as transient and everything else as unknown", () => {
    expect(classifyTurnError(Object.assign(new Error("boom"), { status: 503 })).kind).toBe("provider-error");
    const unknown = classifyTurnError(Object.assign(new Error("something odd"), { retryable: true }));
    expect(unknown.kind).toBe("unknown");
    expect(unknown.hints).toHaveLength(1);
  });

  it("stays inside a narrow terminal", () => {
    const rendered = renderTurnError(new Error("Missing API key environment variable: A_VERY_LONG_ENVIRONMENT_VARIABLE_NAME"), { width: 50, color: false });
    for (const line of rendered.split("\n")) expect(visibleWidth(line)).toBeLessThanOrEqual(50);
  });
});
