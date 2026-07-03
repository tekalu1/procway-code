import { describe, expect, it } from "vitest";
import { SNAPSHOT_INTERVAL, SNAPSHOT_INTERVAL_MS_DEFAULT, SnapshotThrottle } from "../src/session/snapshot.mjs";

describe("SnapshotThrottle", () => {
  it("exposes documented defaults", () => {
    expect(SNAPSHOT_INTERVAL).toBe(50);
    expect(SNAPSHOT_INTERVAL_MS_DEFAULT).toBe(30000);
  });

  it("allows the first write because lastWrittenAt starts at 0", () => {
    let now = Date.now();
    const throttle = new SnapshotThrottle({ now: () => now });
    expect(throttle.shouldWrite({ eventCount: 1 })).toBe(true);
  });

  it("suppresses subsequent writes within the event/time window", () => {
    let now = 1_700_000_000_000;
    const throttle = new SnapshotThrottle({ intervalEvents: 50, intervalMs: 30000, now: () => now });
    expect(throttle.shouldWrite({ eventCount: 1 })).toBe(true);
    throttle.recordWrite({ eventCount: 1 });
    now += 1_000;
    expect(throttle.shouldWrite({ eventCount: 5 })).toBe(false);
    expect(throttle.shouldWrite({ eventCount: 49 })).toBe(false);
  });

  it("flushes when the event delta crosses intervalEvents", () => {
    let now = 1_700_000_000_000;
    const throttle = new SnapshotThrottle({ intervalEvents: 10, intervalMs: 60000, now: () => now });
    expect(throttle.shouldWrite({ eventCount: 1 })).toBe(true);
    throttle.recordWrite({ eventCount: 1 });
    now += 100;
    expect(throttle.shouldWrite({ eventCount: 10 })).toBe(false);
    expect(throttle.shouldWrite({ eventCount: 11 })).toBe(true);
  });

  it("flushes when intervalMs has elapsed even without new events", () => {
    let now = 1_700_000_000_000;
    const throttle = new SnapshotThrottle({ intervalEvents: 999, intervalMs: 5000, now: () => now });
    expect(throttle.shouldWrite({ eventCount: 1 })).toBe(true);
    throttle.recordWrite({ eventCount: 1 });
    now += 4_999;
    expect(throttle.shouldWrite({ eventCount: 2 })).toBe(false);
    now += 2;
    expect(throttle.shouldWrite({ eventCount: 2 })).toBe(true);
  });

  it("force=true overrides every threshold", () => {
    const throttle = new SnapshotThrottle({ intervalEvents: 999, intervalMs: 999_999, now: () => 0 });
    throttle.recordWrite({ eventCount: 5 });
    expect(throttle.shouldWrite({ eventCount: 5 })).toBe(false);
    expect(throttle.shouldWrite({ eventCount: 5, force: true })).toBe(true);
  });
});
