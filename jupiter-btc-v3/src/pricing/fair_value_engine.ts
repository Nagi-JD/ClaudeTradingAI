// Fair value engine — the ASSEMBLER. Combines the already-computed binary base
// price, the microstructure tilt, and the cost model into a single
// FairValueResult. It does NOT recompute any of those (no cycles): it consumes
// their outputs and composes the final fair/edge/confidence view.
//
//   fairYesTilted = clamp(fairYesBase + tilt.tiltTotal)   (clamp from config)
//   fairNoTilted  = clamp(fairNoBase  − tilt.tiltTotal)   (kept complementary)
//
// Gross edge: fair − market BUY price (from the normalized market snapshot).
// Net edge:   taken from the cost model (fair − effective price − penalties).
//
// confidenceScore in [0,1] starts at 1 and is multiplicatively reduced by:
//   - low settlement rule confidence
//   - low vol confidence
//   - basis instability
//   - poor fill quality
//   - high latency (out of budget)
//
// Never throws.

import type {
  BasisSnapshot,

  CostModelResult,
  FairValueResult,
  MeasuredLatencySnapshot,
  NormalizedMarketSnapshot,
  SettlementSpec,
  TiltResult,
  VolSnapshot,
} from "../jupiter_prediction/models";
import type { Config } from "../config/load_config";
import type { BinaryPriceResult } from "./binary_pricer";

interface FairValueInput {
  binary: BinaryPriceResult;
  tilt: TiltResult;
  cost?: CostModelResult;
  market: NormalizedMarketSnapshot;
  settlement: SettlementSpec;
  vol: VolSnapshot;
  basis: BasisSnapshot;
  latency?: MeasuredLatencySnapshot;
  config: Config;
}

function clampPrice(x: number, lo: number, hi: number): number {
  const a = Math.min(lo, hi);
  const b = Math.max(lo, hi);
  return Math.max(a, Math.min(b, x));
}

export function computeFairValue(input: FairValueInput): FairValueResult {
  const reasonCodes: string[] = [];
  try {
    const { binary, tilt, cost, market, settlement, vol, basis, latency, config } = input;

    // Carry forward base reason codes from the binary pricer.
    if (Array.isArray(binary?.reasonCodes)) reasonCodes.push(...binary.reasonCodes);

    const fairYesBase = binary?.fairYesBase ?? null;
    const fairNoBase = binary?.fairNoBase ?? null;
    const zScore = binary?.zScore ?? null;
    const expectedMoveUsd = binary?.expectedMoveUsd ?? null;
    const distanceToTarget = binary?.distanceToTarget ?? null;

    const clampMin = Number.isFinite(config.binaryPricing.clampMin) ? config.binaryPricing.clampMin : 0.01;
    const clampMax = Number.isFinite(config.binaryPricing.clampMax) ? config.binaryPricing.clampMax : 0.99;

    // Apply tilt (small, already-capped) on top of the base.
    const tiltTotal = Number.isFinite(tilt?.tiltTotal) ? tilt.tiltTotal : 0;
    let fairYesTilted: number | null = null;
    let fairNoTilted: number | null = null;
    if (fairYesBase !== null && Number.isFinite(fairYesBase)) {
      fairYesTilted = clampPrice(fairYesBase + tiltTotal, clampMin, clampMax);
      // Keep complementary so YES + NO ≈ 1 within clamp bounds.
      fairNoTilted = clampPrice(1 - fairYesTilted, clampMin, clampMax);
    } else if (fairNoBase !== null && Number.isFinite(fairNoBase)) {
      fairNoTilted = clampPrice(fairNoBase - tiltTotal, clampMin, clampMax);
      fairYesTilted = clampPrice(1 - fairNoTilted, clampMin, clampMax);
    } else {
      reasonCodes.push("FAIR_NO_BASE_PRICE");
    }
    if (Array.isArray(tilt?.reasonCodes)) reasonCodes.push(...tilt.reasonCodes);

    // Gross edges vs the market's BUY prices (what we'd pay on the screen).
    const buyYes = Number.isFinite(market?.buyYesPriceUsd as number) ? (market.buyYesPriceUsd as number) : null;
    const buyNo = Number.isFinite(market?.buyNoPriceUsd as number) ? (market.buyNoPriceUsd as number) : null;

    const edgeYesGross =
      fairYesTilted !== null && buyYes !== null ? fairYesTilted - buyYes : null;
    const edgeNoGross =
      fairNoTilted !== null && buyNo !== null ? fairNoTilted - buyNo : null;
    if (buyYes === null && buyNo === null) reasonCodes.push("FAIR_NO_MARKET_PRICE");

    // Net edges from the cost model (already fair − effective − penalties).
    const edgeYesNet = cost?.netEdgeYes ?? null;
    const edgeNoNet = cost?.netEdgeNo ?? null;
    if (Array.isArray(cost?.reasonCodes)) reasonCodes.push(...(cost!.reasonCodes));

    // ── confidence score ────────────────────────────────────────────────────
    let confidenceScore = 1;

    // Rule confidence.
    const ruleConf = Number.isFinite(settlement?.ruleConfidence) ? settlement.ruleConfidence : 0;
    confidenceScore *= Math.max(0, Math.min(1, ruleConf));
    if (ruleConf < (Number.isFinite(config.settlement.minRuleConfidence) ? config.settlement.minRuleConfidence : 0.85)) {
      reasonCodes.push("FAIR_LOW_RULE_CONFIDENCE");
    }

    // Vol confidence.
    const volConf = Number.isFinite(vol?.volConfidence) ? vol.volConfidence : 0;
    confidenceScore *= Math.max(0, Math.min(1, volConf));
    if (volConf < 0.5) reasonCodes.push("FAIR_LOW_VOL_CONFIDENCE");

    // Basis instability.
    if (basis?.isStable !== true) {
      confidenceScore *= 0.5;
      reasonCodes.push("FAIR_BASIS_UNSTABLE");
    }

    // Fill quality.
    if (cost) {
      const fq = Number.isFinite(cost.fillQualityScore) ? cost.fillQualityScore : 0;
      confidenceScore *= Math.max(0.1, Math.min(1, fq));
      if (fq < 0.5) reasonCodes.push("FAIR_POOR_FILL");
    }

    // Latency.
    if (latency && latency.withinBudget === false) {
      confidenceScore *= 0.5;
      reasonCodes.push("FAIR_HIGH_LATENCY");
    }

    // No tradable price at all → zero confidence.
    if (fairYesTilted === null) confidenceScore = 0;

    confidenceScore = Math.max(0, Math.min(1, confidenceScore));

    return {
      fairYesBase,
      fairNoBase,
      fairYesTilted,
      fairNoTilted,
      zScore,
      expectedMoveUsd,
      distanceToTarget,
      edgeYesGross,
      edgeNoGross,
      edgeYesNet,
      edgeNoNet,
      confidenceScore,
      reasonCodes,
    };
  } catch {
    return {
      fairYesBase: null,
      fairNoBase: null,
      fairYesTilted: null,
      fairNoTilted: null,
      zScore: null,
      expectedMoveUsd: null,
      distanceToTarget: null,
      edgeYesGross: null,
      edgeNoGross: null,
      edgeYesNet: null,
      edgeNoNet: null,
      confidenceScore: 0,
      reasonCodes: ["FAIR_INTERNAL_ERROR"],
    };
  }
}
