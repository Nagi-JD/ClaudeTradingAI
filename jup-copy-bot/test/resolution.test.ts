import { describe, it, expect } from "vitest";
import { terminalValuePerContract, markToMarket } from "../src/paper-executor.js";
import type { Market, PaperPosition } from "../src/types.js";

const pos = (over: Partial<PaperPosition> = {}): PaperPosition => ({
  marketId: "POLY-1-1",
  marketTitle: "Down",
  side: "yes",
  filledContracts: 10,
  requestedUsd: 5,
  avgFillPriceUsd: 0.5,
  grossCostUsd: 5,
  feeUsd: 0.18,
  netCostUsd: 5.18,
  partial: false,
  openedFromWallet: "W",
  openedAt: 1,
  ...over,
});

const mkt = (over: Partial<Market> = {}): Market => ({
  marketId: "POLY-1-1",
  status: "closed",
  result: null,
  ...over,
});

describe("terminalValuePerContract", () => {
  it("our side wins => $1.00/contract", () => {
    expect(terminalValuePerContract(pos({ side: "yes" }), mkt({ result: "yes" }))).toBe(1);
    expect(terminalValuePerContract(pos({ side: "no" }), mkt({ result: "no" }))).toBe(1);
  });

  it("our side loses => $0.00/contract", () => {
    expect(terminalValuePerContract(pos({ side: "yes" }), mkt({ result: "no" }))).toBe(0);
  });

  it("cancelled => stake refunded at entry price", () => {
    expect(terminalValuePerContract(pos({ avgFillPriceUsd: 0.5 }), mkt({ status: "cancelled" }))).toBe(0.5);
  });

  it("not yet terminal (open / pending result) => null", () => {
    expect(terminalValuePerContract(pos(), mkt({ status: "open", result: null }))).toBeNull();
    expect(terminalValuePerContract(pos(), mkt({ status: "closed", result: "pending" }))).toBeNull();
    expect(terminalValuePerContract(pos(), mkt({ status: "closed", result: "" }))).toBeNull();
  });

  it("realized P&L: win pays $1/contract minus cost basis", () => {
    const p = pos({ filledContracts: 10, netCostUsd: 5.18 });
    const t = terminalValuePerContract(p, mkt({ result: "yes" }))!;
    const m = markToMarket(p, t);
    expect(m.valueUsd).toBeCloseTo(10); // 10 contracts * $1
    expect(m.unrealizedPnlUsd).toBeCloseTo(4.82); // 10 - 5.18
  });

  it("realized P&L: loss is the full cost basis", () => {
    const p = pos({ netCostUsd: 5.18 });
    const t = terminalValuePerContract(p, mkt({ result: "no" }))!; // side yes, result no
    const m = markToMarket(p, t);
    expect(m.valueUsd).toBe(0);
    expect(m.unrealizedPnlUsd).toBeCloseTo(-5.18);
  });
});
