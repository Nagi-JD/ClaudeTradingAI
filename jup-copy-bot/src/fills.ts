import { roundUpCent } from "./money.js";

/** A single orderbook level: [priceUsd, quantityContracts]. */
export type Level = [number, number];

export interface FillResult {
  filledContracts: number;
  avgFillPriceUsd: number;
  grossCostUsd: number;
  feeUsd: number;
  netCostUsd: number;
  partial: boolean;
}

/**
 * Trading fee, calibrated to Jupiter's documented price->fee table.
 * fee = 0.07 * contracts * price * (1 - price), rounded UP to the cent,
 * minimum $0.01 on any executed (non-zero) trade.
 * Verified against the docs: 100 contracts @ $0.25 -> $1.32, @ $0.40 -> $1.68, etc.
 */
export function computeFee(priceUsd: number, contracts: number): number {
  if (contracts <= 0) return 0;
  const raw = 0.07 * contracts * priceUsd * (1 - priceUsd);
  return Math.max(0.01, roundUpCent(raw));
}

/**
 * Synthesize the ask ladder for the side we're buying.
 * Jupiter books carry BIDS only: `yes` = bids to buy YES, `no` = bids to buy NO.
 * A YES buy matches against NO bids at (1 - noPrice); walking the YES ladder
 * directly "fills" at the bottom bids ($0.01...) — the bug that produced a
 * $0.01 fill while the leader paid $0.70. Sort ascending so best ask is first.
 */
export function askLadder(
  book: { yes?: Level[]; no?: Level[] },
  side: "yes" | "no"
): Level[] {
  const opposite = (side === "yes" ? book.no : book.yes) ?? [];
  return opposite
    .filter(([p]) => p > 0 && p < 1)
    .map(([p, q]) => [1 - p, q] as Level)
    .sort((a, b) => a[0] - b[0]);
}

/**
 * Simulate buying `budgetUsd` worth of contracts by walking the ask ladder.
 * `levels` are [price, qty] sorted best (lowest) price first.
 * Captures slippage (avg fill price across levels) and partial fills.
 */
export function simulateFill(budgetUsd: number, levels: Level[]): FillResult {
  let remaining = budgetUsd;
  let filledContracts = 0;
  let grossCostUsd = 0;

  for (const [price, qty] of levels) {
    if (remaining <= 0 || price <= 0) break;
    const levelValue = price * qty;
    if (levelValue <= remaining) {
      filledContracts += qty;
      grossCostUsd += levelValue;
      remaining -= levelValue;
    } else {
      const partialQty = remaining / price;
      filledContracts += partialQty;
      grossCostUsd += remaining;
      remaining = 0;
    }
  }

  if (filledContracts <= 0) {
    return {
      filledContracts: 0,
      avgFillPriceUsd: 0,
      grossCostUsd: 0,
      feeUsd: 0,
      netCostUsd: 0,
      partial: true,
    };
  }

  const avgFillPriceUsd = grossCostUsd / filledContracts;
  const feeUsd = computeFee(avgFillPriceUsd, filledContracts);
  // partial if we couldn't spend (within a cent) the whole budget.
  const partial = remaining > 0.01;

  return {
    filledContracts,
    avgFillPriceUsd,
    grossCostUsd,
    feeUsd,
    netCostUsd: grossCostUsd + feeUsd,
    partial,
  };
}
