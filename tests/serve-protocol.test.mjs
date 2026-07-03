import { describe, expect, it } from "vitest";
import {
  CLIENT_KINDS,
  COMMANDS,
  PROTOCOL_VERSION,
  SERVER_KINDS,
  isClientMessage,
  isServerMessage,
  makeErrorMessage,
  makeEvent,
  makeReady,
  makeResponse,
  parseClientMessage,
  validateListSessionsArgs,
  validateLoadSessionArgs
} from "../src/adapters/serve/protocol.mjs";

describe("serve protocol", () => {
  it("exposes the expected message kinds and commands", () => {
    expect(SERVER_KINDS).toEqual(["ready", "event", "response", "error"]);
    expect(CLIENT_KINDS).toEqual(["command"]);
    expect(COMMANDS).toContain("runTurn");
    expect(COMMANDS).toContain("approve");
    expect(COMMANDS).toContain("compact");
    expect(COMMANDS).toContain("history");
    expect(COMMANDS).toContain("abort");
    expect(COMMANDS).toContain("listSessions");
    expect(COMMANDS).toContain("loadSession");
  });

  // ADR 0030 D4: the serve protocol negotiates via `protocolVersion` on
  // `ready` — an integer independent of the package version. Bump this
  // assertion ONLY on a breaking protocol change (message shapes, semantics
  // of existing COMMANDS); backward-compatible additions keep it at 1.
  it("stamps protocolVersion 1 on the ready frame, independent of the package version", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    const ready = makeReady({ sessionId: "s1", version: "0.1.0" });
    expect(ready.protocolVersion).toBe(PROTOCOL_VERSION);
    // The package version stays as-is, informational only.
    expect(ready.version).toBe("0.1.0");
  });

  it("makeReady / makeEvent / makeResponse build valid server messages", () => {
    const ready = makeReady({ sessionId: "s1", version: "0.1.0" });
    expect(ready).toEqual({ kind: "ready", sessionId: "s1", version: "0.1.0", protocolVersion: 1 });
    expect(isServerMessage(ready)).toBe(true);

    const event = makeEvent({ type: "turn.completed", round: 0, exitCode: 0 });
    expect(event.kind).toBe("event");
    expect(event.event.type).toBe("turn.completed");
    expect(isServerMessage(event)).toBe(true);

    const ok = makeResponse({ id: "1", ok: true, result: { ok: true } });
    expect(ok).toEqual({ kind: "response", id: "1", ok: true, result: { ok: true } });
    const fail = makeResponse({ id: "2", ok: false, error: "boom" });
    expect(fail).toEqual({ kind: "response", id: "2", ok: false, error: "boom" });
    const failStruct = makeResponse({ id: "3", ok: false, error: { code: "session_not_found", message: "missing" } });
    expect(failStruct).toEqual({ kind: "response", id: "3", ok: false, error: { code: "session_not_found", message: "missing" } });

    const errMsg = makeErrorMessage({ error: "x", fatal: true });
    expect(errMsg).toEqual({ kind: "error", error: "x", fatal: true });
  });

  it("parseClientMessage accepts well-formed commands and rejects others", () => {
    const ok = parseClientMessage(JSON.stringify({ kind: "command", command: "runTurn", id: "1", args: { prompt: "hi" } }));
    expect(ok).toMatchObject({ kind: "command", command: "runTurn", id: "1" });
    expect(ok.args.prompt).toBe("hi");
    expect(isClientMessage(ok)).toBe(true);

    expect(parseClientMessage("not-json")).toBeNull();
    expect(parseClientMessage(JSON.stringify({ kind: "command", command: "noSuch" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ kind: "event", type: "turn.completed" }))).toBeNull();
    expect(parseClientMessage(Buffer.from(JSON.stringify({ kind: "command", command: "compact" })))).toMatchObject({ command: "compact" });
    expect(parseClientMessage(JSON.stringify({ kind: "command", command: "listSessions" }))).toMatchObject({ command: "listSessions" });
    expect(parseClientMessage(JSON.stringify({ kind: "command", command: "loadSession", args: { sessionId: "s1" } }))).toMatchObject({ command: "loadSession" });
  });

  it("validateListSessionsArgs accepts valid args and rejects out-of-range / wrong-type fields", () => {
    expect(() => validateListSessionsArgs(undefined)).not.toThrow();
    expect(() => validateListSessionsArgs({})).not.toThrow();
    expect(() => validateListSessionsArgs({ limit: 1 })).not.toThrow();
    expect(() => validateListSessionsArgs({ limit: 200 })).not.toThrow();
    expect(() => validateListSessionsArgs({ limit: 50, cursor: "abc" })).not.toThrow();
    expect(() => validateListSessionsArgs({ limit: 0 })).toThrowError(/limit/);
    expect(() => validateListSessionsArgs({ limit: 201 })).toThrowError(/limit/);
    expect(() => validateListSessionsArgs({ limit: 1.5 })).toThrowError(/limit/);
    expect(() => validateListSessionsArgs({ cursor: 42 })).toThrowError(/cursor/);
    expect(() => validateListSessionsArgs({ cursor: {} })).toThrowError(/cursor/);
  });

  it("validateLoadSessionArgs requires a non-empty string sessionId", () => {
    expect(() => validateLoadSessionArgs({ sessionId: "abc" })).not.toThrow();
    expect(() => validateLoadSessionArgs({})).toThrowError(/sessionId/);
    expect(() => validateLoadSessionArgs({ sessionId: "" })).toThrowError(/sessionId/);
    expect(() => validateLoadSessionArgs({ sessionId: 123 })).toThrowError(/sessionId/);
    expect(() => validateLoadSessionArgs(undefined)).toThrowError(/sessionId/);
  });
});
