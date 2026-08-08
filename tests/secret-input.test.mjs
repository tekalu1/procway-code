import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { readSecretInput } from "../src/adapters/tui/secret-input.mjs";

function makeTty() {
  const input = new EventEmitter();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = vi.fn((raw) => { input.isRaw = raw; });
  input.resume = vi.fn();
  input.pause = vi.fn();
  return input;
}

describe("secret TTY input", () => {
  it("detaches readline-style data listeners so the token is never echoed", async () => {
    const input = makeTty();
    let displayed = "";
    const output = { write: (text) => { displayed += text; } };
    const readlineEcho = (chunk) => { displayed += chunk.toString(); };
    input.on("data", readlineEcho);

    const pending = readSecretInput({ input, output, prompt: "Token: ", suspendDataListeners: true });
    input.emit("data", Buffer.from("super-secret\n"));

    await expect(pending).resolves.toBe("super-secret");
    expect(displayed).toBe("Token: \n");
    expect(input.listeners("data")).toContain(readlineEcho);
    expect(input.setRawMode).toHaveBeenNthCalledWith(1, true);
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it("supports backspace and restores listeners after cancellation", async () => {
    const input = makeTty();
    const output = { write: vi.fn() };
    const owner = vi.fn();
    input.on("data", owner);
    const pending = readSecretInput({ input, output, suspendDataListeners: true });
    input.emit("data", Buffer.from("ab\u007fc\u0003"));

    await expect(pending).rejects.toThrow("cancelled");
    expect(input.listeners("data")).toContain(owner);
    expect(input.isRaw).toBe(false);
  });
});
