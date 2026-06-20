import { describe, it, expect } from "vitest";
import { weeklyPnlFromHistory } from "../src/jupiter.js";
import type { ProfilePnlPoint } from "../src/types.js";

const DAY = 86400;
const now = 1_780_000_000;

// pnl-history returns a CUMULATIVE all-time realized-P&L curve (micro-USD),
// newest-first. 7-day P&L must be (cumulative now) - (cumulative ~7d ago),
// NOT the oldest absolute point (the old bug).
describe("weeklyPnlFromHistory", () => {
  it("returns the delta over the last 7 days, not an absolute level", () => {
    const hist: ProfilePnlPoint[] = [
      { timestamp: now, realizedPnlUsd: "500000000" }, // $500 cumulative now
      { timestamp: now - 3 * DAY, realizedPnlUsd: "420000000" },
      { timestamp: now - 8 * DAY, realizedPnlUsd: "300000000" }, // ~7d-ago baseline ($300)
      { timestamp: now - 20 * DAY, realizedPnlUsd: "100000000" },
    ];
    // $500 - $300 = $200 over the week (NOT $100, the oldest point)
    expect(weeklyPnlFromHistory(hist)).toBeCloseTo(200);
  });

  it("is robust to ascending ordering too", () => {
    const hist: ProfilePnlPoint[] = [
      { timestamp: now - 20 * DAY, realizedPnlUsd: "100000000" },
      { timestamp: now - 8 * DAY, realizedPnlUsd: "300000000" },
      { timestamp: now, realizedPnlUsd: "500000000" },
    ];
    expect(weeklyPnlFromHistory(hist)).toBeCloseTo(200);
  });

  it("history shorter than 7d => full delta from earliest point", () => {
    const hist: ProfilePnlPoint[] = [
      { timestamp: now, realizedPnlUsd: "150000000" },
      { timestamp: now - 2 * DAY, realizedPnlUsd: "50000000" },
    ];
    expect(weeklyPnlFromHistory(hist)).toBeCloseTo(100);
  });

  it("empty or single-point history => 0 (cannot derive a weekly delta)", () => {
    expect(weeklyPnlFromHistory([])).toBe(0);
    expect(weeklyPnlFromHistory([{ timestamp: now, realizedPnlUsd: "999000000" }])).toBe(0);
  });
});
