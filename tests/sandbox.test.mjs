import { describe, expect, it } from "vitest";
import { buildUlimitPrefix, isPosixPlatform, resolveSandbox, wrapShellCommand } from "../src/safety/sandbox.mjs";

describe("safety/sandbox", () => {
  it("isPosixPlatform recognises Linux/macOS but not Windows", () => {
    expect(isPosixPlatform("linux")).toBe(true);
    expect(isPosixPlatform("darwin")).toBe(true);
    expect(isPosixPlatform("win32")).toBe(false);
  });

  it("buildUlimitPrefix builds memory and CPU clauses", () => {
    expect(buildUlimitPrefix({ memoryMB: 1024, cpuSeconds: 60 })).toEqual([
      "ulimit -v 1048576",
      "ulimit -t 60"
    ]);
    expect(buildUlimitPrefix({})).toEqual([]);
  });

  it("wrapShellCommand prepends ulimit on POSIX and notes the limitation on Windows", () => {
    const linux = wrapShellCommand({
      command: "node script.js",
      sandbox: { memoryMB: 512 },
      platform: "linux"
    });
    expect(linux.wrapped).toBe(true);
    expect(linux.command).toContain("ulimit -v");
    expect(linux.command).toContain("&& node script.js");

    const windows = wrapShellCommand({
      command: "node script.js",
      sandbox: { memoryMB: 512 },
      platform: "win32"
    });
    expect(windows.wrapped).toBe(false);
    expect(windows.notes.join(" ")).toContain("unsupported");
  });

  it("wrapShellCommand returns the original command when sandbox is unset", () => {
    const result = wrapShellCommand({ command: "ls", sandbox: null });
    expect(result.wrapped).toBe(false);
    expect(result.command).toBe("ls");
  });

  it("resolveSandbox returns null when the user did not configure limits", () => {
    expect(resolveSandbox({ settings: {} })).toBeNull();
    expect(resolveSandbox({ settings: { tools: {} } })).toBeNull();
    expect(resolveSandbox({ settings: { tools: { sandbox: { memoryMB: 256 } } } })).toEqual({ memoryMB: 256 });
  });
});
