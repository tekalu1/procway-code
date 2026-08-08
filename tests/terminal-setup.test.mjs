import { describe, expect, it, vi } from "vitest";
import {
  CTRL_J_ADVICE,
  applyTerminalSetup,
  detectTerminal,
  insertVscodeBinding,
  planTerminalSetup,
  vscodeKeybindingsPath
} from "../src/adapters/tui/terminal-setup.mjs";

describe("/terminal-setup — detection", () => {
  it("recognises the three supported terminals", () => {
    expect(detectTerminal({ TERM_PROGRAM: "vscode" })).toBe("vscode");
    expect(detectTerminal({ TERM_PROGRAM: "iTerm.app" })).toBe("iterm2");
    expect(detectTerminal({ LC_TERMINAL: "iTerm2" })).toBe("iterm2");
    expect(detectTerminal({ WEZTERM_PANE: "0" })).toBe("wezterm");
    expect(detectTerminal({ TERM_PROGRAM: "Apple_Terminal" })).toBeNull();
  });

  it("tells an unsupported terminal to use Ctrl+J instead of guessing", async () => {
    const plan = await planTerminalSetup({ env: {}, platform: "linux", homeDir: "/home/u" });
    expect(plan.supported).toBe(false);
    expect(plan.targets).toEqual([]);
    expect(plan.note).toBe(CTRL_J_ADVICE);
  });

  it("resolves keybindings.json per platform", () => {
    expect(vscodeKeybindingsPath({ homeDir: "/h", platform: "linux", env: {} }))
      .toBe("/h/.config/Code/User/keybindings.json");
    expect(vscodeKeybindingsPath({ homeDir: "/h", platform: "darwin", env: {} }))
      .toBe("/h/Library/Application Support/Code/User/keybindings.json");
  });
});

describe("/terminal-setup — VS Code keybindings.json", () => {
  it("creates the file when it does not exist", async () => {
    const plan = await planTerminalSetup({
      env: { TERM_PROGRAM: "vscode" },
      platform: "linux",
      homeDir: "/home/u",
      read: async () => { throw new Error("ENOENT"); }
    });
    expect(plan.targets[0].action).toBe("create");
    expect(plan.targets[0].after).toContain("workbench.action.terminal.sendSequence");
    expect(plan.targets[0].after).toContain("\\u001b\\r");
  });

  it("appends to an existing array WITHOUT destroying comments or entries", () => {
    const existing = `// my keybindings
[
  // toggle the panel
  { "key": "ctrl+j", "command": "workbench.action.togglePanel" }
]
`;
    const merged = insertVscodeBinding(existing);
    expect(merged).toContain("// my keybindings");
    expect(merged).toContain("workbench.action.togglePanel");
    expect(merged).toContain("shift+enter");
    // Still valid JSON once the comments are stripped.
    const bare = merged.replace(/^\s*\/\/.*$/gm, "");
    expect(JSON.parse(bare)).toHaveLength(2);
  });

  it("never overwrites an existing shift+enter binding", async () => {
    const existing = '[{ "key": "shift+enter", "command": "something.else" }]';
    expect(insertVscodeBinding(existing)).toBeNull();
    const plan = await planTerminalSetup({
      env: { TERM_PROGRAM: "vscode" },
      platform: "linux",
      homeDir: "/home/u",
      read: async () => existing
    });
    expect(plan.targets[0].action).toBe("skip");
    expect(plan.targets[0].reason).toBe("already configured");
  });

  it("handles an empty file", () => {
    expect(JSON.parse(insertVscodeBinding("   \n"))).toHaveLength(1);
  });
});

describe("/terminal-setup — iTerm2 and WezTerm", () => {
  it("plans a `defaults -dict-add` that merges one GlobalKeyMap entry", async () => {
    const plan = await planTerminalSetup({
      env: { TERM_PROGRAM: "iTerm.app" },
      platform: "darwin",
      homeDir: "/Users/u"
    });
    expect(plan.supported).toBe(true);
    for (const target of plan.targets) {
      expect(target.command).toContain("-dict-add");
      expect(target.command.join(" ")).toContain("0x1b 0x0d");
    }
  });

  it("only offers iTerm2 on macOS", async () => {
    const plan = await planTerminalSetup({ env: { LC_TERMINAL: "iTerm2" }, platform: "linux", homeDir: "/h" });
    expect(plan.supported).toBe(false);
  });

  it("creates wezterm.lua when absent but refuses to rewrite an existing config", async () => {
    const created = await planTerminalSetup({
      env: { WEZTERM_PANE: "0" }, platform: "linux", homeDir: "/h",
      read: async () => { throw new Error("ENOENT"); }
    });
    expect(created.targets[0].action).toBe("create");
    expect(created.targets[0].after).toContain("SendString '\\x1b\\r'");

    const existing = await planTerminalSetup({
      env: { WEZTERM_PANE: "0" }, platform: "linux", homeDir: "/h",
      read: async () => "local wezterm = require 'wezterm'\nreturn {}\n"
    });
    expect(existing.manual).toBe(true);
    expect(existing.targets[0].action).toBe("skip");
    expect(existing.note).toContain("SendString");
  });
});

describe("/terminal-setup — applying", () => {
  it("backs a file up before modifying it and never touches skipped targets", async () => {
    const writes = [];
    const backups = [];
    const results = await applyTerminalSetup(
      {
        targets: [
          { kind: "file", action: "update", path: "/h/keybindings.json", before: "[]", after: "[x]" },
          { kind: "file", action: "skip", path: "/h/other.json", reason: "already configured" }
        ]
      },
      {
        write: async (file, content) => { writes.push([file, content]); },
        ensureDir: async () => {},
        backup: async (file) => { backups.push(file); return `${file}.procway-backup-1`; }
      }
    );
    expect(backups).toEqual(["/h/keybindings.json"]);
    expect(writes).toEqual([["/h/keybindings.json", "[x]"]]);
    expect(results[0]).toMatchObject({ applied: true, backup: "/h/keybindings.json.procway-backup-1" });
    expect(results[1]).toMatchObject({ applied: false, reason: "already configured" });
  });

  it("does not back up a file it is creating", async () => {
    const backup = vi.fn();
    await applyTerminalSetup(
      { targets: [{ kind: "file", action: "create", path: "/h/new.json", before: "", after: "[]" }] },
      { write: async () => {}, ensureDir: async () => {}, backup }
    );
    expect(backup).not.toHaveBeenCalled();
  });

  it("reports a failure instead of throwing", async () => {
    const results = await applyTerminalSetup(
      { targets: [{ kind: "file", action: "create", path: "/nope/x.json", before: "", after: "[]" }] },
      { write: async () => { throw new Error("EACCES"); }, ensureDir: async () => {}, backup: async () => null }
    );
    expect(results[0]).toMatchObject({ applied: false, error: "EACCES" });
  });
});
