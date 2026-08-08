import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { runGrep } from "../src/tools/grep.mjs";

function makeFailingSpawn() {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => child.emit("error", new Error("ENOENT")));
    return child;
  };
}

// A spawn impl that lets us drive stdout/stderr/close manually and verifies
// the consumer attached a stderr drain.
function makeProgrammableSpawn() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  const spawnImpl = vi.fn(() => child);
  spawnImpl.child = child;
  return spawnImpl;
}

describe("Grep tool (JS fallback)", () => {
  let cwd;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "procway-grep-"));
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(path.join(cwd, "src", "a.mjs"), "import foo from 'foo';\nexport function ok() { return 1; }\n", "utf8");
    await writeFile(path.join(cwd, "src", "b.mjs"), "export const Ok = 'capital';\n", "utf8");
    await writeFile(path.join(cwd, "src", "c.txt"), "match-in-text-file ok\n", "utf8");
    await writeFile(path.join(cwd, "node_modules-info.txt"), "should-not-match\n", "utf8");
    await mkdir(path.join(cwd, "node_modules"), { recursive: true });
    await writeFile(path.join(cwd, "node_modules", "ignored.mjs"), "ok again\n", "utf8");
    await writeFile(path.join(cwd, ".gitignore"), "c.txt\n", "utf8");
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("matches case-sensitively by default", async () => {
    const result = await runGrep({ pattern: "ok", cwd, spawnImpl: makeFailingSpawn() });
    const paths = result.data.matches.map((m) => m.relPath);
    expect(paths).toContain("src/a.mjs");
    expect(paths).not.toContain("src/b.mjs");
  });

  it("matches case-insensitively when caseInsensitive=true", async () => {
    const result = await runGrep({ pattern: "ok", caseInsensitive: true, cwd, spawnImpl: makeFailingSpawn() });
    const paths = result.data.matches.map((m) => m.relPath);
    expect(paths).toContain("src/a.mjs");
    expect(paths).toContain("src/b.mjs");
  });

  it("filters files via the glob option", async () => {
    const result = await runGrep({ pattern: "ok", glob: "*.mjs", cwd, spawnImpl: makeFailingSpawn() });
    const paths = result.data.matches.map((m) => m.relPath);
    expect(paths).toContain("src/a.mjs");
    expect(paths).not.toContain("src/c.txt");
  });

  it("respects .gitignore by default", async () => {
    const result = await runGrep({ pattern: "match-in-text-file", cwd, spawnImpl: makeFailingSpawn() });
    expect(result.data.matches).toHaveLength(0);
  });

  it("excludes node_modules from JS fallback walks", async () => {
    const result = await runGrep({ pattern: "ok again", cwd, spawnImpl: makeFailingSpawn() });
    expect(result.data.matches).toHaveLength(0);
  });

  it("rejects malformed regexes with TypeError", async () => {
    await expect(runGrep({ pattern: "(", cwd, spawnImpl: makeFailingSpawn() })).rejects.toThrow(/invalid regex/);
  });

  it("returns line + relPath in match entries", async () => {
    const result = await runGrep({ pattern: "function", cwd, spawnImpl: makeFailingSpawn() });
    expect(result.data.matches[0]).toEqual(expect.objectContaining({
      relPath: "src/a.mjs",
      line: expect.any(Number),
      text: expect.stringContaining("function")
    }));
  });

  it("excludes .pnpm-store from JS fallback walks", async () => {
    await mkdir(path.join(cwd, ".pnpm-store"), { recursive: true });
    await writeFile(path.join(cwd, ".pnpm-store", "pkg.mjs"), "ok pnpm-store\n", "utf8");
    const result = await runGrep({ pattern: "ok pnpm-store", cwd, spawnImpl: makeFailingSpawn() });
    expect(result.data.matches).toHaveLength(0);
  });

  it("respects .gitignore entries that use a trailing slash form", async () => {
    // Use a name not in DEFAULT_IGNORES so this actually exercises the gitignore parser.
    await writeFile(path.join(cwd, ".gitignore"), "generated/\n", "utf8");
    await mkdir(path.join(cwd, "generated"), { recursive: true });
    await writeFile(path.join(cwd, "generated", "x.mjs"), "ok trailing-slash\n", "utf8");
    const result = await runGrep({ pattern: "ok trailing-slash", cwd, spawnImpl: makeFailingSpawn() });
    expect(result.data.matches).toHaveLength(0);
  });

  it("passes a search path and closes stdin so ripgrep cannot block on stdin", async () => {
    const calls = [];
    const spawnImpl = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => child.emit("exit", 0));
      return child;
    };
    await runGrep({ pattern: "foo", cwd, spawnImpl });
    // First call is `rg --version` (probe). Second is the actual search.
    const searchCall = calls.find((c) => !c.args.includes("--version"));
    expect(searchCall).toBeTruthy();
    // Must pass a search path so rg doesn't fall back to reading stdin.
    expect(searchCall.args[searchCall.args.length - 1]).toBe(".");
    // Must close stdin defensively.
    expect(searchCall.opts?.stdio).toEqual(["ignore", "pipe", "pipe"]);
  });

  it("strips a leading ./ from ripgrep output paths", async () => {
    const spawnImpl = (cmd, args) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      if (args.includes("--version")) {
        setImmediate(() => child.emit("exit", 0));
      } else {
        setImmediate(() => {
          child.stdout.emit("data", Buffer.from("./src/a.mjs:1:hit\n"));
          child.emit("exit", 0);
        });
      }
      return child;
    };
    const result = await runGrep({ pattern: "hit", cwd, spawnImpl });
    expect(result.data.ripgrep).toBe(true);
    expect(result.data.matches).toEqual([
      expect.objectContaining({ relPath: "src/a.mjs", line: 1, text: "hit" })
    ]);
  });
});

describe("Grep tool (ripgrep wrapper)", () => {
  // For these tests we need canUseRipgrep to return true. Our programmable
  // spawn returns the same child for both invocations; we trigger 'exit 0'
  // on the version probe and then drive the actual search.
  async function withRipgrepProbe(spawnImpl, work) {
    // First invocation: --version probe. Resolve it with exit 0 on next tick.
    queueMicrotask(() => spawnImpl.child.emit("exit", 0));
    return work();
  }

  it("drains stderr (no listener leak on a real stderr stream)", async () => {
    const spawnImpl = makeProgrammableSpawn();
    // Track listeners on stderr — the fix attaches a 'data' listener.
    const promise = withRipgrepProbe(spawnImpl, () =>
      runGrep({ pattern: "x", cwd: "/tmp", spawnImpl })
    );
    // Wait a tick so canUseRipgrep resolves and ripgrepSearch attaches.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(spawnImpl.child.stderr.listenerCount("data")).toBeGreaterThanOrEqual(1);
    // Let the search finish so the promise resolves.
    spawnImpl.child.emit("close");
    await promise;
  });

  it("times out a ripgrep child that never closes", async () => {
    vi.useFakeTimers();
    try {
      let killSignal = null;
      const spawnImpl = vi.fn(() => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = (sig) => { killSignal = sig; };
        return child;
      });
      // First call is canUseRipgrep — resolve via 'exit 0'.
      const firstChild = spawnImpl(); // pre-pull so we can wire it
      spawnImpl.mockImplementationOnce(() => {
        queueMicrotask(() => firstChild.emit("exit", 0));
        return firstChild;
      });

      const resultPromise = runGrep({ pattern: "x", cwd: "/tmp", spawnImpl });
      // Let canUseRipgrep settle.
      await vi.advanceTimersByTimeAsync(1);
      // Now the search child is spawned but never closes. Advance past the
      // 30s timeout.
      await vi.advanceTimersByTimeAsync(31_000);
      const result = await resultPromise;
      expect(killSignal).toBe("SIGKILL");
      expect(result.data.matches).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles only once even if close fires after timeout kill", async () => {
    vi.useFakeTimers();
    try {
      const versionChild = new EventEmitter();
      versionChild.stdout = new EventEmitter();
      versionChild.stderr = new EventEmitter();
      versionChild.kill = () => {};
      const searchChild = new EventEmitter();
      searchChild.stdout = new EventEmitter();
      searchChild.stderr = new EventEmitter();
      searchChild.kill = () => {};

      const spawnImpl = vi.fn()
        .mockImplementationOnce(() => {
          queueMicrotask(() => versionChild.emit("exit", 0));
          return versionChild;
        })
        .mockImplementationOnce(() => searchChild);

      const resultPromise = runGrep({ pattern: "x", cwd: "/tmp", spawnImpl });
      await vi.advanceTimersByTimeAsync(1);
      // Trigger timeout
      await vi.advanceTimersByTimeAsync(31_000);
      // Now have the child fire close belatedly — must not produce a second
      // resolve or throw.
      searchChild.emit("close");
      const result = await resultPromise;
      expect(result.data.matches).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
