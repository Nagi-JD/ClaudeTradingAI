// Momentum / realized-volatility features for the BTC context.
//
// SECONDARY SIGNAL ONLY. Short-horizon price change and realized volatility
// here are derived from CEX spot/perp marks and must NEVER be used as the
// primary settlement price for any market. They feed the optional, ablatable
// microstructure tilt only. Authoritative price comes from the index adapter.
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

/** Coerce an unknown value into an array of finite numbers (prices). */
function asPriceSeries(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const el of v) {
    // Accept bare numbers or { price/close/c/p } objects or [t, price] tuples.
    let p: number | undefined;
    if (typeof el === "number" || typeof el === "string") {
      p = num(el);
    } else if (Array.isArray(el)) {
      p = num(el[1]) ?? num(el[0]);
    } else {
      const r = asRecord(el);
      p = num(r.price) ?? num(r.close) ?? num(r.c) ?? num(r.p);
    }
    if (p !== undefined && p > 0) out.push(p);
  }
  return out;
}

/** Percentage change between the first and last finite price in a series. */
function pctChange(series: number[]): number | undefined {
  if (series.length < 2) return undefined;
  const first = series[0];
  const last = series[series.length - 1];
  if (first <= 0) return undefined;
  return (last - first) / first;
}

/**
 * Realized volatility = standard deviation of consecutive log returns over the
 * series. Returns undefined if fewer than 3 points (need >=2 returns).
 */
function realizedVol(series: number[]): number | undefined {
  if (series.length < 3) return undefined;
  const rets: number[] = [];
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1];
    const cur = series[i];
    if (prev > 0 && cur > 0) rets.push(Math.log(cur / prev));
  }
  if (rets.length < 2) return undefined;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance =
    rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / rets.length;
  if (!Number.isFinite(variance) || variance < 0) return undefined;
  return Math.sqrt(variance);
}

// ─────────────────────────────────────────────────────────── feature ──

/**
 * Compute momentum and realized-volatility features from a raw payload.
 *
 * Accepted (best-effort) raw shapes — any subset may be present:
 *   { btcChange1m, btcChange3m, btcChange5m,
 *     realizedVolatility1m, realizedVolatility5m }   (precomputed)
 *   { prices1m: [...], prices3m: [...], prices5m: [...] } (series to compute from)
 *
 * Returns a Partial<BtcContextSnapshot> with only derivable fields. Never throws.
 */
export function computeMomentumFeatures(
  raw: unknown,
): Partial<BtcContextSnapshot> {
  const out: Partial<BtcContextSnapshot> = {};
  try {
    const r = asRecord(raw);

    const series1m = asPriceSeries(r.prices1m ?? r.series1m);
    const series3m = asPriceSeries(r.prices3m ?? r.series3m);
    const series5m = asPriceSeries(r.prices5m ?? r.series5m);

    // 1. Percentage change windows — prefer precomputed, else from series.
    const c1 = num(r.btcChange1m) ?? num(r.change1m) ?? pctChange(series1m);
    const c3 = num(r.btcChange3m) ?? num(r.change3m) ?? pctChange(series3m);
    const c5 = num(r.btcChange5m) ?? num(r.change5m) ?? pctChange(series5m);
    if (c1 !== undefined) out.btcChange1m = c1;
    if (c3 !== undefined) out.btcChange3m = c3;
    if (c5 !== undefined) out.btcChange5m = c5;

    // 2. Realized volatility windows.
    const rv1 =
      num(r.realizedVolatility1m) ?? num(r.rv1m) ?? realizedVol(series1m);
    const rv5 =
      num(r.realizedVolatility5m) ?? num(r.rv5m) ?? realizedVol(series5m);
    if (rv1 !== undefined) out.realizedVolatility1m = rv1;
    if (rv5 !== undefined) out.realizedVolatility5m = rv5;
  } catch {
    // Fail-safe: return whatever we managed to derive.
  }
  return out;
}
