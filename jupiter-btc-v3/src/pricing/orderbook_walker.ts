// Orderbook walker for Jupiter prediction markets.
//
// CRITICAL MARKET STRUCTURE FACT:
//   Jupiter prediction orderbooks are BIDS-ONLY. Each side (YES / NO) shows only
//   the resting BUY orders for that side. There are no native ASK levels.
//   To BUY a YES contract you cross against someone willing to SELL YES — but a
//   resting SELL of YES is economically identical to a resting BUY of NO at the
//   complementary price (1 − price). So:
//
//     real YES asks  =  NO bids, each level flipped to price (1 − noBidPrice)
//     real NO  asks  =  YES bids, each level flipped to price (1 − yesBidPrice)
//
//   We NEVER fill at the mid. The walker always crosses real ask liquidity
//   (the flipped opposite-side ladder), worst-case-first. filledAtMid is the
//   literal `false` to satisfy the type invariant.
//
// Never throws. Malformed input → empty ladders + reasonCodes.

import type { OrderbookLevel, OrderbookWalkResult } from "../jupiter_prediction/models";
import type { Config } from "../config/load_config";

interface ParsedOrderbook {
  yesAsks: OrderbookLevel[];
  noAsks: OrderbookLevel[];
  reasonCodes: string[];
}

interface WalkInput {
  rawOrderbook: unknown;
  side: "YES" | "NO";
  targetSizeUsd: number;
  config: Config;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Extract a bid-level array from a variety of plausible shapes. */
function extractLevels(node: unknown): OrderbookLevel[] {
  if (!Array.isArray(node)) return [];
  const out: OrderbookLevel[] = [];
  for (const raw of node) {
    if (raw == null) continue;
    let price: number | undefined;
    let size: number | undefined;
    if (Array.isArray(raw)) {
      // [price, size]
      price = asNumber(raw[0]);
      size = asNumber(raw[1]);
    } else if (typeof raw === "object") {
      const o = raw as Record<string, unknown>;
      price = asNumber(o.price ?? o.p ?? o.px);
      size = asNumber(o.size ?? o.s ?? o.qty ?? o.quantity ?? o.amount);
    }
    if (price === undefined || size === undefined) continue;
    if (!(price > 0) || !(price < 1)) continue; // prediction prices live in (0,1)
    if (!(size > 0)) continue;
    out.push({ price, size });
  }
  return out;
}

/** Pull the YES-bids and NO-bids arrays from the raw payload defensively. */
function locateBids(raw: unknown): { yesBids: OrderbookLevel[]; noBids: OrderbookLevel[]; found: boolean } {
  if (raw == null || typeof raw !== "object") return { yesBids: [], noBids: [], found: false };
  const o = raw as Record<string, unknown>;

  // Common explicit shapes.
  const yesNode =
    o.yesBids ?? o.yes_bids ?? (o.yes as Record<string, unknown> | undefined)?.bids ?? o.bidsYes;
  const noNode =
    o.noBids ?? o.no_bids ?? (o.no as Record<string, unknown> | undefined)?.bids ?? o.bidsNo;

  let yesBids = extractLevels(yesNode);
  let noBids = extractLevels(noNode);

  // Fallback: a `bids` array tagged per side, or generic `bids`/`asks`
  // treated as YES side bids (defensive — better some data than crash).
  if (yesBids.length === 0 && noBids.length === 0) {
    yesBids = extractLevels(o.bids);
  }

  const found = yesBids.length > 0 || noBids.length > 0;
  return { yesBids, noBids, found };
}

/** Flip a bid ladder into the complementary ask ladder (price → 1 − price). */
function flipToAsks(bids: OrderbookLevel[]): OrderbookLevel[] {
  const asks: OrderbookLevel[] = [];
  for (const b of bids) {
    const askPrice = 1 - b.price;
    if (!(askPrice > 0) || !(askPrice < 1)) continue;
    asks.push({ price: askPrice, size: b.size });
  }
  // Asks are walked cheapest-first.
  asks.sort((a, b) => a.price - b.price);
  return asks;
}

export function parseOrderbook(raw: unknown): ParsedOrderbook {
  try {
    const reasonCodes: string[] = [];
    const { yesBids, noBids, found } = locateBids(raw);
    if (!found) {
      reasonCodes.push("ORDERBOOK_EMPTY_OR_MALFORMED");
      return { yesAsks: [], noAsks: [], reasonCodes };
    }
    // BIDS-ONLY flip: real YES asks come from NO bids; real NO asks from YES bids.
    const yesAsks = flipToAsks(noBids);
    const noAsks = flipToAsks(yesBids);
    if (yesAsks.length === 0) reasonCodes.push("NO_YES_ASK_LIQUIDITY");
    if (noAsks.length === 0) reasonCodes.push("NO_NO_ASK_LIQUIDITY");
    return { yesAsks, noAsks, reasonCodes };
  } catch {
    return { yesAsks: [], noAsks: [], reasonCodes: ["ORDERBOOK_PARSE_ERROR"] };
  }
}

export function walkOrderbook(input: WalkInput): OrderbookWalkResult {
  const side = input.side === "NO" ? "NO" : "YES";
  const requestedSizeUsd = Number.isFinite(input.targetSizeUsd) && input.targetSizeUsd > 0 ? input.targetSizeUsd : 0;

  const base: OrderbookWalkResult = {
    side,
    requestedSizeUsd,
    avgFillPrice: null,
    worstFillPrice: null,
    availableSizeUsd: 0,
    fillRatio: 0,
    slippage: null,
    liquidityScore: 0,
    filledAtMid: false,
    reasonCodes: [],
  };

  try {
    const { config } = input;
    const parsed = parseOrderbook(input.rawOrderbook);
    base.reasonCodes.push(...parsed.reasonCodes);

    const asks = side === "YES" ? parsed.yesAsks : parsed.noAsks;
    if (asks.length === 0) {
      base.reasonCodes.push("FILL_QUALITY_POOR");
      return base;
    }
    if (requestedSizeUsd <= 0) {
      base.reasonCodes.push("INVALID_TARGET_SIZE");
      return base;
    }

    // Total available notional across the ask ladder (size is in contracts;
    // notional per level = price * size, since each contract settles to $1).
    let availableSizeUsd = 0;
    for (const lvl of asks) availableSizeUsd += lvl.price * lvl.size;
    base.availableSizeUsd = availableSizeUsd;

    // Walk worst-case (cheapest asks first are best; we consume in price order).
    const bestPrice = asks[0].price;
    let remainingUsd = requestedSizeUsd;
    let spentUsd = 0;
    let filledContracts = 0;
    let worstFillPrice = bestPrice;

    for (const lvl of asks) {
      if (remainingUsd <= 0) break;
      const levelNotional = lvl.price * lvl.size;
      const takeNotional = Math.min(levelNotional, remainingUsd);
      if (takeNotional <= 0) continue;
      const takeContracts = takeNotional / lvl.price;
      spentUsd += takeNotional;
      filledContracts += takeContracts;
      remainingUsd -= takeNotional;
      worstFillPrice = lvl.price; // last (deepest/most expensive) level touched
    }

    const filledUsd = spentUsd;
    const fillRatio = requestedSizeUsd > 0 ? Math.min(1, filledUsd / requestedSizeUsd) : 0;
    base.fillRatio = fillRatio;

    if (filledContracts <= 0) {
      base.reasonCodes.push("FILL_QUALITY_POOR");
      return base;
    }

    // Average fill price = total spent / total contracts acquired.
    const avgFillPrice = filledUsd / filledContracts;
    base.avgFillPrice = avgFillPrice;
    base.worstFillPrice = worstFillPrice;

    // Slippage vs best available ask (never vs mid).
    const slippage = bestPrice > 0 ? avgFillPrice / bestPrice - 1 : null;
    base.slippage = slippage;

    // Liquidity score in [0,1]: combines fill ratio and slippage budget headroom.
    const maxWalkSlippage = Number.isFinite(config.orderbook.maxWalkSlippage) ? config.orderbook.maxWalkSlippage : 0.025;
    const minFillRatio = Number.isFinite(config.orderbook.minFillRatio) ? config.orderbook.minFillRatio : 0.8;
    let slipScore = 1;
    if (slippage !== null && maxWalkSlippage > 0) {
      slipScore = Math.max(0, Math.min(1, 1 - slippage / maxWalkSlippage));
    }
    base.liquidityScore = Math.max(0, Math.min(1, fillRatio * slipScore));

    // Quality gates.
    if (fillRatio < minFillRatio) {
      base.reasonCodes.push("FILL_QUALITY_POOR");
      if (remainingUsd > 0) base.reasonCodes.push("INSUFFICIENT_DEPTH");
    }
    if (slippage !== null && slippage > maxWalkSlippage) {
      base.reasonCodes.push("WALK_SLIPPAGE_EXCEEDED");
      if (!base.reasonCodes.includes("FILL_QUALITY_POOR")) base.reasonCodes.push("FILL_QUALITY_POOR");
    }

    return base;
  } catch {
    base.reasonCodes.push("WALK_INTERNAL_ERROR", "FILL_QUALITY_POOR");
    return base;
  }
}
