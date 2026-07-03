/**
 * Minimal ANSI helpers used by adapters/tui/* renderers. No external
 * dependencies — escape sequences are written directly so the bundle size
 * stays at zero new runtime deps (Phase 5 §2.2 decision).
 *
 * The helpers are intentionally pure: each function takes a string and
 * returns a string. cli.mjs is the only caller that decides where the
 * resulting bytes are written, which keeps the streaming write path
 * collapsed to a single sink (Phase 5 brief §4 — avoid hotfix 294f143
 * recurrence).
 */

export const ESC = "\x1b";

const RESET = `${ESC}[0m`;

const COLORS = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  gray: 90,
  brightRed: 91,
  brightGreen: 92,
  brightYellow: 93,
  brightBlue: 94,
  brightMagenta: 95,
  brightCyan: 96
};

const BG_COLORS = {
  black: 40,
  red: 41,
  green: 42,
  yellow: 43,
  blue: 44,
  magenta: 45,
  cyan: 46,
  white: 47,
  gray: 100
};

export function color(name, text) {
  const code = COLORS[name];
  if (code == null) return text;
  return `${ESC}[${code}m${text}${RESET}`;
}

export function bgColor(name, text) {
  const code = BG_COLORS[name];
  if (code == null) return text;
  return `${ESC}[${code}m${text}${RESET}`;
}

export function bold(text) {
  return `${ESC}[1m${text}${RESET}`;
}

export function dim(text) {
  return `${ESC}[2m${text}${RESET}`;
}

export function italic(text) {
  return `${ESC}[3m${text}${RESET}`;
}

export function underline(text) {
  return `${ESC}[4m${text}${RESET}`;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(text) {
  if (typeof text !== "string") return text;
  return text.replace(ANSI_RE, "");
}

/**
 * Convert ANSI escape sequences to a `[name]...[/name]` placeholder format
 * used by snapshot tests. Helps reviewers read the saved output without
 * fighting `\x1b[...m` noise.
 */
export function ansiToPlaceholders(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(/\x1b\[1m/g, "[bold]")
    .replace(/\x1b\[2m/g, "[dim]")
    .replace(/\x1b\[3m/g, "[italic]")
    .replace(/\x1b\[4m/g, "[underline]")
    .replace(/\x1b\[2K/g, "[clear-line]")
    .replace(/\x1b\[(\d+)m/g, (_, code) => {
      const n = Number(code);
      const colorName = Object.entries(COLORS).find(([, value]) => value === n)?.[0];
      if (colorName) return `[${colorName}]`;
      const bgName = Object.entries(BG_COLORS).find(([, value]) => value === n)?.[0];
      if (bgName) return `[bg-${bgName}]`;
      if (n === 0) return "[/]";
      return `[ansi:${code}]`;
    });
}

export function visibleWidth(text) {
  if (typeof text !== "string") return 0;
  return Array.from(stripAnsi(text)).reduce((width, char) => width + charWidth(char), 0);
}

function charWidth(char) {
  const code = char.codePointAt(0) ?? 0;
  if (code === 0) return 0;
  // Rough East-Asian wide handling — sufficient for table column sizing.
  if (code >= 0x1100 && code <= 0x115f) return 2;
  if (code >= 0x2e80 && code <= 0x303e) return 2;
  if (code >= 0x3041 && code <= 0x33ff) return 2;
  if (code >= 0x3400 && code <= 0x4dbf) return 2;
  if (code >= 0x4e00 && code <= 0x9fff) return 2;
  if (code >= 0xa000 && code <= 0xa4cf) return 2;
  if (code >= 0xac00 && code <= 0xd7a3) return 2;
  if (code >= 0xf900 && code <= 0xfaff) return 2;
  if (code >= 0xfe30 && code <= 0xfe4f) return 2;
  if (code >= 0xff00 && code <= 0xff60) return 2;
  if (code >= 0xffe0 && code <= 0xffe6) return 2;
  return 1;
}

export function padEnd(text, width) {
  const current = visibleWidth(text);
  if (current >= width) return text;
  return text + " ".repeat(width - current);
}
