import type { Trade, Orderbook, PaperPosition, Market } from "./types.js";
import { simulateFill, askLadder } from "./fills.js";
import type { Store } from "./state.js";

export interface ExecutorDeps {
  getOrderbook(marketId: string): Promise<Orderbook>;
  isMarketOpen(marketId: string): Promise<boolean>;
}

export interface ExecutorLimits {
  fixedUsdPerTrade: number;
  maxOpenPositions: number;
  dailySpendCapUsd: number;
  maxEntryPriceUsd: number; // skip fills priced above this (capped upside, e.g. 0.95)
  minEntryPriceUsd: number; // skip dust/illiquid fills below this (e.g. 0.02)
}

export type CopyOutcome =
  | { status: "filled"; position: PaperPosition }
  | { status: "skipped"; reason: string };

/**
 * Decide whether to paper-copy a single trade and, if so, build the position.
 * Pure-ish: mutates store only on a successful fill (markSeen + addPosition).
 */
export async function maybeCopyTrade(
  trade: Trade,
  store: Store,
  deps: ExecutorDeps,
  limits: ExecutorLimits
): Promise<CopyOutcome> {
  if (store.hasSeen(trade.id)) return { status: "skipped", reason: "seen" };
  if (trade.action !== "buy") return skip(store, trade, "not-a-buy");
  if (!store.isVerified(trade.ownerPubkey)) return skip(store, trade, "not-verified");

  store.rolloverDay();
  if (store.openPositionCount() >= limits.maxOpenPositions) {
    return skip(store, trade, "max-open-positions");
  }
  if (store.state.spentTodayUsd + limits.fixedUsdPerTrade > limits.dailySpendCapUsd) {
    return skip(store, trade, "daily-cap");
  }

  const open = await deps.isMarketOpen(trade.marketId);
  if (!open) return skip(store, trade, "market-closed");

  const book = await deps.getOrderbook(trade.marketId);
  const fill = simulateFill(limits.fixedUsdPerTrade, askLadder(book, trade.side));
  if (fill.filledContracts <= 0) return skip(store, trade, "no-liquidity");

  // Price-band guard: no edge buying at the extremes — near $1 is capped upside
  // (max payout is $1), near $0 is dust/illiquid. Both just bleed fees.
  if (fill.avgFillPriceUsd >= limits.maxEntryPriceUsd) return skip(store, trade, "price-too-high");
  if (fill.avgFillPriceUsd <= limits.minEntryPriceUsd) return skip(store, trade, "price-too-low");

  const position: PaperPosition = {
    marketId: trade.marketId,
    marketTitle: trade.marketTitle,
    side: trade.side,
    filledContracts: fill.filledContracts,
    requestedUsd: limits.fixedUsdPerTrade,
    avgFillPriceUsd: fill.avgFillPriceUsd,
    grossCostUsd: fill.grossCostUsd,
    feeUsd: fill.feeUsd,
    netCostUsd: fill.netCostUsd,
    partial: fill.partial,
    openedFromWallet: trade.ownerPubkey,
    openedAt: trade.timestamp || Date.now(),
  };
  store.markSeen(trade.id);
  store.addPosition(position);
  return { status: "filled", position };
}

function skip(store: Store, trade: Trade, reason: string): CopyOutcome {
  store.markSeen(trade.id); // don't re-evaluate this trade forever
  return { status: "skipped", reason };
}

/**
 * Per-contract USD value once a market reaches a terminal state, else null
 * (still tradeable / not yet resolved — keep marking to live price).
 *   - our side won  -> $1.00   (each contract pays out a dollar)
 *   - our side lost  -> $0.00
 *   - cancelled      -> entry price (stake refunded; we just eat the fee)
 */
export function terminalValuePerContract(p: PaperPosition, m: Market): number | null {
  if (m.status === "cancelled") return p.avgFillPriceUsd;
  if (m.result === "yes" || m.result === "no") return m.result === p.side ? 1 : 0;
  return null; // open, or closed-but-awaiting-settlement (result ""/pending)
}

/** Mark a held position to current market price (best bid we could sell into). */
export function markToMarket(p: PaperPosition, sellPriceUsd: number): PaperPosition {
  const valueUsd = p.filledContracts * sellPriceUsd;
  return {
    ...p,
    markPriceUsd: sellPriceUsd,
    valueUsd,
    unrealizedPnlUsd: valueUsd - p.netCostUsd,
  };
}
