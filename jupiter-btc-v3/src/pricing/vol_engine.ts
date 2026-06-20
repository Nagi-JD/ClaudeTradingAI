// Volatility engine: empirical, conservative, fail-safe.
//
// Computes realized-volatility (RV) windows from index tick log-returns, an
// EWMA vol estimate, jump detection, a vol regime classification, and the
// expected terminal move over `secondsLeft` conditioned on the settlement
// mechanic.
//
// Mechanic conditioning (the core empirical assumption):
//   - POINT_IN_TIME : settlement reads a single instantaneous price → the full
//     terminal expected move applies.
//   - TWAP / WINDOW : settlement averages prices over a window → the variance of
//     the averaged quantity is lower. For a uniform average over a window the
//     variance of the mean is ~1/3 of the terminal variance, so effective σ is
//     reduced by ÷√3. This is conservative: it shrinks the move (widening the
//     distance-to-target in σ units only if move grows; here it makes pricing
//     pull toward the mean, i.e. less extreme — intentionally cautious).
//   - UNKNOWN : we cannot condition σ safely → volConfidence 0 (block).
//
// Never throws. On any data problem returns DATA_STALE / volConfidence 0 with
// explanatory reasonCodes.

import type { SettlementMechanic, VolSnapshot, VolRegime } from "../jupiter_prediction/models";
import type { Config } from "../config/load_config";

// Variance-reduction factor for averaged (TWAP/WINDOW) settlement.
const TWAP_SIGMA_DIVISOR = Math.sqrt(3);

// Window definitions in seconds. Each RV window needs enough samples inside it.
const WINDOWS: { key: keyof Pick<VolSnapshot, "rv10s" | "rv30s" | "rv1m" | "rv3m" | "rv5m">; seconds: number }[] = [
  { key: "rv10s", seconds: 10 },
  { key: "rv30s", seconds: 30 },
  { key: "rv1m", seconds: 60 },
  { key: "rv3m", seconds: 180 },
  { key: "rv5m", seconds: 300 },
];

// Staleness threshold: if the most recent tick is older than this, data is stale.
const STALE_AGE_MS = 5000;

interface Tick {
  t: number;
  price: number;
}

interface VolInput {
  indexTicks: { t: number; price: number }[];
  secondsLeft: number;
  settlementMechanic: SettlementMechanic;
  config: Config;
  nowMs?: number;
}

function safeBlocked(reasonCodes: string[]): VolSnapshot {
  return {
    regime: "DATA_STALE",
    expectedMoveUsd: null,
    volConfidence: 0,
    reasonCodes,
  };
}

/**
 * Per-second log-return volatility over ticks within `windowSeconds` of `nowMs`.
 * Returns { volPerSec, sampleCount } or undefined when too few samples.
 */
function rvPerSecond(
  ticks: Tick[],
  windowSeconds: number,
  nowMs: number,
): { volPerSec: number; sampleCount: number } | undefined {
  const cutoff = nowMs - windowSeconds * 1000;
  const inWindow = ticks.filter((t) => t.t >= cutoff);
  if (inWindow.length < 2) return undefined;

  // Standardize each log-return to a per-second basis so windows are comparable.
  const perSecReturns: number[] = [];
  for (let i = 1; i < inWindow.length; i++) {
    const prev = inWindow[i - 1];
    const cur = inWindow[i];
    if (!(prev.price > 0) || !(cur.price > 0)) continue;
    const dtSec = (cur.t - prev.t) / 1000;
    if (!(dtSec > 0)) continue;
    const logRet = Math.log(cur.price / prev.price);
    // Scale to per-second: r_sec = r / sqrt(dt) (Brownian scaling of std dev).
    perSecReturns.push(logRet / Math.sqrt(dtSec));
  }
  if (perSecReturns.length < 1) return undefined;

  // Population variance around mean (per-second log returns).
  const mean = perSecReturns.reduce((a, b) => a + b, 0) / perSecReturns.length;
  let variance = 0;
  for (const r of perSecReturns) variance += (r - mean) * (r - mean);
  variance /= perSecReturns.length;
  const volPerSec = Math.sqrt(Math.max(variance, 0));
  if (!Number.isFinite(volPerSec)) return undefined;
  return { volPerSec, sampleCount: perSecReturns.length + 1 };
}

/** EWMA of squared per-second log-returns → per-second vol. */
function ewmaVolPerSecond(ticks: Tick[], lambda: number): number | undefined {
  if (ticks.length < 2) return undefined;
  const lam = Number.isFinite(lambda) && lambda > 0 && lambda < 1 ? lambda : 0.94;
  let ewmaVar: number | undefined;
  for (let i = 1; i < ticks.length; i++) {
    const prev = ticks[i - 1];
    const cur = ticks[i];
    if (!(prev.price > 0) || !(cur.price > 0)) continue;
    const dtSec = (cur.t - prev.t) / 1000;
    if (!(dtSec > 0)) continue;
    const rSec = Math.log(cur.price / prev.price) / Math.sqrt(dtSec);
    const sq = rSec * rSec;
    ewmaVar = ewmaVar === undefined ? sq : lam * ewmaVar + (1 - lam) * sq;
  }
  if (ewmaVar === undefined) return undefined;
  const v = Math.sqrt(Math.max(ewmaVar, 0));
  return Number.isFinite(v) ? v : undefined;
}

/** Jump detection: max abs z-score of the most recent per-second return vs EWMA vol. */
function detectJump(ticks: Tick[], ewmaVol: number | undefined): number {
  if (ewmaVol === undefined || !(ewmaVol > 0) || ticks.length < 2) return 0;
  let maxZ = 0;
  for (let i = 1; i < ticks.length; i++) {
    const prev = ticks[i - 1];
    const cur = ticks[i];
    if (!(prev.price > 0) || !(cur.price > 0)) continue;
    const dtSec = (cur.t - prev.t) / 1000;
    if (!(dtSec > 0)) continue;
    const rSec = Math.log(cur.price / prev.price) / Math.sqrt(dtSec);
    const z = Math.abs(rSec) / ewmaVol;
    if (Number.isFinite(z) && z > maxZ) maxZ = z;
  }
  return maxZ;
}

export function computeVol(input: VolInput): VolSnapshot {
  try {
    const { config, settlementMechanic } = input;
    const nowMs = input.nowMs ?? Date.now();
    const secondsLeft = input.secondsLeft;
    const reasonCodes: string[] = [];

    const rawTicks = Array.isArray(input.indexTicks) ? input.indexTicks : [];
    // Defensive: keep only finite, positively-priced ticks, sorted by time.
    const ticks: Tick[] = rawTicks
      .filter(
        (t): t is Tick =>
          t != null &&
          typeof t.t === "number" &&
          Number.isFinite(t.t) &&
          typeof t.price === "number" &&
          Number.isFinite(t.price) &&
          t.price > 0,
      )
      .sort((a, b) => a.t - b.t);

    const minSamples = config.vol.minSamples > 0 ? config.vol.minSamples : 30;

    if (ticks.length < 2) {
      reasonCodes.push("VOL_NO_DATA");
      return safeBlocked(reasonCodes);
    }

    const lastTick = ticks[ticks.length - 1];
    const lastPrice = lastTick.price;
    const dataAgeMs = nowMs - lastTick.t;

    if (dataAgeMs > STALE_AGE_MS) {
      reasonCodes.push("VOL_DATA_STALE");
      return safeBlocked(reasonCodes);
    }

    // UNKNOWN mechanic: we cannot condition σ → block.
    if (settlementMechanic === "UNKNOWN" || settlementMechanic === undefined) {
      reasonCodes.push("VOL_MECHANIC_UNKNOWN");
      return safeBlocked(reasonCodes);
    }

    // RV windows.
    const snapshot: VolSnapshot = {
      regime: "NORMAL_VOL",
      expectedMoveUsd: null,
      volConfidence: 0,
      reasonCodes,
    };

    let totalSamples = ticks.length;
    let chosenVolPerSec: number | undefined;
    // Prefer the shortest window that has data; fall back to longer windows.
    for (const w of WINDOWS) {
      const r = rvPerSecond(ticks, w.seconds, nowMs);
      if (r) {
        snapshot[w.key] = r.volPerSec;
        if (chosenVolPerSec === undefined) {
          chosenVolPerSec = r.volPerSec;
          totalSamples = r.sampleCount;
        }
      }
    }

    const ewma = ewmaVolPerSecond(ticks, config.vol.ewmaLambda);
    snapshot.ewmaVol = ewma;

    // Use EWMA when available (more responsive), else shortest RV window.
    let volPerSec = ewma ?? chosenVolPerSec;
    if (volPerSec === undefined || !(volPerSec > 0)) {
      reasonCodes.push("VOL_INSUFFICIENT_RETURNS");
      return safeBlocked(reasonCodes);
    }

    // Jump detection.
    const jumpZThreshold = Number.isFinite(config.vol.jumpZThreshold) ? config.vol.jumpZThreshold : 4.0;
    const jumpMult = Number.isFinite(config.vol.jumpRegimeMultiplier) && config.vol.jumpRegimeMultiplier > 0
      ? config.vol.jumpRegimeMultiplier
      : 1.5;
    const maxZ = detectJump(ticks, ewma ?? chosenVolPerSec);
    let jumpAdjustedVol = volPerSec;
    let regime: VolRegime = "NORMAL_VOL";
    if (maxZ >= jumpZThreshold) {
      jumpAdjustedVol = volPerSec * jumpMult;
      regime = "JUMPY";
      reasonCodes.push("VOL_JUMP_DETECTED");
    }
    snapshot.jumpAdjustedVol = jumpAdjustedVol;

    // Regime classification by relative magnitude (heuristic bands on per-sec vol),
    // unless already flagged JUMPY. Bands derived empirically as bps of price/sec.
    if (regime !== "JUMPY") {
      const bpsPerSec = volPerSec * 10000; // log-return ≈ fractional; ×1e4 = bps.
      if (bpsPerSec < 1) regime = "LOW_VOL";
      else if (bpsPerSec > 8) regime = "HIGH_VOL";
      else regime = "NORMAL_VOL";
    }
    snapshot.regime = regime;

    // Effective σ conditioned on mechanic.
    let effectiveVolPerSec = jumpAdjustedVol;
    if (settlementMechanic === "TWAP" || settlementMechanic === "WINDOW") {
      effectiveVolPerSec = effectiveVolPerSec / TWAP_SIGMA_DIVISOR;
      reasonCodes.push("VOL_MECHANIC_AVERAGED");
    }

    // Expected terminal move (USD). Only meaningful with positive time left.
    let expectedMoveUsd: number | null = null;
    if (Number.isFinite(secondsLeft) && secondsLeft > 0) {
      expectedMoveUsd = lastPrice * effectiveVolPerSec * Math.sqrt(secondsLeft);
      if (!Number.isFinite(expectedMoveUsd) || expectedMoveUsd <= 0) {
        expectedMoveUsd = null;
        reasonCodes.push("VOL_EXPECTED_MOVE_INVALID");
      }
    } else {
      reasonCodes.push("VOL_NO_TIME_LEFT");
    }
    snapshot.expectedMoveUsd = expectedMoveUsd;

    // volConfidence: start at 1, reduce for insufficient samples and stale-ish data.
    let volConfidence = 1;
    if (totalSamples < minSamples) {
      const ratio = totalSamples / minSamples;
      volConfidence *= Math.max(0, Math.min(1, ratio));
      reasonCodes.push("VOL_INSUFFICIENT_SAMPLES");
    }
    // Penalize moderate staleness within the acceptable window.
    if (dataAgeMs > STALE_AGE_MS / 2) {
      volConfidence *= 1 - (dataAgeMs - STALE_AGE_MS / 2) / (STALE_AGE_MS / 2);
    }
    // Apply low-confidence penalty config when in JUMPY regime (uncertain σ).
    if (regime === "JUMPY") {
      const pen = Number.isFinite(config.vol.lowConfidencePenalty) ? config.vol.lowConfidencePenalty : 0.5;
      volConfidence *= Math.max(0, Math.min(1, 1 - pen));
    }
    if (expectedMoveUsd === null) {
      volConfidence = 0;
    }
    snapshot.volConfidence = Math.max(0, Math.min(1, volConfidence));

    return snapshot;
  } catch {
    return safeBlocked(["VOL_INTERNAL_ERROR"]);
  }
}
