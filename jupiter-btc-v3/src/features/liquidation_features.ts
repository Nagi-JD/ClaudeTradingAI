// Liquidation / liquidation-heatmap features for the BTC context.
//
// SECONDARY SIGNAL ONLY. Liquidation volumes and near-price liquidation
// clusters describe CEX perp positioning. They must NEVER be used as the
// primary settlement price for any market — they only inform the optional,
// ablatable microstructure tilt. Settlement price comes from the index adapter.
//
// Pure + defensive: no I/O, no throwing. Unknown / malformed input yields an
// empty partial so the caller can merge safely.

import type { BtcContextSnapshot } from "../jupiter_prediction/models";

// ───────────────────────────────────────────────────────────── helpers ──

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/**
 * Sum liquidation notional within a price band around `priceNow`. Accepts a
 * heatmap-style array of { price, value/notional/size, side } entries. Returns
 * the long-side and short-side notional within `pct` (fractional, e.g. 0.01)
 * of the current price, or undefined if nothing usable.
 *
 * Convention: a "long" liquidation cluster sits BELOW price (longs get
 * liquidated as price falls); a "short" cluster sits ABOVE price. If an
 * explicit side is provided we honor it; otherwise we infer from position.
 */
function sumNearLiquidations(
  levels: unknown,
  priceNow: number | undefined,
  pct: number,
): { long: number; short: number } | undefined {
  if (!Array.isArray(levels) || levels.length === 0) return undefined;
  if (priceNow === undefined || priceNow <= 0) return undefined;
  const band = priceNow * pct;
  let long = 0;
  let short = 0;
  let seen = false;
  for (const lvl of levels) {
    const r = asRecord(lvl);
    const price = num(r.price) ?? num(r.p);
    const value =
      num(r.value) ?? num(r.notional) ?? num(r.size) ?? num(r.qty);
    if (price === undefined || value === undefined) continue;
    if (Math.abs(price - priceNow) > band) continue;
    const side = typeof r.side === "string" ? r.side.toLowerCase() : undefined;
    let isLong: boolean;
    if (side === "long" || side === "buy") isLong = true;
    else if (side === "short" || side === "sell") isLong = false;
    else isLong = price < priceNow; // longs liquidated below current price
    if (isLong) long += Math.abs(value);
    else short += Math.abs(value);
    seen = true;
  }
  return seen ? { long, short } : undefined;
}

// ─────────────────────────────────────────────────────────── feature ──

/**
 * Compute liquidation features from a raw MoonDev-style payload.
 *
 * Accepted (best-effort) raw shapes — any subset may be present:
 *   { liquidationLongVolume5m, liquidationShortVolume5m }       (precomputed)
 *   { nearLiqLongValue1pct, nearLiqShortValue1pct, ... }        (precomputed)
 *   { btcCexPriceNow, priceNow, liquidationHeatmap: [...] }     (heatmap to band-sum)
 *
 * Returns a Partial<BtcContextSnapshot> with only derivable fields. Never throws.
 */
export function computeLiquidationFeatures(
  raw: unknown,
): Partial<BtcContextSnapshot> {
  const out: Partial<BtcContextSnapshot> = {};
  try {
    const r = asRecord(raw);

    // 1. 5m liquidation volumes by side.
    const longVol =
      num(r.liquidationLongVolume5m) ?? num(r.liqLongVolume5m) ?? num(r.long_liq_5m);
    const shortVol =
      num(r.liquidationShortVolume5m) ??
      num(r.liqShortVolume5m) ??
      num(r.short_liq_5m);
    if (longVol !== undefined) out.liquidationLongVolume5m = longVol;
    if (shortVol !== undefined) out.liquidationShortVolume5m = shortVol;

    // 2. Imbalance over 5m, normalized to [-1, 1] when total > 0.
    let imb =
      num(r.liquidationImbalance5m) ?? num(r.liq_imbalance_5m);
    if (imb === undefined && longVol !== undefined && shortVol !== undefined) {
      const total = longVol + shortVol;
      imb = total > 0 ? (longVol - shortVol) / total : 0;
    }
    if (imb !== undefined) out.liquidationImbalance5m = imb;

    // 3. Near-price liquidation clusters (1% / 2%) — prefer precomputed.
    const long1 = num(r.nearLiqLongValue1pct) ?? num(r.near_liq_long_1pct);
    const short1 = num(r.nearLiqShortValue1pct) ?? num(r.near_liq_short_1pct);
    const long2 = num(r.nearLiqLongValue2pct) ?? num(r.near_liq_long_2pct);
    const short2 = num(r.nearLiqShortValue2pct) ?? num(r.near_liq_short_2pct);
    if (long1 !== undefined) out.nearLiqLongValue1pct = long1;
    if (short1 !== undefined) out.nearLiqShortValue1pct = short1;
    if (long2 !== undefined) out.nearLiqLongValue2pct = long2;
    if (short2 !== undefined) out.nearLiqShortValue2pct = short2;

    // 4. Fall back to banding a heatmap if explicit near-liq values are absent.
    const needBand =
      out.nearLiqLongValue1pct === undefined ||
      out.nearLiqShortValue1pct === undefined ||
      out.nearLiqLongValue2pct === undefined ||
      out.nearLiqShortValue2pct === undefined;
    if (needBand) {
      const heatmap = r.liquidationHeatmap ?? r.heatmap ?? r.liqLevels;
      const priceNow =
        num(r.btcCexPriceNow) ?? num(r.priceNow) ?? num(r.price);
      const b1 = sumNearLiquidations(heatmap, priceNow, 0.01);
      const b2 = sumNearLiquidations(heatmap, priceNow, 0.02);
      if (b1) {
        if (out.nearLiqLongValue1pct === undefined) out.nearLiqLongValue1pct = b1.long;
        if (out.nearLiqShortValue1pct === undefined) out.nearLiqShortValue1pct = b1.short;
      }
      if (b2) {
        if (out.nearLiqLongValue2pct === undefined) out.nearLiqLongValue2pct = b2.long;
        if (out.nearLiqShortValue2pct === undefined) out.nearLiqShortValue2pct = b2.short;
      }
    }
  } catch {
    // Fail-safe: return whatever we managed to derive.
  }
  return out;
}
