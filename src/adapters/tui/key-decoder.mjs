/**
 * Raw-mode key decoder (P2-1 / P2-2 / P2-3).
 *
 * Node's `readline.emitKeypressEvents` is deliberately NOT used:
 *
 *  - it swallows bracketed-paste markers (`ESC [ 200~`) into a nameless
 *    keypress, so a multi-line paste arrives as N separate "return" presses and
 *    is submitted as N turns (P2-3);
 *  - it cannot distinguish Ctrl+J (0x0A) from Return (0x0D) once an interface
 *    is attached, which is exactly the distinction multi-line input needs;
 *  - it is bound to a readline interface, and Phase 2's whole point is that a
 *    single owner — the input controller — holds stdin.
 *
 * The decoder is a pure state machine over strings: `push(chunk)` returns the
 * events it could complete and keeps any partial escape sequence (or an
 * unterminated paste) buffered for the next chunk. That makes it trivially
 * unit-testable without a TTY.
 *
 * Event shapes:
 *   { type: "text",  text }                         printable run
 *   { type: "paste", text }                         one bracketed paste
 *   { type: "key",   name, ctrl, meta, shift, seq } everything else
 */

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** CSI final byte → key name (no trailing `~`). */
const CSI_LETTER_KEYS = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  E: "clear",
  Z: "tab" // shift-tab; `shift` is set by the caller
};

/** CSI `<n>~` → key name. */
const CSI_TILDE_KEYS = {
  1: "home",
  2: "insert",
  3: "delete",
  4: "end",
  5: "pageup",
  6: "pagedown",
  7: "home",
  8: "end",
  11: "f1",
  12: "f2",
  13: "f3",
  14: "f4",
  15: "f5",
  17: "f6",
  18: "f7",
  19: "f8",
  20: "f9",
  21: "f10",
  23: "f11",
  24: "f12"
};

function key(name, extra = {}) {
  return { type: "key", name, ctrl: false, meta: false, shift: false, seq: "", ...extra };
}

/**
 * xterm modifier parameter: 1 + bit0 shift + bit1 alt + bit2 ctrl.
 * `ESC [ 1;5C` = Ctrl+Right, `ESC [ 1;2C` = Shift+Right.
 */
function decodeModifier(param) {
  const value = Number(param);
  if (!Number.isFinite(value) || value < 1) return { shift: false, meta: false, ctrl: false };
  const bits = value - 1;
  return { shift: (bits & 1) !== 0, meta: (bits & 2) !== 0, ctrl: (bits & 4) !== 0 };
}

/** Control byte (< 0x20) → key event. */
function controlKey(code, seq) {
  if (code === 0x0d) return key("return", { seq });
  if (code === 0x0a) return key("linefeed", { seq });
  if (code === 0x09) return key("tab", { seq });
  if (code === 0x08) return key("backspace", { seq });
  if (code === 0x1b) return key("escape", { seq });
  if (code === 0x00) return key("space", { ctrl: true, seq });
  // 0x01..0x1a → Ctrl+A..Ctrl+Z (minus the ones handled above).
  if (code >= 0x01 && code <= 0x1a) return key(String.fromCharCode(code + 96), { ctrl: true, seq });
  if (code === 0x1c) return key("\\", { ctrl: true, seq });
  if (code === 0x1d) return key("]", { ctrl: true, seq });
  if (code === 0x1e) return key("^", { ctrl: true, seq });
  if (code === 0x1f) return key("_", { ctrl: true, seq });
  return key("unknown", { seq });
}

export function createKeyDecoder() {
  let pending = "";
  let pasting = false;
  let pasteBuffer = "";

  /**
   * Try to decode one unit at `buffer[index]`.
   * @returns {{ events: Array<object>, next: number } | null} null = need more bytes.
   */
  function decodeOne(buffer, index) {
    const char = buffer[index];
    const code = char.codePointAt(0);

    if (char !== "\x1b") {
      if (code < 0x20 || code === 0x7f) {
        const event = code === 0x7f ? key("backspace", { seq: char }) : controlKey(code, char);
        return { events: [event], next: index + 1 };
      }
      // Printable: batch the whole run so an IME commit ("日本語です") lands as
      // ONE text event instead of a keypress per grapheme.
      let end = index;
      while (end < buffer.length) {
        const c = buffer.codePointAt(end);
        if (c < 0x20 || c === 0x7f || c === 0x1b) break;
        end += String.fromCodePoint(c).length;
      }
      return { events: [{ type: "text", text: buffer.slice(index, end) }], next: end };
    }

    // --- ESC ------------------------------------------------------------
    const rest = buffer.slice(index);
    if (rest.length === 1) return null; // lone ESC so far — wait for more

    const second = rest[1];

    if (second === "[") {
      // CSI: parameters, then a final byte in 0x40..0x7e.
      let cursor = 2;
      while (cursor < rest.length && /[0-9;?<>=]/.test(rest[cursor])) cursor += 1;
      if (cursor >= rest.length) return null; // incomplete
      const final = rest[cursor];
      const params = rest.slice(2, cursor);
      const seq = rest.slice(0, cursor + 1);
      const next = index + cursor + 1;

      if (final === "~") {
        const [numberPart, modPart] = params.split(";");
        if (numberPart === "200") return { events: [{ type: "paste-start" }], next };
        if (numberPart === "201") return { events: [{ type: "paste-end" }], next };
        const name = CSI_TILDE_KEYS[Number(numberPart)] ?? "unknown";
        return { events: [key(name, { ...decodeModifier(modPart ?? 1), seq })], next };
      }
      const name = CSI_LETTER_KEYS[final];
      if (name) {
        const modPart = params.includes(";") ? params.split(";")[1] : null;
        const mods = decodeModifier(modPart ?? 1);
        if (final === "Z") mods.shift = true;
        return { events: [key(name, { ...mods, seq })], next };
      }
      return { events: [key("unknown", { seq })], next };
    }

    if (second === "O") {
      // SS3 (application cursor keys): ESC O A .. ESC O F
      if (rest.length < 3) return null;
      const name = CSI_LETTER_KEYS[rest[2]] ?? "unknown";
      return { events: [key(name, { seq: rest.slice(0, 3) })], next: index + 3 };
    }

    // ESC + <char> = Alt/Meta. `ESC CR` is what macOS Option+Enter (and the
    // /terminal-setup Shift+Enter binding) sends — the multi-line newline.
    const secondCode = second.codePointAt(0);
    const seq = `\x1b${second}`;
    const width = String.fromCodePoint(secondCode).length;
    if (secondCode < 0x20 || secondCode === 0x7f) {
      const base = secondCode === 0x7f ? key("backspace", { seq }) : controlKey(secondCode, seq);
      base.meta = true;
      return { events: [base], next: index + 1 + width };
    }
    return { events: [key(second, { meta: true, seq })], next: index + 1 + width };
  }

  return {
    /** @param {string} chunk decoded UTF-8 text (never a raw Buffer) */
    push(chunk) {
      const buffer = pending + String(chunk ?? "");
      pending = "";
      const out = [];
      let index = 0;

      while (index < buffer.length) {
        if (pasting) {
          const end = buffer.indexOf(PASTE_END, index);
          if (end === -1) {
            // Keep the tail that could be a partial terminator.
            const keep = Math.max(index, buffer.length - PASTE_END.length + 1);
            pasteBuffer += buffer.slice(index, keep);
            pending = buffer.slice(keep);
            return out;
          }
          pasteBuffer += buffer.slice(index, end);
          out.push({ type: "paste", text: pasteBuffer });
          pasteBuffer = "";
          pasting = false;
          index = end + PASTE_END.length;
          continue;
        }

        // Fast path for a paste that starts exactly here.
        if (buffer.startsWith(PASTE_START, index)) {
          pasting = true;
          index += PASTE_START.length;
          continue;
        }

        const decoded = decodeOne(buffer, index);
        if (!decoded) {
          pending = buffer.slice(index);
          return out;
        }
        for (const event of decoded.events) {
          if (event.type === "paste-start") {
            pasting = true;
          } else if (event.type === "paste-end") {
            pasting = false;
          } else {
            out.push(event);
          }
        }
        index = decoded.next;
      }
      // `buffer` is per-call; the state that survives a chunk boundary is
      // `pending`, which every early return above sets.
      return out;
    },

    /**
     * Flush a lone trailing ESC as an `escape` key. The controller calls this
     * on a short timer so pressing Esc by itself is not held hostage waiting
     * for a sequence that will never arrive.
     */
    flush() {
      if (pasting || pending === "") return [];
      const buffered = pending;
      pending = "";
      if (buffered === "\x1b") return [key("escape", { seq: "\x1b" })];
      const out = [];
      const decoder = createKeyDecoder();
      out.push(...decoder.push(buffered));
      return out;
    },

    get pendingText() {
      return pending;
    },

    get isPasting() {
      return pasting;
    }
  };
}
