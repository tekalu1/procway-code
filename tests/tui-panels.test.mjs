import { describe, expect, it } from "vitest";
import { renderChecklist, renderHeading, renderPanel, renderTable, wrapText, padStartWidth } from "../src/adapters/tui/panel.mjs";
import { formatBytes, formatCount, formatDuration, formatRelativeTime, formatTokens, formatUsd } from "../src/adapters/tui/format.mjs";
import { stripAnsi, visibleWidth } from "../src/adapters/tui/ansi.mjs";

describe("panel primitives (P3b-1 shared visual language)", () => {
  it("renders a heading and aligned label/value rows", () => {
    const panel = renderPanel({
      title: "Status",
      subtitle: "session",
      rows: [["Workspace", "/repo"], ["Approval", "always-ask"]],
      color: false
    });
    expect(panel).toContain("▌ Status  session");
    expect(panel).toContain("  Workspace  /repo");
    // The value column is aligned across rows.
    expect(panel).toContain("  Approval   always-ask");
  });

  it("wraps a long value into the value column instead of truncating it", () => {
    const panel = renderPanel({
      title: "Error",
      rows: [["reason", "the provider rejected this request because the configured api key does not exist"]],
      width: 48,
      color: false
    });
    const lines = panel.trimEnd().split("\n");
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(48);
    // Nothing is lost.
    expect(panel.replace(/\s+/g, " ")).toContain("api key does not exist");
  });

  it("keeps CJK panels inside the requested width", () => {
    const panel = renderPanel({
      title: "コンテキスト",
      rows: [["ワークスペース", "/リポジトリ/プロジェクト/日本語のディレクトリ名"]],
      width: 40,
      color: false
    });
    for (const line of panel.trimEnd().split("\n")) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    }
  });

  it("right-aligns numeric table columns and rules off a footer", () => {
    const table = renderTable({
      title: "Usage",
      columns: [
        { key: "round", label: "round", align: "right" },
        { key: "input", label: "input", align: "right" }
      ],
      rows: [{ round: "0", input: "12,000" }, { round: "1", input: "7" }],
      footer: { round: "total", input: "12,007" },
      color: false
    });
    const lines = table.trimEnd().split("\n");
    // header, two rows, rule, footer (+ title)
    expect(lines).toHaveLength(6);
    expect(lines[4]).toMatch(/^ {2}─+$/);
    // digits line up: the two body rows end at the same column
    expect(lines[2].length).toBe(lines[3].length);
  });

  it("reports an empty table instead of drawing an empty frame", () => {
    expect(renderTable({ title: "Skills", columns: [{ key: "a" }], rows: [], color: false, empty: "(none)" }))
      .toContain("(none)");
  });

  it("renders a checklist with distinct glyphs per status", () => {
    const list = renderChecklist({
      title: "Todos",
      items: [
        { status: "completed", text: "done thing" },
        { status: "in_progress", text: "doing thing" },
        { status: "pending", text: "later thing" }
      ],
      color: false
    });
    expect(list).toContain("✔ done thing");
    expect(list).toContain("▸ doing thing");
    expect(list).toContain("○ later thing");
  });

  it("emits ANSI only when colour is enabled", () => {
    const plain = renderPanel({ title: "T", rows: [["a", "b"]], color: false });
    const painted = renderPanel({ title: "T", rows: [["a", "b"]], color: true });
    expect(plain).not.toContain("[");
    expect(painted).toContain("[");
    expect(stripAnsi(painted)).toBe(plain);
  });

  it("renderHeading and padStartWidth are grapheme-aware", () => {
    expect(stripAnsi(renderHeading("Usage", { color: true }))).toBe("▌ Usage");
    expect(visibleWidth(padStartWidth("日本", 8))).toBe(8);
  });

  it("wrapText hard-splits words that cannot fit", () => {
    expect(wrapText("alpha beta", 20)).toEqual(["alpha beta"]);
    expect(wrapText("aaaaaaaaaa", 4)).toEqual(["aaaa", "aaaa", "aa"]);
  });
});

describe("shared formatters", () => {
  it("formats relative time in the units a human would use", () => {
    const now = Date.parse("2026-08-04T12:00:00Z");
    expect(formatRelativeTime("2026-08-04T11:59:30Z", { now })).toBe("just now");
    expect(formatRelativeTime("2026-08-04T11:55:00Z", { now })).toBe("5 minutes ago");
    expect(formatRelativeTime("2026-08-04T09:00:00Z", { now })).toBe("3 hours ago");
    expect(formatRelativeTime("2026-08-02T12:00:00Z", { now })).toBe("2 days ago");
    expect(formatRelativeTime("2026-06-04T12:00:00Z", { now })).toBe("2 months ago");
    expect(formatRelativeTime("not a date", { now })).toBe("");
    expect(formatRelativeTime(null, { now })).toBe("");
  });

  it("formats tokens, counts, cost, duration and bytes", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_345)).toBe("12.3k");
    expect(formatTokens(1_200_000)).toBe("1.2M");
    expect(formatCount(13_456)).toBe("13,456");
    expect(formatCount(undefined)).toBe("-");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.00123)).toBe("$0.0012");
    expect(formatUsd(1.5)).toBe("$1.50");
    expect(formatDuration(400)).toBe("0.4s");
    expect(formatDuration(12_000)).toBe("12s");
    expect(formatDuration(185_000)).toBe("3m 05s");
    expect(formatBytes(812)).toBe("812 B");
    expect(formatBytes(2048)).toBe("2 KB");
  });
});
