/**
 * Minimal YAML-front-matter parser for memory files. Implements only the
 * subset required by the memory subsystem: `name`, `description`, `type`
 * (and optionally `priority`). No third-party YAML dependency by design.
 *
 *   ---
 *   name: foo
 *   description: bar
 *   type: feedback
 *   ---
 *   body content...
 *
 * Returns `{ frontmatter: {...}, body: "..." }`. If no frontmatter is present,
 * `frontmatter` is `{}` and `body` is the raw text.
 */

const VALID_TYPES = new Set(["user", "feedback", "project", "reference"]);

export function parseFrontmatter(raw) {
  if (typeof raw !== "string") return { frontmatter: {}, body: "" };
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: raw };
  const block = match[1];
  const body = match[2] ?? "";
  const frontmatter = parseSimpleYaml(block);
  return { frontmatter, body };
}

export function parseMemoryFile(raw) {
  const { frontmatter, body } = parseFrontmatter(raw);
  return {
    name: typeof frontmatter.name === "string" ? frontmatter.name.trim() : "",
    description: typeof frontmatter.description === "string" ? frontmatter.description.trim() : "",
    type: VALID_TYPES.has(frontmatter.type) ? frontmatter.type : "reference",
    body: body.trim(),
    raw
  };
}

export function serializeMemoryFile({ name, description, type, body }) {
  const safeName = String(name ?? "").replace(/\r?\n/g, " ").trim();
  const safeDescription = String(description ?? "").replace(/\r?\n/g, " ").trim();
  const safeType = VALID_TYPES.has(type) ? type : "reference";
  const safeBody = (body ?? "").replace(/\r\n/g, "\n");
  return `---\nname: ${safeName}\ndescription: ${safeDescription}\ntype: ${safeType}\n---\n\n${safeBody}\n`;
}

/**
 * Minimal YAML scalar parser: `key: value` per line, strips surrounding
 * quotes, supports `[a, b]`-style inline arrays. Comments (`#...`) outside of
 * quoted strings are ignored. Multi-line values and nested mappings are NOT
 * supported — front-matter callers should keep things flat.
 */
export function parseSimpleYaml(block) {
  const result = {};
  if (typeof block !== "string") return result;
  for (const rawLine of block.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (line.length === 0) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx <= 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const valuePart = line.slice(colonIdx + 1).trim();
    result[key] = parseValue(valuePart);
  }
  return result;
}

function stripComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === "\"" && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

function parseValue(value) {
  if (value.length === 0) return "";
  if (value.startsWith("\"") && value.endsWith("\"") && value.length >= 2) {
    return unescapeDoubleQuoted(value.slice(1, -1));
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1);
    if (inner.trim().length === 0) return [];
    return splitTopLevelCommas(inner).map((item) => parseValue(item.trim()));
  }
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  return value;
}

function unescapeDoubleQuoted(value) {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, "\"")
    .replace(/\\\\/g, "\\");
}

function splitTopLevelCommas(value) {
  const out = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let buf = "";
  for (const ch of value) {
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === "\"" && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (ch === "[" || ch === "{") depth += 1;
      else if (ch === "]" || ch === "}") depth -= 1;
      else if (ch === "," && depth === 0) {
        out.push(buf);
        buf = "";
        continue;
      }
    }
    buf += ch;
  }
  if (buf.length > 0) out.push(buf);
  return out;
}
