import { describe, expect, it } from "vitest";
import { completeAtPath, createReplCompleter } from "../src/adapters/tui/path-completion.mjs";
import { createSlashCompleter } from "../src/adapters/tui/slash-completion.mjs";

const fakeFs = {
  readdirSync(dir) {
    if (dir.endsWith("/repo")) return ["src", "tests", "README.md", ".hidden"];
    if (dir.endsWith("/repo/src")) return ["cli.mjs", "adapters"];
    throw new Error("ENOENT");
  },
  statSync(file) {
    const isDir = /\/(src|tests|adapters)$/.test(file);
    return { isDirectory: () => isDir };
  }
};

describe("@path completion (P2-7)", () => {
  it("completes top-level entries and marks directories with a slash", () => {
    const [matches, head] = completeAtPath("", "/repo", fakeFs);
    expect(head).toBe("@");
    expect(matches).toEqual(["@README.md", "@src/", "@tests/"]);
  });

  it("completes inside a directory and keeps the typed prefix as the head", () => {
    const [matches, head] = completeAtPath("src/c", "/repo", fakeFs);
    expect(head).toBe("@src/c");
    expect(matches).toEqual(["@src/cli.mjs"]);
  });

  it("hides dotfiles until the dot is typed", () => {
    expect(completeAtPath(".", "/repo", fakeFs)[0]).toEqual(["@.hidden"]);
  });

  it("returns nothing for an unreadable directory instead of throwing", () => {
    expect(completeAtPath("nope/x", "/repo", fakeFs)).toEqual([[], "@nope/x"]);
  });
});

describe("REPL completer", () => {
  const completer = createReplCompleter({
    cwd: "/repo",
    slashCompleter: createSlashCompleter(),
    fs: fakeFs
  });

  it("still completes slash commands", () => {
    const [matches, head] = completer("/co");
    expect(head).toBe("/co");
    expect(matches).toEqual(["/compact", "/config", "/context"]);
  });

  it("completes an @path in the middle of a sentence — the old completer bailed out", () => {
    const [matches, head] = completer("please read @src/c");
    expect(head).toBe("@src/c");
    expect(matches).toEqual(["@src/cli.mjs"]);
  });

  it("returns no matches for ordinary prose", () => {
    expect(completer("just talking")).toEqual([[], "just talking"]);
  });
});
