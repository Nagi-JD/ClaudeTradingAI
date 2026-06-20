// Binary market pricer. Prices a YES/NO outcome as the probability the
// settlement index ends ABOVE the target, using a normal terminal-move model.
//
// Model: z = (settlementIndexPrice - targetPrice) / expectedMoveUsd
//        fairYesBase = Φ(z)   (probability index ends above target)
//
// Sign convention sanity check (the contractual invariants):
//   - target == spot  → z = 0   → Φ(0)  = 0.50
//   - spot = target + 1σ (index ABOVE target by 1 move) → z = +1 → Φ(+1) ≈ 0.84
//   - spot = target - 1σ → z = -1 → Φ(-1) ≈ 0.16
// The INTERFACES test phrasing ("+1σ → YES~0.16") describes moving the TARGET
// up by 1σ relative to spot, i.e. spot below target → z = -1 → 0.16. Both are
// the same monotonic curve; this implementation uses z = (spot - target)/move.
//
// Never throws. Missing/invalid inputs → nulls + reasonCodes.

import type { VolSnapshot } from "../jupiter_prediction/models";
import type { Config } from "../config/load_config";
import { normalCdf } from "./normal_cdf";

export interface BinaryPriceResult {
  fairYesBase: number | null;
  fairNoBase: number | null;
  zScore: number | null;
  expectedMoveUsd: number | null;
  distanceToTarget: number | null;
  reasonCodes: string[];
}

interface BinaryInput {
  settlementIndexPrice: number | null;
  targetPrice: number | null;
  secondsLeft: number;
  volSnapshot: VolSnapshot;
  config: Config;
  /**
   * Research/proxy mode: still COMPUTE a base price when vol confidence is below
   * the trust floor (the low confidence then propagates to the fair-value score
   * and keeps the trade blocked downstream). Lets us MEASURE the pricing edge in
   * low-confidence regimes instead of nulling it out. Default false (unchanged).
   */
  relaxVolConfidenceGate?: boolean;
}

// Below this volConfidence we refuse to price (cannot trust σ).
const MIN_VOL_CONFIDENCE = 0.2;

function nullResult(reasonCodes: string[], expectedMoveUsd: number | null, distanceToTarget: number | null): BinaryPriceResult {
  return {
    fairYesBase: null,
    fairNoBase: null,
    zScore: null,
    expectedMoveUsd,
    distanceToTarget,
    reasonCodes,
  };
}

export function priceBinaryMarket(input: BinaryInput): BinaryPriceResult {
  try {
    const { config, volSnapshot } = input;
    const reasonCodes: string[] = [];

    const spot = input.settlementIndexPrice;
    const target = input.targetPrice;
    const secondsLeft = input.secondsLeft;
    const expectedMoveUsd = volSnapshot?.expectedMoveUsd ?? null;

    // Time gate.
    if (!Number.isFinite(secondsLeft) || secondsLeft <= 0) {
      reasonCodes.push("BINARY_NO_TIME_LEFT");
      return nullResult(reasonCodes, expectedMoveUsd, null);
    }

    // Input presence gates.
    if (spot === null || spot === undefined || !Number.isFinite(spot)) {
      reasonCodes.push("BINARY_INDEX_PRICE_MISSING");
      return nullResult(reasonCodes, expectedMoveUsd, null);
    }
    if (target === null || target === undefined || !Number.isFinite(target)) {
      reasonCodes.push("BINARY_TARGET_MISSING");
      return nullResult(reasonCodes, expectedMoveUsd, null);
    }

    const distanceToTarget = spot - target;

    // Vol confidence gate. Below the trust floor we normally refuse to price
    // (cannot trust σ). In research/proxy mode we instead flag it and proceed —
    // the low confidence propagates downstream and keeps the trade blocked, but
    // we still get a measurable fair value.
    const volConfidence = Number.isFinite(volSnapshot?.volConfidence) ? volSnapshot.volConfidence : 0;
    if (volConfidence < MIN_VOL_CONFIDENCE) {
      reasonCodes.push("BINARY_VOL_LOW_CONFIDENCE");
      if (!input.relaxVolConfidenceGate) {
        return nullResult(reasonCodes, expectedMoveUsd, distanceToTarget);
      }
    }

    // Expected move gate.
    if (expectedMoveUsd === null || !Number.isFinite(expectedMoveUsd) || expectedMoveUsd <= 0) {
      reasonCodes.push("BINARY_EXPECTED_MOVE_MISSING");
      return nullResult(reasonCodes, expectedMoveUsd, distanceToTarget);
    }
    const minMove = Number.isFinite(config.binaryPricing.minExpectedMoveUsd)
      ? config.binaryPricing.minExpectedMoveUsd
      : 1;
    if (expectedMoveUsd < minMove) {
      reasonCodes.push("BINARY_EXPECTED_MOVE_TOO_SMALL");
      return nullResult(reasonCodes, expectedMoveUsd, distanceToTarget);
    }

    // Core pricing.
    const zScore = distanceToTarget / expectedMoveUsd;
    if (!Number.isFinite(zScore)) {
      reasonCodes.push("BINARY_ZSCORE_INVALID");
      return nullResult(reasonCodes, expectedMoveUsd, distanceToTarget);
    }

    const rawYes = normalCdf(zScore);

    const clampMin = Number.isFinite(config.binaryPricing.clampMin) ? config.binaryPricing.clampMin : 0.01;
    const clampMax = Number.isFinite(config.binaryPricing.clampMax) ? config.binaryPricing.clampMax : 0.99;
    const lo = Math.min(clampMin, clampMax);
    const hi = Math.max(clampMin, clampMax);

    const fairYesBase = Math.max(lo, Math.min(hi, rawYes));
    const fairNoBase = Math.max(lo, Math.min(hi, 1 - rawYes));

    if (rawYes <= clampMin || rawYes >= clampMax) {
      reasonCodes.push("BINARY_PRICE_CLAMPED");
    }

    return {
      fairYesBase,
      fairNoBase,
      zScore,
      expectedMoveUsd,
      distanceToTarget,
      reasonCodes,
    };
  } catch {
    return nullResult(["BINARY_INTERNAL_ERROR"], null, null);
  }
}
