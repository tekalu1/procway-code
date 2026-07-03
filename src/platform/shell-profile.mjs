import { existsSync } from "node:fs";

const WINDOWS_GIT_BASH_CANDIDATES = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe"
];

/**
 * Resolve the platform shell profile for `runShell`.
 *
 * On Windows we prefer **Git Bash** when present. PowerShell 5.1 writes
 * UTF-8 *with BOM* via `Set-Content -Encoding utf8` and falls back to `?`
 * for any character outside the target encoding — both halves of the
 * `memo.md` corruption we observed when the worker bypassed the `task put`
 * API. Bash redirects (`>`, `tee`, here-docs) write raw UTF-8 bytes with
 * no encoder fallback, eliminating the failure mode. The agent's prompt
 * already documents `task put` examples with bash here-doc syntax, so the
 * shell and the prompt converge.
 *
 * PowerShell remains as a fallback for Windows hosts without Git Bash;
 * the UTF-8 codepage prefix stays so native commands still come back as
 * UTF-8 bytes.
 *
 * `env` carries Git Bash MSYS knobs that disable automatic conversion of
 * arguments that look like POSIX paths (otherwise Git Bash silently
 * rewrites `--content "/c/foo"` into `C:\foo`).
 */
export function getShellProfile(
  platform = process.platform,
  { fileExists = existsSync } = {}
) {
  if (platform === "win32") {
    const gitBash = WINDOWS_GIT_BASH_CANDIDATES.find((p) => safeExists(p, fileExists));
    if (gitBash) {
      return {
        shell: gitBash,
        args: ["-c"],
        commandPrefix: "",
        env: { MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" }
      };
    }
    return {
      shell: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"],
      commandPrefix: "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); chcp 65001 > $null; ",
      env: {}
    };
  }
  return {
    shell: "bash",
    args: ["-lc"],
    commandPrefix: "",
    env: {}
  };
}

function safeExists(p, fn) {
  try { return fn(p); } catch { return false; }
}
