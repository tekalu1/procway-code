import { describe, expect, it } from "vitest";
import { executeModelRound } from "../src/agent/turn-orchestrator.mjs";
import { EventBus } from "../src/core/events/bus.mjs";

class FakeProviderError extends Error {
  constructor(message, code = "ECONNRESET") {
    super(message);
    this.code = code;
  }
}

function makeSession() {
  const events = new EventBus();
  const observed = [];
  events.on("*", (event) => observed.push(event));
  return {
    events,
    observed,
    session: {
      sessionId: "abort-test",
      messages: [],
      tools: [],
      cwd: process.cwd(),
      settings: {},
      events
    }
  };
}

describe("streaming HTTP abort partialContent (phase5 carryover)", () => {
  it("emits turn.failed with partialContent[] when the deltaStream throws mid-stream", async () => {
    const { session, observed } = makeSession();

    const runProviderImpl = async () => ({
      deltaStream: (async function* () {
        yield { deltaText: "Hello " };
        yield { deltaText: "world" };
        throw new FakeProviderError("network aborted");
      })(),
      finalize: async () => ({})
    });

    let caught;
    try {
      await executeModelRound({ session, round: 0, runProviderImpl });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.code).toBe("ECONNRESET");

    const failure = observed.find((event) => event.type === "turn.failed");
    expect(failure).toBeTruthy();
    expect(failure.partialContent).toEqual([{ kind: "text", text: "Hello world" }]);
    expect(failure.error.message).toMatch(/network aborted/);
  });

  it("does not attach partialContent when the stream throws before any delta", async () => {
    const { session, observed } = makeSession();
    const runProviderImpl = async () => ({
      deltaStream: (async function* () {
        throw new FakeProviderError("immediate failure");
      })(),
      finalize: async () => ({})
    });
    let caught;
    try {
      await executeModelRound({ session, round: 0, runProviderImpl });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const failure = observed.find((event) => event.type === "turn.failed");
    expect(failure).toBeTruthy();
    expect(failure.partialContent).toBeUndefined();
  });

  it("does not double-emit turn.failed when the inner orchestrator already did", async () => {
    const { session, observed } = makeSession();
    const error = new FakeProviderError("network aborted");
    const runProviderImpl = async () => ({
      deltaStream: (async function* () {
        yield { deltaText: "partial" };
        throw error;
      })(),
      finalize: async () => ({})
    });
    try {
      await executeModelRound({ session, round: 0, runProviderImpl });
    } catch {
      // expected
    }
    const failures = observed.filter((event) => event.type === "turn.failed");
    expect(failures).toHaveLength(1);
    expect(error.turnFailedEmitted).toBe(true);
  });
});
