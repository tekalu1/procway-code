import { describe, expect, it } from "vitest";
import { getShellProfile } from "../src/platform/shell-profile.mjs";

describe("getShellProfile", () => {
  it("prefers Git Bash on Windows when bash.exe is present", () => {
    const profile = getShellProfile("win32", {
      fileExists: (p) => p === "C:\\Program Files\\Git\\bin\\bash.exe"
    });
    expect(profile.shell).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
    expect(profile.args).toEqual(["-c"]);
    expect(profile.commandPrefix).toBe("");
    // MSYS knobs prevent Git Bash from rewriting POSIX-shaped args to
    // Windows paths (which would corrupt --content payloads silently).
    expect(profile.env).toEqual({
      MSYS_NO_PATHCONV: "1",
      MSYS2_ARG_CONV_EXCL: "*"
    });
  });

  it("also accepts Git Bash from the (x86) Program Files location", () => {
    const profile = getShellProfile("win32", {
      fileExists: (p) => p === "C:\\Program Files (x86)\\Git\\bin\\bash.exe"
    });
    expect(profile.shell).toBe("C:\\Program Files (x86)\\Git\\bin\\bash.exe");
  });

  it("falls back to PowerShell when Git Bash is not installed", () => {
    const profile = getShellProfile("win32", { fileExists: () => false });
    expect(profile.shell).toBe("powershell.exe");
    expect(profile.args).toEqual(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"]);
    expect(profile.commandPrefix).toContain("[Console]::OutputEncoding");
    expect(profile.commandPrefix).toContain("UTF8Encoding");
    expect(profile.commandPrefix).toContain("chcp 65001");
    expect(profile.commandPrefix.endsWith("; ")).toBe(true);
    expect(profile.env).toEqual({});
  });

  it("uses bash on POSIX without any prefix", () => {
    for (const platform of ["linux", "darwin", "freebsd"]) {
      const profile = getShellProfile(platform);
      expect(profile.shell).toBe("bash");
      expect(profile.args).toEqual(["-lc"]);
      expect(profile.commandPrefix).toBe("");
      expect(profile.env).toEqual({});
    }
  });
});
