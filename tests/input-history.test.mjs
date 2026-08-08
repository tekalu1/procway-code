import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createInputHistory, getHistoryPath, looksLikeSecret } from "../src/adapters/tui/input-history.mjs";

async function tempFile(name = "history") {
  const dir = await mkdtemp(path.join(os.tmpdir(), "procway-history-"));
  return path.join(dir, name);
}

describe("persistent REPL history (P2-6)", () => {
  it("lives next to the session store under ~/.procway/ai-agent", () => {
    expect(getHistoryPath({ homeDir: "/home/u" })).toBe("/home/u/.procway/ai-agent/history");
  });

  it("round-trips entries across processes, keeping multi-line prompts intact", async () => {
    const filePath = await tempFile();
    const first = createInputHistory({ filePath });
    await first.load();
    first.record("one");
    first.record("line a\nline b");
    expect(await first.save()).toBe(true);

    const raw = await readFile(filePath, "utf8");
    expect(raw.split("\n").filter(Boolean)).toHaveLength(2);
    expect(raw).toContain("line a\\nline b");

    const second = createInputHistory({ filePath });
    expect(await second.load()).toEqual(["one", "line a\nline b"]);
  });

  it("caps the file at maxEntries, keeping the newest", async () => {
    const filePath = await tempFile();
    const history = createInputHistory({ filePath, maxEntries: 3 });
    await history.load();
    for (const value of ["a", "b", "c", "d", "e"]) history.record(value);
    await history.save();
    const reloaded = createInputHistory({ filePath, maxEntries: 3 });
    expect(await reloaded.load()).toEqual(["c", "d", "e"]);
  });

  it("skips blanks and consecutive duplicates", async () => {
    const history = createInputHistory({ filePath: await tempFile() });
    await history.load();
    expect(history.record("  ")).toBe(false);
    expect(history.record("same")).toBe(true);
    expect(history.record("same")).toBe(false);
    expect(history.entries).toEqual(["same"]);
  });

  it("never records anything that looks like a credential", async () => {
    const history = createInputHistory({ filePath: await tempFile() });
    await history.load();
    expect(history.record("sk-abcdefghijklmnopqrstuvwx")).toBe(false);
    expect(history.record("ghp_abcdefghijklmnopqrstuvwxyz12")).toBe(false);
    expect(history.record("export API_KEY=supersecretvalue1")).toBe(false);
    expect(history.record("fix the failing test")).toBe(true);
    expect(history.entries).toEqual(["fix the failing test"]);
    expect(looksLikeSecret("just a normal sentence about tokens")).toBe(false);
  });

  it("walks backwards and forwards, stashing the in-progress draft", async () => {
    const history = createInputHistory({ filePath: await tempFile() });
    await history.load();
    history.record("first");
    history.record("second");
    expect(history.previous("draft")).toBe("second");
    expect(history.previous()).toBe("first");
    expect(history.previous()).toBe("first"); // clamped at the oldest
    expect(history.next()).toBe("second");
    expect(history.next()).toBe("draft");
  });

  it("survives a corrupt / missing file", async () => {
    const filePath = await tempFile();
    const history = createInputHistory({ filePath });
    expect(await history.load()).toEqual([]);
    await writeFile(filePath, "\n\n", "utf8");
    expect(await createInputHistory({ filePath }).load()).toEqual([]);
  });
});
