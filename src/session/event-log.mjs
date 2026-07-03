import { mkdir, appendFile, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isAgentEvent } from "../core/events/types.mjs";
import { getSessionDir } from "./store.mjs";
import { redactEvent } from "./redaction.mjs";
import { decryptJson, encryptJson, isEncryptedBuffer } from "./encryption.mjs";

/**
 * Append-only NDJSON event log under `<sessionDir>/events.jsonl`.
 *
 * Phase 6:
 *   - When a `redactionPatterns` is provided, every event is `redactEvent`-ed
 *     before it hits disk (in-memory copies are unaffected — providers
 *     continue to see raw payloads).
 *   - When an `encryptionKey` is provided, the appended line is wrapped in a
 *     `PROCWAYE` envelope (see `encryption.mjs`); existing plaintext files
 *     read fine because `readEventLog` falls back to JSON.parse when the
 *     magic byte sequence is absent on a given line.
 */
export class EventLog {
  constructor({
    homeDir = os.homedir(),
    sessionId,
    redactionPatterns = null,
    encryptionKey = null
  } = {}) {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new TypeError("EventLog: sessionId is required");
    }
    this.homeDir = homeDir;
    this.sessionId = sessionId;
    this.filePath = path.join(getSessionDir({ homeDir, sessionId }), "events.jsonl");
    this.redactionPatterns = redactionPatterns;
    this.encryptionKey = encryptionKey;
    // Serializes writes so file order always matches append (= emit) order.
    // The session-level subscriber fires append per event without awaiting
    // the previous one; unchained, two near-simultaneous events (an assistant
    // tool_use round whose tool completes within the same millisecond) could
    // interleave their mkdir/appendFile awaits and land on disk REVERSED.
    // Resume projects file order, so a flipped tool_result-before-tool_use
    // pair poisoned the rebuilt history (observed in the wild as a provider
    // 400 on every turn after resume).
    this.writeChain = Promise.resolve();
  }

  append(event) {
    if (!isAgentEvent(event)) {
      return Promise.reject(
        new TypeError(`EventLog.append: not an AgentEvent (type=${String(event?.type)})`)
      );
    }
    const task = this.writeChain.then(() => this.#write(event));
    // Keep the chain alive past a failed write; the caller still sees the
    // rejection through the returned task.
    this.writeChain = task.catch(() => {});
    return task;
  }

  async #write(event) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const payload = this.redactionPatterns
      ? redactEvent(event, { patterns: this.redactionPatterns })
      : event;
    if (this.encryptionKey) {
      const buffer = encryptJson({ data: payload, key: this.encryptionKey });
      await appendFile(this.filePath, `${buffer.toString("base64")}\n`, "utf8");
    } else {
      await appendFile(this.filePath, JSON.stringify(payload) + "\n", "utf8");
    }
  }

  async readAll() {
    return readEventLog({ homeDir: this.homeDir, sessionId: this.sessionId, encryptionKey: this.encryptionKey });
  }

  async tail(n) {
    const all = await this.readAll();
    if (!Number.isFinite(n) || n <= 0) return [];
    return all.slice(Math.max(0, all.length - Math.floor(n)));
  }
}

export async function appendEvent({ homeDir = os.homedir(), sessionId, event, redactionPatterns = null, encryptionKey = null }) {
  const log = new EventLog({ homeDir, sessionId, redactionPatterns, encryptionKey });
  await log.append(event);
  return log;
}

export async function readEventLog({ homeDir = os.homedir(), sessionId, encryptionKey = null } = {}) {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new TypeError("readEventLog: sessionId is required");
  }
  const filePath = path.join(getSessionDir({ homeDir, sessionId }), "events.jsonl");
  if (!existsSync(filePath)) return [];
  const content = await readFile(filePath, "utf8");
  const events = [];
  for (const line of content.split("\n")) {
    if (!line) continue;
    const parsed = decodeLine(line, encryptionKey);
    if (parsed != null) events.push(parsed);
  }
  return events;
}

/**
 * Decode a single events.jsonl line. Encrypted lines are base64-encoded
 * AES-GCM ciphertext (wrapped in the `PROCWAYE` envelope); plaintext lines
 * are NDJSON. The leading `PROCWAYE` bytes never appear directly on disk —
 * `append` always base64-wraps the ciphertext before writing — so encrypted
 * detection is base64-decode + buffer magic inspection.
 */
function decodeLine(line, encryptionKey) {
  if (encryptionKey && /^[A-Za-z0-9+/=]+$/.test(line) && line.length > 8) {
    try {
      const buf = Buffer.from(line, "base64");
      if (isEncryptedBuffer(buf)) {
        return decryptJson({ ciphertext: buf, key: encryptionKey });
      }
    } catch {
      // fall through to plain JSON path
    }
  }
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
