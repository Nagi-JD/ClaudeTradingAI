// CVD (Cumulative Volume Delta) / order-flow features for the BTC context.
//
// SECONDARY SIGNAL ONLY. These features describe CEX spot/perp order flow and
// must NEVER be used as the primary settlement price for any market. They feed
// the microstructure tilt (a small, ablatable nudge) — not fair value. The
// authoritative price always comes from the settlement index adapter.
//
// Pure + defensive: no I/O, no throwing. Unknown / malformed input yields an
// empty partial so the caller can merge safely and downstream code treats the
// missing fields as undefined.

import type { BtcContextSnapshot } from "../jupiter_prediction/models";

// ───────────────────────────────────────────────────────────── helpers ──

/** Coerce an unknown value to a finite number, else undefined. */
function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Treat the raw input as a record we can index into; else empty object. */
function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/**
 * Sum buy/sell notional from a trades array if present. Each element may carry
 * { side, qty/size, price, isBuyerMaker, ... } in a MoonDev-style shape. We are
 * deliberately liberal in what we accept and never throw.
 */
function aggregateTrades(
  trades: unknown,
): { buy: number; sell: number } | undefined {
  if (!Array.isArray(trades) || trades.length === 0) return undefined;
  let buy = 0;
  let sell = 0;
  let seen = false;
  for (const t of trades) {
    const r = asRecord(t);
    const qty = num(r.qty) ?? num(r.size) ?? num(r.amount) ?? num(r.quantity);
    if (qty === undefined) continue;
    const price = num(r.price) ?? num(r.p) ?? 1;
    const notional = Math.abs(qty) * Math.abs(price);
    // Determine direction. Prefer explicit side, fall back to maker flag.
    const side = typeof r.side === "string" ? r.side.toLowerCase() : undefined;
    const isBuyerMaker =
      typeof r.isBuyerMaker === "boolean" ? r.isBuyerMaker : undefined;
    let isBuy: boolean | undefined;
    if (side === "buy" || side === "b") isBuy = true;
    else if (side === "sell" || side === "s") isBuy = false;
    else if (isBuyerMaker !== undefined) isBuy = !isBuyerMaker; // taker buys when buyer is NOT maker
    if (isBuy === undefined) continue;
    if (isBuy) buy += notional;
    else sell += notional;
    seen = true;
  }
  return seen ? { buy, sell } : undefined;
}

// ─────────────────────────────────────────────────────────── feature ──

/**
 * Compute CVD / order-flow imbalance features from a raw MoonDev-style payload.
 *
 * Accepted (best-effort) raw shapes — any subset may be present:
 *   { cvd1m, cvd3m, cvd5m, buyVolume5m, sellVolume5m }   (precomputed)
 *   { trades5m: [...], trades1m: [...], trades3m: [...] } (raw trades to aggregate)
 *
 * Returns a Partial<BtcContextSnapshot> containing only the fields it could
 * derive. Never throws.
 */
export function computeCvdFeatures(raw: unknown): Partial<BtcContextSnapshot> {
  const out: Partial<BtcContextSnapshot> = {};
  try {
    const r = asRecord(raw);

    // 1. Directly-provided CVD windows.
    const cvd1m = num(r.cvd1m) ?? num(r.cvd_1m);
    const cvd3m = num(r.cvd3m) ?? num(r.cvd_3m);
    const cvd5m = num(r.cvd5m) ?? num(r.cvd_5m);
    if (cvd1m !== undefined) out.cvd1m = cvd1m;
    if (cvd3m !== undefined) out.cvd3m = cvd3m;
    if (cvd5m !== undefined) out.cvd5m = cvd5m;

    // 2. Buy/sell pressure over the 5m window — prefer precomputed, else aggregate.
    let buy = num(r.buyVolume5m) ?? num(r.buyPressure5m) ?? num(r.buy_volume_5m);
    let sell =
      num(r.sellVolume5m) ?? num(r.sellPressure5m) ?? num(r.sell_volume_5m);

    if (buy === undefined || sell === undefined) {
      const agg = aggregateTrades(r.trades5m ?? r.trades);
      if (agg) {
        buy = buy ?? agg.buy;
        sell = sell ?? agg.sell;
      }
    }

    if (buy !== undefined) out.buyPressure5m = buy;
    if (sell !== undefined) out.sellPressure5m = sell;

    // 3. Net imbalance over 5m, normalized to [-1, 1] when total > 0.
    let net = num(r.netImbalance5m) ?? num(r.net_imbalance_5m);
    if (net === undefined && buy !== undefined && sell !== undefined) {
      const total = buy + sell;
      net = total > 0 ? (buy - sell) / total : 0;
    }
    if (net !== undefined) out.netImbalance5m = net;

    // 4. Derive cvd5m from buy/sell if not directly provided.
    if (out.cvd5m === undefined && buy !== undefined && sell !== undefined) {
      out.cvd5m = buy - sell;
    }
  } catch {
    // Fail-safe: return whatever we managed to derive (possibly empty).
  }
  return out;
}
