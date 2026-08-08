import { describe, expect, it, vi } from "vitest";
import { clearTerminal, renderDisabledToolNote, renderPrompt, renderStatus, renderWelcome } from "../src/adapters/tui/shell.mjs";
import { visibleWidth } from "../src/adapters/tui/ansi.mjs";

/** Widths from a comfortable window down to `terminalWidth`'s 20-column floor. */
const WIDTHS = [100, 92, 80, 72, 60, 48, 40, 30, 24, 20];

/** Every box line of the welcome card, excluding the tip line and trailer. */
function boxLines(rendered) {
  return rendered.split("\n").slice(0, 6);
}

describe("rich TUI shell", () => {
  it("renders a compact welcome card without ANSI when color is disabled", () => {
    const rendered = renderWelcome({
      sessionId: "sess-1",
      cwd: "/workspace/project",
      provider: "openai",
      model: "gpt-test",
      approvalMode: "auto-readonly",
      width: 72,
      color: false
    });
    expect(rendered).toContain("procway-code");
    expect(rendered).toContain("openai:gpt-test");
    expect(rendered).toContain("/config setup");
    expect(rendered).not.toContain("\u001b[");
  });

  it("keeps every welcome box line at exactly the requested width", () => {
    // The top border used to be one column wider than the body: `╭` + `─` +
    // `╮` is three cells, and the old fill maths only subtracted two (P0-3).
    for (const width of [48, 72, 80, 92]) {
      const lines = boxLines(renderWelcome({
        sessionId: "sess-1",
        cwd: "/workspace/project",
        provider: "openai",
        model: "gpt-test",
        approvalMode: "auto-readonly",
        width
      }));
      const widths = lines.map((line) => visibleWidth(line));
      expect(new Set(widths).size, `mismatched widths at ${width}: ${widths}`).toBe(1);
      expect(widths[0]).toBe(width);
    }
  });

  it("keeps the box aligned for CJK and emoji working directories", () => {
    for (const cwd of [
      "/home/日本語のディレクトリ名前/プロジェクト",
      "/home/🚀🚀/👨‍👩‍👧-project/日本語",
      "/short"
    ]) {
      for (const color of [false, true]) {
        const widths = boxLines(renderWelcome({
          sessionId: "セッション-1",
          cwd,
          provider: "openai",
          model: "gpt-test",
          approvalMode: "auto-readonly",
          width: 80,
          color
        })).map((line) => visibleWidth(line));
        expect(new Set(widths), `cwd=${cwd} color=${color}`).toEqual(new Set([80]));
      }
    }
  });

  // ── P4b-1: nothing the banner prints may be wider than the window ────────
  //
  // Three lines used to be built from fixed strings and never measured: the
  // tip line (76 cols), the unavailable-tools note (grows with the tool list)
  // and — below 48 columns — the card itself, whose 48-column floor beat the
  // terminal width. A wrapped line is not cosmetic here: the prompt header is
  // row one of the input region, and a wrap desyncs the editor's repaint.
  it("keeps every banner line inside the terminal at any width", () => {
    for (const width of WIDTHS) {
      for (const color of [false, true]) {
        const lines = renderWelcome({
          sessionId: "2026-08-04T17-47-48-774Z",
          cwd: "/home/dev/procway/.claude/worktrees/tui-rich-shell/ai-agent",
          provider: "openrouter",
          model: "deepseek/deepseek-v4-flash-0731",
          approvalMode: "full-auto",
          width,
          color
        }).split("\n");
        for (const line of lines) {
          expect(visibleWidth(line), `width=${width} color=${color}: ${line}`).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  it("shrinks the welcome box with the terminal instead of holding a 48-column floor", () => {
    for (const width of [92, 80, 47, 40, 30, 20, 17]) {
      const lines = boxLines(renderWelcome({ sessionId: "s", cwd: "/w", width, color: false }));
      const widths = new Set(lines.map((line) => visibleWidth(line)));
      expect(widths, `width=${width}`).toEqual(new Set([Math.min(width, 92)]));
    }
  });

  // Whole tips are dropped, never half a tip, and the survivors keep reading
  // order: `/help` (how you find everything else) and `Ctrl+C` (how you get
  // out) are the last two standing.
  it("packs, wraps and finally drops tips as the terminal narrows", () => {
    const tips = (width) => renderWelcome({ sessionId: "s", cwd: "/w", width, color: false })
      .split("\n")
      .slice(6, -1);
    expect(tips(80)).toEqual(["Tip /help commands  /config setup provider  Ctrl+J newline  Ctrl+C interrupt"]);
    expect(tips(60)).toEqual(["Tip /help commands  /config setup provider  Ctrl+J newline", "    Ctrl+C interrupt"]);
    expect(tips(40)).toEqual(["Tip /help commands  Ctrl+J newline", "    Ctrl+C interrupt"]);
    expect(tips(30)).toEqual(["Tip /help commands", "    Ctrl+C interrupt"]);
    expect(tips(20)).toEqual(["Tip /help commands", "    Ctrl+C interrupt"]);
    // Narrower than the shortest tip on its own: clipped, still one line.
    expect(tips(12)).toEqual(["Tip /help c…"]);
    for (const width of WIDTHS) {
      for (const line of tips(width)) expect(visibleWidth(line), `${width}: ${line}`).toBeLessThanOrEqual(width);
    }
  });

  // The name list is unbounded, so the note steps down through shorter forms
  // rather than clipping mid-name — `/status` was always where the detail was.
  it("steps the unavailable-tools note down instead of overflowing", () => {
    const entries = [{ name: "web_browser" }, { name: "desktop_action" }];
    const note = (width) => renderDisabledToolNote(entries, { width, color: false }).trimEnd();
    expect(note(80)).toBe("2 tools unavailable here: web_browser, desktop_action — /status for why");
    expect(note(60)).toBe("2 tools unavailable — /status for why");
    expect(note(30)).toBe("2 tools unavailable — /status");
    expect(note(20)).toBe("2 tools unavailable");
    expect(note(10)).toBe("2 tools u…");
    expect(renderDisabledToolNote([], { width: 80 })).toBe("");
    expect(renderDisabledToolNote([{ name: "web_browser" }], { width: 80, color: false }))
      .toBe("1 tool unavailable here: web_browser — /status for why\n\n");
    for (const width of WIDTHS) {
      expect(visibleWidth(note(width)), `width=${width}`).toBeLessThanOrEqual(width);
    }
  });

  it("renders a two-line interactive prompt and a plain piped prompt", () => {
    expect(renderPrompt({ cwd: "/a/project", provider: "p", model: "m", color: false, tty: true }))
      .toBe("╭─ project · p:m\n╰─❯ ");
    expect(renderPrompt({ tty: false })).toBe("> ");
  });

  // P3b-9: approval mode used to be invisible until you typed /status — the one
  // piece of state you cannot afford to be wrong about. Spend appears only once
  // the session has actually spent something.
  it("puts approval mode, plan mode and accrued spend on the prompt", () => {
    const prompt = renderPrompt({
      cwd: "/a/project",
      provider: "p",
      model: "m",
      approvalMode: "always-ask",
      planMode: true,
      usage: { inputTokens: 12_345, outputTokens: 678, costUsd: 0.1234 },
      color: false,
      tty: true
    });
    expect(prompt).toContain("always-ask");
    expect(prompt).toContain("plan");
    expect(prompt).toContain("12.3k↑");
    expect(prompt).toContain("$0.12");
  });

  it("omits the spend segment while the session has spent nothing", () => {
    const prompt = renderPrompt({
      cwd: "/a/project",
      provider: "p",
      model: "m",
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      color: false,
      tty: true
    });
    expect(prompt).toBe("╭─ project · p:m\n╰─❯ ");
  });

  // ── P4b-2: the prompt header must never wrap ─────────────────────────────
  //
  // It is the first row of the input region, so a second row makes the line
  // editor erase one row too few on every repaint and the screen decays. The
  // segment-dropping below existed since P3b but was dead in production:
  // cli.mjs called renderPrompt without `width`, so the limit was Infinity.
  const HEADER_ARGS = {
    cwd: "/home/dev/ai-agent",
    provider: "openrouter",
    model: "deepseek/deepseek-v4-flash-0731",
    approvalMode: "full-auto",
    planMode: true,
    usage: { inputTokens: 12_345, outputTokens: 678, costUsd: 0.1234 },
    color: false,
    tty: true
  };
  const header = (width) => renderPrompt({ ...HEADER_ARGS, width }).split("\n")[0];

  it("drops prompt segments from the right, one width band at a time", () => {
    // 96 = the header's own 95 columns plus the cell the cursor needs.
    expect(header(96)).toBe("╭─ ai-agent · openrouter:deepseek/deepseek-v4-flash-0731 · full-auto · plan · 12.3k↑ 678↓ $0.12");
    expect(header(80)).toBe("╭─ ai-agent · openrouter:deepseek/deepseek-v4-flash-0731 · full-auto · plan");
    expect(header(70)).toBe("╭─ ai-agent · openrouter:deepseek/deepseek-v4-flash-0731 · full-auto");
    expect(header(60)).toBe("╭─ ai-agent · openrouter:deepseek/deepseek-v4-flash-0731");
    expect(header(50)).toBe("╭─ ai-agent");
    // Only one segment left and still too wide: clipped, never wrapped.
    expect(header(9)).toBe("╭─ ai-a…");
    // Not even room for one clipped cell of it: the bare corner, still one row.
    expect(header(3)).toBe("╭─");
  });

  it("never lets the prompt header reach the terminal's last column", () => {
    for (const width of [...WIDTHS, 12, 8, 6, 5, 4, 3, 2, 1]) {
      const line = header(width);
      // `width - 1`: the cursor has to have somewhere to sit that is not the
      // first cell of the next row.
      expect(visibleWidth(line), `width=${width}: ${line}`).toBeLessThanOrEqual(Math.max(1, width - 1));
    }
    // A CJK workspace name cannot straddle the limit either.
    for (const width of WIDTHS) {
      const line = renderPrompt({ ...HEADER_ARGS, cwd: "/home/日本語のディレクトリ名前", width }).split("\n")[0];
      expect(visibleWidth(line), `width=${width}: ${line}`).toBeLessThanOrEqual(width - 1);
    }
  });

  it("leaves the prompt header unbounded when no width is known", () => {
    // Non-TTY writers and unit callers pass no width; nothing should be lost.
    expect(header(null)).toContain("$0.12");
    expect(header(undefined)).toContain("$0.12");
  });

  it("renders status as a panel that carries usage and disabled tools", () => {
    const status = renderStatus({
      cwd: "/repo",
      sessionId: "s",
      provider: "p",
      model: "m",
      planMode: true,
      approvalMode: "always-ask",
      usage: { inputTokens: 2000, outputTokens: 100, costUsd: 0.5 },
      disabledTools: [{ name: "web_browser", reason: "missing browser executable" }],
      thinking: true,
      color: false
    });
    expect(status).toContain("▌ Status");
    expect(status).toContain("Plan mode  on");
    expect(status).toContain("Approval   always-ask");
    expect(status).toContain("2k in / 100 out");
    expect(status).toContain("$0.50");
    expect(status).toContain("web_browser — missing browser executable");
    expect(status).toContain("Thinking   shown");
  });

  // P3b-4: `ESC[2J` alone leaves the scrollback intact, so "clear" left every
  // previous turn one mouse-wheel away.
  it("clears the scrollback as well, and only for interactive terminals", () => {
    const write = vi.fn();
    clearTerminal({ isTTY: true, write });
    expect(write).toHaveBeenCalledWith("\u001b[3J\u001b[2J\u001b[H");
    write.mockClear();
    clearTerminal({ isTTY: false, write });
    expect(write).not.toHaveBeenCalled();
  });
});
