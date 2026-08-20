/**
 * Minimal VT-100 screen model for the control subset the TUI emits:
 * `\r` `\n`, ESC[<n>A/B/C/D, ESC[<n>K, ESC[0J/1J/2J/3J, ESC[H, ESC[<r>;<c>H,
 * ESC[?2004h/l, OSC 8 hyperlinks and (ignored) SGR "m".
 *
 * Why it exists: the raw byte stream contains every dock repaint, and most of
 * those bytes are overwritten or erased before the user ever sees them. A test
 * that greps the stream therefore passes while the screen is wrong — which is
 * exactly how the input line could disappear for a whole turn with every
 * renderer unit test green. Assert on the ROWS this returns instead.
 */
export function renderScreen(text, { width = 80, height = 24 } = {}) {
  const screen = Array.from({ length: height }, () => "");
  let row = 0;
  let col = 0;
  const up = (n) => { row = Math.max(0, row - n); };
  const down = (n) => { row = Math.min(height - 1, row + n); };
  const right = (n) => { col = Math.min(width, col + n); };
  const left = (n) => { col = Math.max(0, col - n); };
  const scroll = () => { screen.shift(); screen.push(""); row = height - 1; };
  const put = (ch) => {
    if (ch === "\n") { row += 1; col = 0; if (row >= height) scroll(); return; }
    if (ch === "\r") { col = 0; return; }
    if (col >= width) { row += 1; if (row >= height) scroll(); col = 0; }
    if (screen[row].length < col) screen[row] = screen[row].padEnd(col, " ");
    screen[row] = screen[row].slice(0, col) + ch + screen[row].slice(col + 1);
    col += 1;
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c !== "\x1b") { put(c); i += 1; continue; }
    if (text[i + 1] === "]") { // OSC 8 hyperlink
      const bel = text.indexOf("\x07", i);
      const st = text.indexOf("\x1b\\", i);
      const end = st >= 0 ? (bel >= 0 ? Math.min(bel, st) : st) : bel;
      if (end >= 0) { i = end + 1; continue; }
      i += 2;
      continue;
    }
    if (text[i + 1] === "[") {
      let j = i + 2;
      let params = "";
      while (j < text.length && !/[A-Za-z@`]/.test(text[j])) { params += text[j]; j += 1; }
      const cmd = text[j] ?? "";
      const p = params.split(";").map((s) => Number.parseInt(s, 10)).map((s) => (Number.isFinite(s) ? s : 1));
      switch (cmd) {
        case "A": up(p[0]); break;
        case "B": down(p[0]); break;
        case "C": right(p[0]); break;
        case "D": left(p[0]); break;
        case "H":
          row = Math.min(height - 1, Math.max(0, (p[0] ?? 1) - 1));
          col = Math.max(0, (p[1] ?? 1) - 1);
          break;
        case "J": {
          const mode = params === "" || params === "0" ? 0 : p[0];
          if (mode === 0) {
            screen[row] = screen[row].slice(0, Math.max(0, col));
            for (let r = row + 1; r < height; r += 1) screen[r] = "";
          } else if (mode === 2 || mode === 3) {
            screen.fill("");
            row = 0;
            col = 0;
          } else if (mode === 1) {
            for (let r = 0; r <= row; r += 1) screen[r] = "";
          }
          break;
        }
        case "K": {
          const mode = params === "" || params === "0" ? 0 : p[0];
          if (mode === 2) screen[row] = "";
          else if (mode === 0) screen[row] = screen[row].slice(0, col);
          else if (mode === 1) screen[row] = screen[row].slice(col);
          break;
        }
        default: break;
      }
      i = j + 1;
      continue;
    }
    i += 2;
  }
  return screen.map((r) => r.replace(/\s+$/, ""));
}
