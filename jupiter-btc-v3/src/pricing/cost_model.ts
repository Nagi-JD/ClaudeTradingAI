// Cost model. Turns a fair value plus the actual orderbook walk into the REAL
// effective buy price and the net edge after all frictions.
//
// PRINCIPLE: We NEVER use the mid. The effective buy price starts from the walk
// avgFillPrice (the price we'd actually pay crossing real ask liquidity) and is
// then degraded by:
//   - base slippage (config.costs.baseSlippage), scaled up in fast regimes
//   - latency penalty (worse when we're slow relative to time left)
//   - failed-fill penalty (adverse selection: when a quote looks good but we
//     can't fill it, that is NOT free — we model the cost of chasing/missing)
//   - a fee estimate
//
// netEdge = fair − effectivePrice − (latencyPenalty + failedFillPenalty + fee)
//
// Adverse selection: a high fill ratio with low slippage scores well; a poor
// fill (low ratio) is penalized via failedFillPenalty even if the *visible*
// quote was attractive. Good unfilled quotes are explicitly NOT treated as free.
//
// Never throws.

import type { CostModelResult, MeasuredLatencySnapshot, OrderbookWalkResult, VolRegime } from "../jupiter_prediction/models";
import type { Config } from "../config/load_config";

interface CostInput {
  walkYes?: OrderbookWalkResult;
  walkNo?: OrderbookWalkResult;
  latency: MeasuredLatencySnapshot;
  volRegime: VolRegime;
  secondsLeft: number;
  fairYesTilted: number | null;
  fairNoTilted: number | null;
  config: Config;
}

// Regime multipliers on slippage — faster/jumpier regimes cost more to cross.
const REGIME_SLIP_MULT: Record<VolRegime, number> = {
  LOW_VOL: 0.8,
  NORMAL_VOL: 1.0,
  HIGH_VOL: 1.4,
  JUMPY: 2.0,
  DATA_STALE: 2.0,
};

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

export function computeCosts(input: CostInput): CostModelResult {
  const reasonCodes: string[] = [];
  try {
    const { config, latency, volRegime, secondsLeft } = input;

    const baseSlippage = Number.isFinite(config.costs.baseSlippage) ? config.costs.baseSlippage : 0.015;
    const marketSlipMult = Number.isFinite(config.costs.marketOrderSlippageMultiplier)
      ? config.costs.marketOrderSlippageMultiplier
      : 1.5;
    const latencyMult = Number.isFinite(config.costs.latencyPenaltyMultiplier) ? config.costs.latencyPenaltyMultiplier : 1.0;
    const failedFillPenaltyCfg = Number.isFinite(config.costs.failedFillPenalty) ? config.costs.failedFillPenalty : 0.01;
    const regimeMult = REGIME_SLIP_MULT[volRegime] ?? 1.0;

    // Fee estimate: prediction venues typically take a small per-contract fee.
    // We model a flat conservative fee in price terms.
    const feeEstimate = 0.0; // venue fee unknown in this build; explicit & conservative

    // Expected slippage applied to fills (multiplicative on the regime/market basis).
    const expectedSlippage = baseSlippage * regimeMult;

    // Latency penalty: grows with p95 latency relative to time left. When we
    // have little time left or are slow, the price can move against us before
    // the order lands. Expressed in price (probability) terms.
    const p95 = Number.isFinite(latency?.p95) ? latency.p95 : 0;
    let latencyPenalty = 0;
    if (p95 > 0 && Number.isFinite(secondsLeft) && secondsLeft > 0) {
      const frac = clamp01(p95 / (secondsLeft * 1000));
      latencyPenalty = latencyMult * baseSlippage * frac;
    } else if (latency && latency.withinBudget === false) {
      latencyPenalty = latencyMult * baseSlippage; // worst case if budget blown
      reasonCodes.push("LATENCY_BUDGET_EXCEEDED");
    }

    function effectivePriceFor(
      walk: OrderbookWalkResult | undefined,
      label: "YES" | "NO",
    ): { effective: number | null; failedFill: number } {
      if (!walk || walk.avgFillPrice === null || !Number.isFinite(walk.avgFillPrice)) {
        reasonCodes.push(`COST_NO_FILL_${label}`);
        return { effective: null, failedFill: failedFillPenaltyCfg };
      }
      // Degrade the actual avg fill by expected slippage + market-order premium.
      const slip = expectedSlippage * marketSlipMult;
      let effective = walk.avgFillPrice * (1 + slip);

      // Adverse-selection / failed-fill penalty: scale by how far short of a
      // full, clean fill we were. A poor fill ratio means we likely chase or
      // miss — that opportunity cost is charged here, never assumed free.
      const fillRatio = Number.isFinite(walk.fillRatio) ? walk.fillRatio : 0;
      const shortfall = clamp01(1 - fillRatio);
      let failedFill = failedFillPenaltyCfg * shortfall;
      if (walk.reasonCodes?.includes("FILL_QUALITY_POOR")) {
        failedFill = Math.max(failedFill, failedFillPenaltyCfg * 0.5);
        reasonCodes.push(`COST_POOR_FILL_${label}`);
      }
      // Effective price cannot exceed 1 (a binary contract caps at $1).
      effective = Math.min(1, effective);
      return { effective, failedFill };
    }

    const yes = effectivePriceFor(input.walkYes, "YES");
    const no = effectivePriceFor(input.walkNo, "NO");

    const failedFillPenalty = Math.max(yes.failedFill, no.failedFill);

    function netEdge(fair: number | null, effective: number | null): number | null {
      if (fair === null || !Number.isFinite(fair) || effective === null || !Number.isFinite(effective)) return null;
      return fair - effective - (latencyPenalty + failedFillPenalty + feeEstimate);
    }

    const netEdgeYes = netEdge(input.fairYesTilted, yes.effective);
    const netEdgeNo = netEdge(input.fairNoTilted, no.effective);

    // Fill quality score: best available walk liquidity score, penalized by
    // latency fraction. In [0,1].
    const liqYes = input.walkYes ? clamp01(input.walkYes.liquidityScore) : 0;
    const liqNo = input.walkNo ? clamp01(input.walkNo.liquidityScore) : 0;
    const liqBest = Math.max(liqYes, liqNo);
    const latencyDrag = clamp01(latencyPenalty / Math.max(baseSlippage, 1e-9));
    const fillQualityScore = clamp01(liqBest * (1 - 0.5 * latencyDrag));

    return {
      effectiveBuyYesPrice: yes.effective,
      effectiveBuyNoPrice: no.effective,
      expectedSlippage,
      latencyPenalty,
      failedFillPenalty,
      feeEstimate,
      netEdgeYes,
      netEdgeNo,
      fillQualityScore,
      reasonCodes,
    };
  } catch {
    return {
      effectiveBuyYesPrice: null,
      effectiveBuyNoPrice: null,
      expectedSlippage: 0,
      latencyPenalty: 0,
      failedFillPenalty: 0,
      feeEstimate: 0,
      netEdgeYes: null,
      netEdgeNo: null,
      fillQualityScore: 0,
      reasonCodes: ["COST_INTERNAL_ERROR"],
    };
  }
}
