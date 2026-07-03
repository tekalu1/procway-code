/**
 * Phase 6 §2.6 — session-at-rest encryption.
 *
 * AES-256-GCM with a 12-byte IV. Files written through `encryptJson` start
 * with the magic `PROCWAYE` (8 bytes ASCII) followed by `0x01` (version) +
 * `iv` (12 bytes) + `tag` (16 bytes) + ciphertext bytes. Plaintext files
 * remain readable because `decryptJson` falls back to JSON.parse when the
 * magic is absent.
 *
 * Three providers:
 *   - "none"        → no encryption (back-compat default)
 *   - "passphrase"  → scrypt(env PROCWAY_SESSION_PASSPHRASE, fixed salt)
 *   - "os-keychain" → keytar (optional dep) read/created on demand
 *
 * The OS-keychain provider degrades gracefully: if `keytar` is not installed
 * we throw a descriptive error so callers can pick another provider.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

export const ENCRYPTION_MAGIC = "PROCWAYE";
const ENCRYPTION_VERSION = 0x01;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const SCRYPT_SALT = Buffer.from("procway-session-v1", "utf8");
const KEYCHAIN_SERVICE = "procway-code";
const KEYCHAIN_ACCOUNT = "session-key";

export function isEncryptedBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) return false;
  if (buffer.length < ENCRYPTION_MAGIC.length + 1 + IV_BYTES + TAG_BYTES) return false;
  return buffer.slice(0, ENCRYPTION_MAGIC.length).toString("utf8") === ENCRYPTION_MAGIC;
}

export function isEncryptedString(text) {
  if (typeof text !== "string" || text.length < ENCRYPTION_MAGIC.length) return false;
  return text.startsWith(ENCRYPTION_MAGIC);
}

export function encryptJson({ data, key }) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new TypeError(`encryptJson: key must be a ${KEY_BYTES}-byte Buffer`);
  }
  const plaintext = Buffer.from(JSON.stringify(data ?? null), "utf8");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([
    Buffer.from(ENCRYPTION_MAGIC, "utf8"),
    Buffer.from([ENCRYPTION_VERSION]),
    iv,
    tag,
    ciphertext
  ]);
}

export function decryptJson({ ciphertext, key }) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new TypeError(`decryptJson: key must be a ${KEY_BYTES}-byte Buffer`);
  }
  const buffer = Buffer.isBuffer(ciphertext) ? ciphertext : Buffer.from(String(ciphertext));
  if (!isEncryptedBuffer(buffer)) {
    throw new Error("decryptJson: input is not in PROCWAYE format");
  }
  const offset = ENCRYPTION_MAGIC.length;
  const version = buffer.readUInt8(offset);
  if (version !== ENCRYPTION_VERSION) {
    throw new Error(`decryptJson: unsupported version ${version}`);
  }
  const iv = buffer.slice(offset + 1, offset + 1 + IV_BYTES);
  const tag = buffer.slice(offset + 1 + IV_BYTES, offset + 1 + IV_BYTES + TAG_BYTES);
  const body = buffer.slice(offset + 1 + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}

export async function getEncryptionKey({ settings, env = process.env } = {}) {
  const provider = settings?.session?.encryption?.provider ?? "none";
  if (provider === "none") return null;
  if (provider === "passphrase") {
    const passphrase = env.PROCWAY_SESSION_PASSPHRASE;
    if (typeof passphrase !== "string" || passphrase.length === 0) {
      throw new Error("session encryption: PROCWAY_SESSION_PASSPHRASE env var is required for passphrase provider");
    }
    return scryptSync(passphrase, SCRYPT_SALT, KEY_BYTES);
  }
  if (provider === "os-keychain") {
    const keytar = await loadKeytar();
    if (!keytar) {
      throw new Error("session encryption: keytar (optional dep) is not installed; pick passphrase or none");
    }
    const service = settings?.session?.encryption?.keychainService ?? KEYCHAIN_SERVICE;
    const account = settings?.session?.encryption?.keychainAccount ?? KEYCHAIN_ACCOUNT;
    const stored = await keytar.getPassword(service, account);
    if (typeof stored === "string" && stored.length > 0) {
      return Buffer.from(stored, "base64");
    }
    const generated = randomBytes(KEY_BYTES);
    await keytar.setPassword(service, account, generated.toString("base64"));
    return generated;
  }
  throw new Error(`session encryption: unknown provider "${provider}"`);
}

async function loadKeytar() {
  try {
    const mod = await import("keytar");
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

/**
 * Helper for tests: derive a deterministic key from a passphrase WITHOUT going
 * through the env-var contract. Production code should prefer `getEncryptionKey`.
 */
export function deriveKeyFromPassphrase(passphrase) {
  if (typeof passphrase !== "string" || passphrase.length === 0) {
    throw new TypeError("deriveKeyFromPassphrase: passphrase must be a non-empty string");
  }
  return scryptSync(passphrase, SCRYPT_SALT, KEY_BYTES);
}
