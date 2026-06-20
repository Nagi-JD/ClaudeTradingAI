import { describe, it, expect } from "vitest";
import { isOpenForTrading } from "../src/jupiter.js";
import type { Market } from "../src/types.js";

const base = (over: Partial<Market>): Market => ({
  marketId: "POLY-1-1",
  status: "open",
  result: null,
  openTime: 1,
  closeTime: Math.floor(Date.now() / 1000) + 3600, // closes in 1h
  ...over,
});

describe("isOpenForTrading", () => {
  it("open + unresolved (null/empty) => true", () => {
    expect(isOpenForTrading(base({ result: null }))).toBe(true);
    expect(isOpenForTrading(base({ result: "" }))).toBe(true);
  });

  it("status closed or cancelled => false", () => {
    expect(isOpenForTrading(base({ status: "closed" }))).toBe(false);
    expect(isOpenForTrading(base({ status: "cancelled" }))).toBe(false);
  });

  it("any resolution (pending/yes/no) => false (no edge buying a decided market)", () => {
    expect(isOpenForTrading(base({ result: "pending" }))).toBe(false);
    expect(isOpenForTrading(base({ result: "yes" }))).toBe(false);
    expect(isOpenForTrading(base({ result: "no" }))).toBe(false);
  });

  it("past closeTime => false even if status still says open", () => {
    expect(isOpenForTrading(base({ closeTime: Math.floor(Date.now() / 1000) - 60 }))).toBe(false);
  });
});
