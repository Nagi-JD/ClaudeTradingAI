import { describe, it, expect } from "vitest";
import { normalizeOrderbookToDollars } from "../src/jupiter.js";
import { simulateFill, askLadder } from "../src/fills.js";
import type { Orderbook } from "../src/types.js";

// Jupiter returns the yes/no ladders in INTEGER CENTS (1 === $0.01) and the
// *_dollars ladders as DOLLAR strings ("0.0100" === $0.01). The bot reasons in
// USD, so getOrderbook must normalize both to dollars. Regression for the 100x
// price bug that made every ask read as >= $1.00.
describe("normalizeOrderbookToDollars", () => {
  const raw = {
    yes: [[1, 346014], [2, 10568], [3, 12300]],
    no: [[1, 219]],
    yes_dollars: [["0.0100", 346014], ["0.0200", 10568], ["0.0300", 12300]],
    no_dollars: [["0.0100", 219]],
  } as unknown as Orderbook;

  it("converts the yes/no ladders to dollars using the *_dollars source", () => {
    const ob = normalizeOrderbookToDollars(raw);
    expect(ob.yes[0][0]).toBeCloseTo(0.01);
    expect(ob.yes[1][0]).toBeCloseTo(0.02);
    expect(ob.yes[0][1]).toBe(346014); // quantity untouched
    expect(ob.no[0][0]).toBeCloseTo(0.01);
  });

  it("falls back to cents/100 when *_dollars is absent", () => {
    const centsOnly = { yes: [[5, 100]], no: [], yes_dollars: [], no_dollars: [] } as unknown as Orderbook;
    const ob = normalizeOrderbookToDollars(centsOnly);
    expect(ob.yes[0][0]).toBeCloseTo(0.05);
  });

  it("a $10 YES buy fills against NO bids at 1-price, not the YES bid bottom", () => {
    // Real book shape: yes/no ladders are BIDS. Best NO bid $0.30 => YES ask $0.70.
    const book = {
      yes: [[0.01, 11080], [0.02, 3300], [0.65, 500]] as [number, number][],
      no: [[0.01, 16016], [0.25, 100], [0.30, 2000]] as [number, number][],
    };
    const fill = simulateFill(10, askLadder(book, "yes"));
    // Regression: the old code walked book.yes from $0.01 -> phantom 1000-contract fill.
    expect(fill.avgFillPriceUsd).toBeGreaterThan(0.6);
    expect(fill.avgFillPriceUsd).toBeLessThan(0.8);
    expect(fill.filledContracts).toBeLessThan(20); // ~14 contracts at $0.70, not 1000
  });

  it("askLadder flips the opposite ladder and sorts best ask first", () => {
    const book = {
      yes: [[0.10, 50]] as [number, number][],
      no: [[0.05, 10], [0.40, 20]] as [number, number][],
    };
    expect(askLadder(book, "yes")).toEqual([[1 - 0.40, 20], [1 - 0.05, 10]]);
    expect(askLadder(book, "no")).toEqual([[1 - 0.10, 50]]);
    expect(askLadder({}, "yes")).toEqual([]);
  });
});
