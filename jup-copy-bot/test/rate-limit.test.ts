import { describe, it, expect } from "vitest";
import { rateLimitDelayMs } from "../src/jupiter.js";

const S = (over: Partial<Parameters<typeof rateLimitDelayMs>[0]> = {}) => ({
  remaining: 10,
  resetAtMs: 0,
  lastSentMs: 0,
  minGapMs: 150,
  ...over,
});

describe("rateLimitDelayMs", () => {
  it("no wait when bucket has room and min-gap satisfied", () => {
    expect(rateLimitDelayMs(S({ remaining: 5, lastSentMs: 0 }), 10_000)).toBe(0);
  });

  it("enforces the min gap between requests", () => {
    // last sent 50ms ago, gap 150 => wait 100
    expect(rateLimitDelayMs(S({ lastSentMs: 9_950 }), 10_000)).toBe(100);
  });

  it("waits until reset when the bucket is exhausted", () => {
    expect(rateLimitDelayMs(S({ remaining: 0, resetAtMs: 12_000 }), 10_000)).toBe(2_000);
  });

  it("takes the larger of bucket-wait and min-gap", () => {
    expect(rateLimitDelayMs(S({ remaining: 0, resetAtMs: 12_000, lastSentMs: 9_990 }), 10_000)).toBe(2_000);
  });

  it("no bucket wait once reset is in the past", () => {
    expect(rateLimitDelayMs(S({ remaining: 0, resetAtMs: 9_000, lastSentMs: 0 }), 10_000)).toBe(0);
  });
});
