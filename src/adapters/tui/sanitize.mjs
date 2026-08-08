/**
 * Terminal escape-injection defence (Phase 3e).
 *
 * Everything this program prints is a mix of two things: bytes WE generate
 * (SGR colour runs, OSC 8 hyperlinks, the cursor arithmetic the line editor
 * and the session picker do) and text that came from somewhere else. The
 * second category is the dangerous one, and it is much wider than "model
 * output":
 *
 *   - assistant Markdown (`assistant.message.delta`, replayed transcripts)
 *   - `read_file` bodies — cloning a hostile repository is enough to fire this
 *   - `run_shell` stdout/stderr, `web_browser` / `web_search` results, MCP
 *     tool results
 *   - file names from disk (`@path` completion), session titles, model ids,
 *     provider error messages, tool arguments echoed in the approval prompt
 *
 * A raw `ESC` reaching the terminal from any of those is not cosmetic:
 *
 *   ESC ] 52 ; c ; <base64> BEL   writes the user's clipboard
 *   ESC [ 1;1H  /  ESC [ 2J       repaints over the approval prompt, so the
 *                                 user approves a different command than the
 *                                 one displayed — a privilege escalation in a
 *                                 tool that runs shells behind an approval
 *   ESC ] 0 ; … BEL               retitles the window
 *   ESC [ 5 n / ESC [ c           makes the terminal *answer*, and the answer
 *                                 is injected into our stdin as if typed
 *
 * ## What this module does
 *
 * `sanitizeTerminalText` is a pure, per-character map. It never looks at more
 * than one character (with one exception, `\r\n`), which is the property that
 * makes it safe for the streaming renderer: an `ESC` in chunk N and the
 * `]52;…` payload in chunk N+1 cannot slip through, because it is the `ESC`
 * *byte itself* that is neutralised, not the sequence around it. A
 * sequence-matching sanitiser would have that hole.
 *
 * ## Neutralise, or make visible?
 *
 * Visible. Deleting an escape leaves the user staring at text that reads
 * normally while something was silently removed; `cat -v` / `less` solved this
 * decades ago with caret notation, and reusing it means the output is
 * immediately legible to anybody who has ever run `cat -v`:
 *
 *   ESC (0x1B) → `^[`      BEL (0x07) → `^G`      DEL (0x7F) → `^?`
 *   C1 0x80–0x9F → `M-^@` … `M-^_`  (0x9B, the 8-bit CSI, → `M-^[`)
 *
 * C1 is included because a terminal in an 8-bit-controls mode treats 0x9B as
 * CSI directly; the UTF-8 encoding of U+009B is two bytes, but we cannot know
 * what the far end does with them, and C1 in prose is always either an attack
 * or mojibake.
 *
 * ## The exceptions
 *
 *   LF, TAB   kept. They are the layout the renderers are built on (`\t` is
 *             load-bearing in Makefiles and Go, and the wrapper already
 *             expands it to four columns).
 *   CR        rewritten to LF, NOT to `^M`. A bare CR's whole power is
 *             "return to column 0 and overwrite what is already there", so it
 *             must not survive — but `\r`-driven progress output (npm, pip,
 *             curl) is extremely common in `run_shell` results, and `^M`
 *             would turn a progress bar into one unreadable line. Turning it
 *             into a newline shows every frame the writer produced, on its own
 *             row: nothing is hidden and nothing is overwritten. `\r\n` is
 *             collapsed to `\n` first so CRLF files do not double-space.
 *   U+2028/9  (LINE/PARAGRAPH SEPARATOR) rewritten to LF. They cannot drive a
 *             terminal, but our own line accounting splits on `\n` only, while
 *             a browser, an editor or `JSON.parse` treats these as breaks — so
 *             "6 preview lines" here could be fifty lines somewhere else.
 *             Normalising removes the discrepancy.
 *   bidi      U+061C, U+200E/200F, U+202A–U+202E, U+2066–U+2069 are replaced
 *             with a literal `<U+202E>` marker. These are the Trojan Source
 *             (CVE-2021-42574) primitives: they REORDER the displayed glyphs,
 *             so a diff shown for approval can render as code that is not what
 *             would be written. Deleting them would silently change a legit
 *             RTL string; showing the code point neutralises the reordering
 *             and makes the tampering obvious. The list is the same one
 *             rustc's `text_direction_codepoint_in_literal` lint uses.
 *
 * Deliberately NOT touched: U+200B ZWSP, U+FEFF, and homoglyphs. They are an
 * invisible-character / confusable problem, not a terminal-control one, and
 * ZWSP in particular is legitimate line-breaking punctuation in CJK text.
 *
 * ## Idempotence
 *
 * Every replacement is built from characters that are themselves safe
 * (`^`, `M`, `-`, `<`, `U`, `+`, hex digits, `>`), so sanitising twice is a
 * no-op. That matters: `renderMarkdown` sanitises at its entry and
 * `renderQuote` re-enters it recursively, the streaming renderer sanitises a
 * buffer whose tail it already sanitised on the previous chunk, and several
 * renderers nest inside each other. Byte-for-byte parity between the live and
 * the replayed render depends on it.
 */

/**
 * Anything that must not reach the terminal verbatim. TAB (0x09) and LF (0x0A)
 * are the two holes; CR (0x0D) is inside the range on purpose.
 */
const UNSAFE_CLASS =
  "\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069";

/** Cheap "is there anything to do?" probe — the overwhelmingly common answer is no. */
const UNSAFE_TEST = new RegExp(`[${UNSAFE_CLASS}]`);
const UNSAFE_GLOBAL = new RegExp(`[${UNSAFE_CLASS}]`, "g");

/** `cat -v` caret notation for a C0 control (0x00–0x1F) or DEL. */
function caret(code) {
  if (code === 0x7f) return "^?";
  return `^${String.fromCharCode(code + 0x40)}`;
}

function replaceUnsafe(char) {
  const code = char.codePointAt(0);
  // CR and the Unicode line separators become real line breaks: the content
  // stays visible, but it can no longer overwrite the row above it.
  if (code === 0x0d || code === 0x2028 || code === 0x2029) return "\n";
  if (code <= 0x1f || code === 0x7f) return caret(code);
  // C1: `cat -v`'s meta form, so 0x9B (8-bit CSI) reads as `M-^[`.
  if (code >= 0x80 && code <= 0x9f) return `M-${caret(code - 0x80)}`;
  // Bidi overrides / isolates / marks — Trojan Source. Show the code point.
  return `<U+${code.toString(16).toUpperCase().padStart(4, "0")}>`;
}

/**
 * Make externally-sourced text safe to write to a terminal.
 *
 * MUST be applied BEFORE colouring: it would otherwise eat the `ESC` of our
 * own SGR runs and OSC 8 links. Every call site in `adapters/tui/` therefore
 * sanitises at the point the external string enters the renderer, never at the
 * write boundary.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizeTerminalText(value) {
  const text = typeof value === "string" ? value : String(value ?? "");
  if (!UNSAFE_TEST.test(text)) return text;
  return text.replace(/\r\n/g, "\n").replace(UNSAFE_GLOBAL, replaceUnsafe);
}

/**
 * The one-character look-ahead `sanitizeTerminalText` needs, exposed for
 * incremental (streaming) callers.
 *
 * A buffer that ends with a bare `\r` is ambiguous: it is either a lone CR
 * (→ `\n`) or the first half of a `\r\n` whose `\n` is still in flight. A
 * streaming caller must hold that byte back and re-offer it with the next
 * chunk, or a CRLF document renders with twice as many blank lines live as it
 * does on replay — which is exactly the live/replay parity the renderer is
 * built to guarantee.
 *
 * @param {string} source
 * @returns {{ text: string, pending: string }} `text` is sanitised; `pending`
 *   is the raw tail (`""` or `"\r"`) to prepend to the next chunk.
 */
export function sanitizeStreamPrefix(source) {
  const raw = typeof source === "string" ? source : String(source ?? "");
  if (raw.endsWith("\r")) {
    return { text: sanitizeTerminalText(raw.slice(0, -1)), pending: "\r" };
  }
  return { text: sanitizeTerminalText(raw), pending: "" };
}

/**
 * Sanitise and flatten to a single row. Used wherever a value shares a line
 * with something else (table cells, picker columns, one-line labels): an
 * embedded newline would shift every column after it and desync an in-place
 * repaint that counted the rows it drew.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizeInline(value) {
  return sanitizeTerminalText(value).replace(/\s+/g, " ").trim();
}
