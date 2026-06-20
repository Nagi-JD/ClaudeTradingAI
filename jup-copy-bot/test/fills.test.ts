import { describe, it, expect } from "vitest";
import { computeFee, simulateFill } from "../src/fills.js";

describe("computeFee — matches documented price->fee table (100 contracts)", () => {
  const table: [number, number][] = [
    [0.01, 0.07],
    [0.05, 0.34],
    [0.1, 0.63],
    [0.15, 0.9],
    [0.2, 1.12],
    [0.25, 1.32],
    [0.3, 1.47],
    [0.35, 1.6],
    [0.4, 1.68],
  ];
  for (const [price, expected] of table) {
    it(`100 @ $${price} -> $${expected}`, () => {
      expect(computeFee(price, 100)).toBeCloseTo(expected, 2);
    });
  }

  it("1-contract band and minimum", () => {
    expect(computeFee(0.2, 1)).toBe(0.02);
    expect(computeFee(0.4, 1)).toBe(0.02);
    expect(computeFee(0.1, 1)).toBe(0.01);
    expect(computeFee(0.01, 1)).toBe(0.01); // min
    expect(computeFee(0.25, 0)).toBe(0);
  });
});

describe("simulateFill — orderbook walk", () => {
  it("fills within a single level (no slippage)", () => {
    const r = simulateFill(10, [[0.25, 1000]]);
    expect(r.filledContracts).toBeCloseTo(40, 6);
    expect(r.avgFillPriceUsd).toBeCloseTo(0.25, 6);
    expect(r.grossCostUsd).toBeCloseTo(10, 6);
    expect(r.feeUsd).toBe(computeFee(0.25, 40));
    expect(r.partial).toBe(false);
  });

  it("walks multiple levels with slippage", () => {
    // $5 @0.20 (25 ctr) then rest @0.30
    const r = simulateFill(10, [
      [0.2, 25],
      [0.3, 1000],
    ]);
    // level1 costs 5 -> 25 contracts; remaining 5 @0.30 -> 16.6667
    expect(r.filledContracts).toBeCloseTo(25 + 5 / 0.3, 4);
    expect(r.avgFillPriceUsd).toBeGreaterThan(0.2);
    expect(r.avgFillPriceUsd).toBeLessThan(0.3);
    expect(r.partial).toBe(false);
  });

  it("partial fill when depth < budget", () => {
    const r = simulateFill(10, [[0.5, 4]]); // only $2 of depth
    expect(r.grossCostUsd).toBeCloseTo(2, 6);
    expect(r.filledContracts).toBeCloseTo(4, 6);
    expect(r.partial).toBe(true);
  });

  it("zero liquidity -> nothing filled", () => {
    const r = simulateFill(10, []);
    expect(r.filledContracts).toBe(0);
    expect(r.netCostUsd).toBe(0);
    expect(r.partial).toBe(true);
  });
});
