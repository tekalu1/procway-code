/**
 * Minimal Server-Sent Events parser. Accepts a Node.js Readable / WHATWG
 * ReadableStream / async iterable of bytes (or strings) and yields parsed
 * `{ type, data, ...rest }` records. Each record carries the SSE `event:`
 * type (when present), the parsed JSON payload merged into the top level
 * (when `data:` lines were JSON), or `{ data: <raw text> }` otherwise.
 *
 * The parser is tolerant: malformed JSON yields a record with `data` as the
 * raw string, blank lines flush, and `[DONE]` payloads are skipped.
 */
export async function* parseSseStream(source) {
  if (!source) return;
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of toAsyncIterable(source)) {
    if (chunk == null) continue;
    const text = typeof chunk === "string"
      ? chunk
      : decoder.decode(chunk, { stream: true });
    buffer += text;
    let separatorIndex;
    while ((separatorIndex = findRecordEnd(buffer)) !== -1) {
      const block = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + recordSeparatorLen(buffer, separatorIndex));
      const record = parseSseBlock(block);
      if (record) yield record;
    }
  }
  if (buffer.trim().length > 0) {
    const record = parseSseBlock(buffer);
    if (record) yield record;
  }
}

async function* toAsyncIterable(source) {
  if (typeof source[Symbol.asyncIterator] === "function") {
    for await (const chunk of source) yield chunk;
    return;
  }
  if (typeof source.getReader === "function") {
    const reader = source.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value != null) yield value;
      }
    } finally {
      try { reader.releaseLock(); } catch { /* readable already closed */ }
    }
  }
}

function findRecordEnd(buffer) {
  const lf = buffer.indexOf("\n\n");
  const cr = buffer.indexOf("\r\n\r\n");
  if (lf === -1) return cr;
  if (cr === -1) return lf;
  return Math.min(lf, cr);
}

function recordSeparatorLen(buffer, idx) {
  return buffer.slice(idx, idx + 4) === "\r\n\r\n" ? 4 : 2;
}

function parseSseBlock(block) {
  const lines = block.split(/\r?\n/);
  let event = null;
  const dataParts = [];
  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataParts.push(line.slice(5).replace(/^ /, ""));
    }
  }
  const dataRaw = dataParts.join("\n");
  if (!event && dataParts.length === 0) return null;
  if (dataRaw === "[DONE]") return { type: "done" };
  if (!dataRaw) return event ? { type: event } : null;
  try {
    const parsed = JSON.parse(dataRaw);
    if (parsed && typeof parsed === "object") {
      return event ? { ...parsed, type: event } : parsed;
    }
    return event ? { type: event, data: parsed } : { data: parsed };
  } catch {
    return event ? { type: event, data: dataRaw } : { data: dataRaw };
  }
}
