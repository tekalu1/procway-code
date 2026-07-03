import { randomFillSync } from "node:crypto";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RAND_LEN = 16;

/**
 * Generate a 26-character Crockford base32 ULID. The first 10 characters are a
 * 48-bit millisecond timestamp (big-endian, base32-encoded), and the remaining
 * 16 characters are 80 bits of cryptographic randomness. Lexicographic ordering
 * matches chronological ordering at millisecond granularity.
 *
 * @param {number} [now]
 * @param {Uint8Array} [random] — must be 10 bytes when provided
 * @returns {string}
 */
export function ulid(now = Date.now(), random) {
  if (!Number.isFinite(now) || now < 0) throw new RangeError("ulid: invalid timestamp");
  let time = "";
  let value = Math.floor(now);
  for (let i = TIME_LEN - 1; i >= 0; i -= 1) {
    time = ENCODING[value % 32] + time;
    value = Math.floor(value / 32);
  }
  const bytes = random instanceof Uint8Array && random.length === 10
    ? random
    : randomFillSync(new Uint8Array(10));
  let bits = 0;
  let nbits = 0;
  let rand = "";
  for (let i = 0; i < bytes.length && rand.length < RAND_LEN; i += 1) {
    bits = (bits << 8) | bytes[i];
    nbits += 8;
    while (nbits >= 5 && rand.length < RAND_LEN) {
      nbits -= 5;
      rand += ENCODING[(bits >> nbits) & 0x1f];
    }
  }
  while (rand.length < RAND_LEN) rand += ENCODING[0];
  return time + rand;
}

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isUlid(value) {
  return typeof value === "string" && ULID_PATTERN.test(value);
}
