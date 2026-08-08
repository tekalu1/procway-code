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
export async function* parseSseStream(source, { signal = null } = {}) {
  if (!source) return;
  // A user Stop must break the read loop even if the transport doesn't reject
  // (a mocked/replayed body, or a chunk already buffered when the abort landed).
  // Throwing the signal's reason keeps the unified interrupt wording intact.
  const throwIfAborted = () => {
    if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
  };
  throwIfAborted();
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of toAsyncIterable(source, signal)) {
    throwIfAborted();
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
      throwIfAborted();
    }
  }
  throwIfAborted();
  if (buffer.trim().length > 0) {
    const record = parseSseBlock(buffer);
    if (record) yield record;
  }
}

async function* toAsyncIterable(source, signal = null) {
  if (typeof source[Symbol.asyncIterator] === "function") {
    for await (const chunk of source) yield chunk;
    return;
  }
  if (typeof source.getReader === "function") {
    const reader = source.getReader();
    // `reader.read()` on an already-delivered-but-idle body never settles on
    // its own; race the abort so a Stop always unblocks the loop, then cancel
    // the body so the socket is released instead of leaking.
    const abortPromise = signal
      ? new Promise((_resolve, reject) => {
          if (signal.aborted) return reject(signal.reason ?? new Error("Aborted"));
          signal.addEventListener?.("abort", () => reject(signal.reason ?? new Error("Aborted")), { once: true });
        })
      : null;
    // An unsettled abort promise must not surface as an unhandled rejection
    // once the stream finishes normally.
    abortPromise?.catch(() => {});
    try {
      while (true) {
        const { value, done } = abortPromise
          ? await Promise.race([reader.read(), abortPromise])
          : await reader.read();
        if (done) break;
        if (value != null) yield value;
      }
    } finally {
      try { if (signal?.aborted) await reader.cancel?.(signal.reason); } catch { /* already torn down */ }
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
