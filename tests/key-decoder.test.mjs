import { describe, expect, it } from "vitest";
import { createKeyDecoder } from "../src/adapters/tui/key-decoder.mjs";

function decode(chunks) {
  const decoder = createKeyDecoder();
  const out = [];
  for (const chunk of [].concat(chunks)) out.push(...decoder.push(chunk));
  return out;
}

describe("raw key decoder", () => {
  it("batches printable runs into one text event (IME commits stay whole)", () => {
    expect(decode("日本語です")).toEqual([{ type: "text", text: "日本語です" }]);
  });

  it("keeps Ctrl+J (0x0a) distinct from Return (0x0d)", () => {
    const events = decode("\r\n");
    expect(events.map((e) => e.name)).toEqual(["return", "linefeed"]);
  });

  it("decodes Esc+Enter as a meta return (macOS Option+Enter / Shift+Enter binding)", () => {
    const [event] = decode("\x1b\r");
    expect(event).toMatchObject({ name: "return", meta: true });
  });

  it("decodes control letters, backspace and delete", () => {
    expect(decode("\x03")[0]).toMatchObject({ name: "c", ctrl: true });
    expect(decode("\x04")[0]).toMatchObject({ name: "d", ctrl: true });
    expect(decode("\x17")[0]).toMatchObject({ name: "w", ctrl: true });
    expect(decode("\x7f")[0]).toMatchObject({ name: "backspace" });
    expect(decode("\x1b[3~")[0]).toMatchObject({ name: "delete" });
  });

  it("decodes arrows, Ctrl+arrows and SS3 cursor keys", () => {
    expect(decode("\x1b[A")[0]).toMatchObject({ name: "up", ctrl: false });
    expect(decode("\x1b[1;5C")[0]).toMatchObject({ name: "right", ctrl: true });
    expect(decode("\x1b[1;2D")[0]).toMatchObject({ name: "left", shift: true });
    expect(decode("\x1bOB")[0]).toMatchObject({ name: "down" });
    expect(decode("\x1b[H")[0]).toMatchObject({ name: "home" });
  });

  it("bundles a bracketed paste into a single event", () => {
    const events = decode("\x1b[200~one\ntwo\nthree\x1b[201~");
    expect(events).toEqual([{ type: "paste", text: "one\ntwo\nthree" }]);
  });

  it("bundles a paste that arrives across several chunks", () => {
    const events = decode(["\x1b[200~alpha\nbe", "ta\x1b[201", "~done"]);
    expect(events[0]).toEqual({ type: "paste", text: "alpha\nbeta" });
    expect(events[1]).toEqual({ type: "text", text: "done" });
  });

  it("holds an incomplete escape sequence until the rest arrives", () => {
    const decoder = createKeyDecoder();
    expect(decoder.push("\x1b[")).toEqual([]);
    expect(decoder.push("1;5D")[0]).toMatchObject({ name: "left", ctrl: true });
  });

  it("flush() turns a lone trailing ESC into an escape key", () => {
    const decoder = createKeyDecoder();
    expect(decoder.push("\x1b")).toEqual([]);
    expect(decoder.flush()[0]).toMatchObject({ name: "escape" });
  });

  it("decodes Alt+b / Alt+f as meta letters", () => {
    expect(decode("\x1bb")[0]).toMatchObject({ name: "b", meta: true });
    expect(decode("\x1bf")[0]).toMatchObject({ name: "f", meta: true });
  });
});
