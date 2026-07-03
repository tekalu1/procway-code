import { describe, expect, it } from "vitest";
import {
  ENCRYPTION_MAGIC,
  decryptJson,
  deriveKeyFromPassphrase,
  encryptJson,
  getEncryptionKey,
  isEncryptedBuffer,
  isEncryptedString
} from "../src/session/encryption.mjs";

describe("session/encryption", () => {
  it("round-trips JSON through AES-256-GCM with a 32-byte key", () => {
    const key = deriveKeyFromPassphrase("hunter2");
    const data = { hello: "world", nested: { a: 1, list: ["x", "y"] } };
    const buffer = encryptJson({ data, key });
    expect(isEncryptedBuffer(buffer)).toBe(true);
    expect(buffer.slice(0, ENCRYPTION_MAGIC.length).toString("utf8")).toBe(ENCRYPTION_MAGIC);
    expect(isEncryptedString(buffer.toString("base64"))).toBe(false);
    expect(decryptJson({ ciphertext: buffer, key })).toEqual(data);
  });

  it("fails decryption with the wrong key", () => {
    const key = deriveKeyFromPassphrase("alpha");
    const wrong = deriveKeyFromPassphrase("beta");
    const buffer = encryptJson({ data: { secret: 1 }, key });
    expect(() => decryptJson({ ciphertext: buffer, key: wrong })).toThrow();
  });

  it("rejects ciphertext without the PROCWAYE magic", () => {
    const key = deriveKeyFromPassphrase("alpha");
    expect(() => decryptJson({ ciphertext: Buffer.from("not-encrypted"), key })).toThrow(/PROCWAYE/);
  });

  it("getEncryptionKey returns null for provider=none", async () => {
    const key = await getEncryptionKey({ settings: { session: { encryption: { provider: "none" } } } });
    expect(key).toBeNull();
  });

  it("getEncryptionKey derives a key from PROCWAY_SESSION_PASSPHRASE for passphrase provider", async () => {
    const key = await getEncryptionKey({
      settings: { session: { encryption: { provider: "passphrase" } } },
      env: { PROCWAY_SESSION_PASSPHRASE: "topsecret" }
    });
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key.length).toBe(32);
    expect(key.equals(deriveKeyFromPassphrase("topsecret"))).toBe(true);
  });

  it("getEncryptionKey throws when passphrase env is missing", async () => {
    await expect(getEncryptionKey({
      settings: { session: { encryption: { provider: "passphrase" } } },
      env: {}
    })).rejects.toThrow(/PROCWAY_SESSION_PASSPHRASE/);
  });
});
