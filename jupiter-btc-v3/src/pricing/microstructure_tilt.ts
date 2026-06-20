// Microstructure tilt. A SMALL, CAPPED adjustment to the base fair YES price
// derived from secondary BTC-context features (CVD imbalance, liquidation
// imbalance, short-horizon momentum).
//
// SAFETY POSTURE (load-bearing):
//   - DISABLED BY DEFAULT. config.tilts.enabled === false → all zeros +
//     reasonCode TILT_DISABLED. The tilt must NEVER dominate binary pricing.
//   - If basis is unstable → zeros (we don't trust microstructure when the
//     settlement index is decoupled).
//   - Each component is independently capped by config (cvdAdjustmentMax,
//     liquidationAdjustmentMax, momentumAdjustmentMax). The total is the sum of
//     the (already capped) components, then re-capped at the sum of caps.
//
// The `variants` map lets the ablation engine replay any feature subset without
// recomputation:
//   base_only            → 0
//   base_plus_cvd        → cvd only
//   base_plus_liquidations → liquidations only
//   base_plus_momentum   → momentum only
//   base_plus_all        → sum of all three
//
// Never throws.

import type { AblationVariant, BasisSnapshot, BtcContextSnapshot, TiltResult } from "../jupiter_prediction/models";
import type { Config } from "../config/load_config";

interface TiltInput {
  btcContext: BtcContextSnapshot;
  basis: BasisSnapshot;
  fairYesBase: number | null;
  config: Config;
}

function zeroVariants(): Record<AblationVariant, number> {
  return {
    base_only: 0,
    base_plus_cvd: 0,
    base_plus_liquidations: 0,
    base_plus_momentum: 0,
    base_plus_all: 0,
  };
}

function disabledResult(reasonCodes: string[]): TiltResult {
  return {
    tiltTotal: 0,
    tiltBreakdown: { cvd: 0, liquidations: 0, momentum: 0 },
    usedFeatures: [],
    reasonCodes,
    variants: zeroVariants(),
  };
}

/** Clamp x into [-cap, cap]; cap normalized to a non-negative finite number. */
function capped(x: number, cap: number): number {
  if (!Number.isFinite(x)) return 0;
  const c = Number.isFinite(cap) && cap > 0 ? cap : 0;
  return Math.max(-c, Math.min(c, x));
}

/** Map an unbounded signal to [-1,1] via a smooth squashing function. */
function squash(x: number, scale: number): number {
  if (!Number.isFinite(x) || !(scale > 0)) return 0;
  return Math.tanh(x / scale);
}

export function computeTilt(input: TiltInput): TiltResult {
  try {
    const { config, basis, btcContext } = input;

    // Gate 1: disabled by config.
    if (!config?.tilts?.enabled) {
      return disabledResult(["TILT_DISABLED"]);
    }

    // Gate 2: unstable basis → no tilt.
    if (!basis || basis.isStable !== true) {
      return disabledResult(["TILT_BASIS_UNSTABLE"]);
    }

    const reasonCodes: string[] = [];
    const usedFeatures: string[] = [];

    const cvdCap = config.tilts.cvdAdjustmentMax;
    const liqCap = config.tilts.liquidationAdjustmentMax;
    const momCap = config.tilts.momentumAdjustmentMax;

    // CVD imbalance: positive netImbalance5m → buy pressure → tilt YES up.
    let cvd = 0;
    if (btcContext && Number.isFinite(btcContext.netImbalance5m as number)) {
      // Scale heuristic: netImbalance5m is a signed imbalance; squash then cap.
      cvd = capped(squash(btcContext.netImbalance5m as number, 1) * cvdCap, cvdCap);
      usedFeatures.push("cvd");
    } else if (btcContext && Number.isFinite(btcContext.cvd5m as number)) {
      cvd = capped(squash(btcContext.cvd5m as number, 1e6) * cvdCap, cvdCap);
      usedFeatures.push("cvd");
    }

    // Liquidation imbalance: positive imbalance (more shorts liquidated) →
    // upward pressure → tilt YES up.
    let liquidations = 0;
    if (btcContext && Number.isFinite(btcContext.liquidationImbalance5m as number)) {
      liquidations = capped(squash(btcContext.liquidationImbalance5m as number, 1) * liqCap, liqCap);
      usedFeatures.push("liquidations");
    }

    // Momentum: short-horizon return (1m/3m/5m). Positive → tilt YES up.
    let momentum = 0;
    const mom = btcContext
      ? (Number.isFinite(btcContext.btcChange1m as number)
          ? (btcContext.btcChange1m as number)
          : Number.isFinite(btcContext.btcChange3m as number)
            ? (btcContext.btcChange3m as number)
            : Number.isFinite(btcContext.btcChange5m as number)
              ? (btcContext.btcChange5m as number)
              : undefined)
      : undefined;
    if (mom !== undefined) {
      // btcChange* are fractional returns; scale ~0.5% to a full-strength tilt.
      momentum = capped(squash(mom, 0.005) * momCap, momCap);
      usedFeatures.push("momentum");
    }

    const sumCap = (Number.isFinite(cvdCap) && cvdCap > 0 ? cvdCap : 0)
      + (Number.isFinite(liqCap) && liqCap > 0 ? liqCap : 0)
      + (Number.isFinite(momCap) && momCap > 0 ? momCap : 0);
    const tiltTotalRaw = cvd + liquidations + momentum;
    const tiltTotal = Math.max(-sumCap, Math.min(sumCap, tiltTotalRaw));

    if (usedFeatures.length === 0) {
      reasonCodes.push("TILT_NO_FEATURES");
    }

    const variants: Record<AblationVariant, number> = {
      base_only: 0,
      base_plus_cvd: cvd,
      base_plus_liquidations: liquidations,
      base_plus_momentum: momentum,
      base_plus_all: tiltTotal,
    };

    return {
      tiltTotal,
      tiltBreakdown: { cvd, liquidations, momentum },
      usedFeatures,
      reasonCodes,
      variants,
    };
  } catch {
    return disabledResult(["TILT_INTERNAL_ERROR"]);
  }
}
