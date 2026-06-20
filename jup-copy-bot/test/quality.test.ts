import { describe, it, expect } from "vitest";
import { judge } from "../src/quality.js";

const cfg = { minPredictions: 20, minWinRatePct: 50, requirePositiveAllTime: true };

describe("judge — separates skill from luck", () => {
  it("verifies a large-sample profitable winner", () => {
    const j = judge({ allTimePnlUsd: 6559, volumeUsd: 248878, correct: 123, wrong: 96 }, cfg);
    expect(j.verified).toBe(true);
    expect(j.winRatePct).toBeCloseTo(56.2, 1);
    expect(j.verdict).toContain("skilled");
  });

  it("rejects a net loser who had a lucky week", () => {
    const j = judge({ allTimePnlUsd: -8635, volumeUsd: 624357, correct: 14, wrong: 43 }, cfg);
    expect(j.verified).toBe(false);
    expect(j.verdict).toContain("net loser");
  });

  it("rejects a small sample even at 100% win", () => {
    const j = judge({ allTimePnlUsd: 1868, volumeUsd: 3585, correct: 1, wrong: 0 }, cfg);
    expect(j.verified).toBe(false);
    expect(j.verdict).toContain("small sample");
  });

  it("rejects a weak edge (sub-threshold win rate)", () => {
    const j = judge({ allTimePnlUsd: 41, volumeUsd: 608749, correct: 35, wrong: 80 }, cfg);
    expect(j.verified).toBe(false);
    expect(j.verdict).toContain("weak edge");
  });

  it("handles no resolved history", () => {
    const j = judge({ allTimePnlUsd: 0, volumeUsd: 0, correct: 0, wrong: 0 }, cfg);
    expect(j.verified).toBe(false);
    expect(j.verdict).toContain("cannot judge");
  });
});
