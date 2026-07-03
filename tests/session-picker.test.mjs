import { describe, expect, it } from "vitest";
import { pickSession, printSessionChoices } from "../src/adapters/tui/session-picker.mjs";

describe("session picker", () => {
  it("prints sessions in non-interactive mode and returns the latest", async () => {
    let output = "";
    const sessions = [
      { sessionId: "a", updatedAt: "2026", model: "m", title: "first" },
      { sessionId: "b", updatedAt: "2025", model: "m", title: "second" }
    ];

    const picked = await pickSession({
      sessions,
      input: { isTTY: false },
      output: { isTTY: false, write: (value) => { output += value; } }
    });

    expect(picked.sessionId).toBe("a");
    expect(output).toContain("a  2026  m  first");
  });

  it("prints choices", () => {
    let output = "";
    printSessionChoices({
      sessions: [{ sessionId: "a", updatedAt: "2026", model: "m", title: "first" }],
      output: { write: (value) => { output += value; } }
    });
    expect(output).toBe("a  2026  m  first\n");
  });
});
