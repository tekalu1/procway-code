import { describe, expect, it } from "vitest";
import { ulid, isUlid } from "../src/core/events/ulid.mjs";
import { createEvent } from "../src/core/events/types.mjs";

describe("ulid", () => {
  it("produces 26-character Crockford base32 IDs", () => {
    for (let i = 0; i < 32; i += 1) {
      const value = ulid();
      expect(value).toHaveLength(26);
      expect(isUlid(value)).toBe(true);
    }
  });

  it("encodes the timestamp portion so newer IDs sort lexicographically after older IDs", () => {
    const a = ulid(1700000000000);
    const b = ulid(1700000005000);
    expect(a < b).toBe(true);
    expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
  });

  it("uses the provided random buffer when given (deterministic for the random portion)", () => {
    const random = new Uint8Array(10).fill(0);
    const value = ulid(0, random);
    expect(value.startsWith("0".repeat(10))).toBe(true);
    expect(value.endsWith("0".repeat(16))).toBe(true);
  });

  it("createEvent auto-assigns ulid eventIds (no UUID hyphens)", () => {
    const event = createEvent("turn.completed", { round: 0, exitCode: 0 });
    expect(event.eventId).toHaveLength(26);
    expect(isUlid(event.eventId)).toBe(true);
    expect(event.eventId.includes("-")).toBe(false);
  });

  it("rejects negative or non-finite timestamps", () => {
    expect(() => ulid(-1)).toThrow(RangeError);
    expect(() => ulid(NaN)).toThrow(RangeError);
  });

  it("isUlid rejects malformed inputs", () => {
    expect(isUlid("")).toBe(false);
    expect(isUlid("abc")).toBe(false);
    expect(isUlid("0".repeat(25))).toBe(false);
    expect(isUlid("L".repeat(26))).toBe(false); // L is not in Crockford base32
    expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(true);
  });
});
