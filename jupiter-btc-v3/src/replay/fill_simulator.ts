// Pessimistic fill simulator for replay. Re-prices a saved orderbook walk under
// the assumption that we are the marginal, adversely-selected taker: we NEVER
// fill at mid, we use the worst (or avg-biased-toward-worst) fill price, we
// allow partial fills, and we flag adverse selection. This biases reported PnL
// DOWN — the honest direction for a research backtest.

import type { Config } from "../config/load_config";
import type { OrderbookWalkResult, VolRegime } from "../jupiter_prediction/models";

export interface FillSimInput {
  walk: OrderbookWalkResult;
  side: "YES" | "NO";
  sizeUsd: number;
  volRegime: VolRegime;
  config: Config;
}

export interface FillSimResult {
  filled: boolean;
  fillPrice: number | null;
  filledSizeUsd: number;
  adverse: boolean;
  reasonCodes: string[];
}

function isFiniteNum(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/**
 * Simulate a pessimistic fill.
 *
 * Price selection (worst-biased, never mid):
 *   - Prefer walk.worstFillPrice (the most adverse level touched).
 *   - If worstFillPrice missing, fall back to avgFillPrice (still never mid).
 *   - If neither is available → no fill.
 *
 * Sizing (partial allowed):
 *   - Filled size = min(requested sizeUsd, walk.availableSizeUsd), further
 *     scaled by walk.fillRatio when it is below 1 (depth was insufficient).
 *
 * Adverse selection:
 *   - Flagged when liquidity is thin (fillRatio < minFillRatio), when slippage
 *     exceeds the configured walk cap, or under elevated volatility regimes
 *     (HIGH_VOL / JUMPY / DATA_STALE) where our quote is likely picked off.
 */
export function simulateFill(input: FillSimInput): FillSimResult {
  const reasonCodes: string[] = [];

  if (!input || typeof input !== "object" || !input.walk) {
    return {
      filled: false,
      fillPrice: null,
      filledSizeUsd: 0,
      adverse: true,
      reasonCodes: ["NO_WALK"],
    };
  }

  const { walk, side, sizeUsd, volRegime, config } = input;

  if (side !== "YES" && side !== "NO") {
    return {
      filled: false,
      fillPrice: null,
      filledSizeUsd: 0,
      adverse: true,
      reasonCodes: ["INVALID_SIDE"],
    };
  }

  const requested = isFiniteNum(sizeUsd) && sizeUsd > 0 ? sizeUsd : 0;
  if (requested <= 0) {
    return {
      filled: false,
      fillPrice: null,
      filledSizeUsd: 0,
      adverse: true,
      reasonCodes: ["ZERO_SIZE"],
    };
  }

  // ── Pessimistic price: worst first, avg fallback, NEVER mid ───────────────
  let fillPrice: number | null = null;
  if (isFiniteNum(walk.worstFillPrice)) {
    fillPrice = walk.worstFillPrice;
  } else if (isFiniteNum(walk.avgFillPrice)) {
    fillPrice = walk.avgFillPrice;
    reasonCodes.push("WORST_PRICE_MISSING_USED_AVG");
  }

  if (fillPrice === null) {
    return {
      filled: false,
      fillPrice: null,
      filledSizeUsd: 0,
      adverse: true,
      reasonCodes: ["NO_FILL_PRICE"],
    };
  }

  // ── Available depth + partial fill ────────────────────────────────────────
  const available = isFiniteNum(walk.availableSizeUsd)
    ? Math.max(0, walk.availableSizeUsd)
    : 0;
  let filledSizeUsd = Math.min(requested, available);

  // fillRatio < 1 means the walk could not source full requested depth; scale
  // the fill further down so we never over-credit liquidity.
  const fillRatio = isFiniteNum(walk.fillRatio) ? walk.fillRatio : 0;
  if (fillRatio > 0 && fillRatio < 1) {
    filledSizeUsd = Math.min(filledSizeUsd, requested * fillRatio);
  }

  if (filledSizeUsd <= 0) {
    return {
      filled: false,
      fillPrice,
      filledSizeUsd: 0,
      adverse: true,
      reasonCodes: [...reasonCodes, "NO_DEPTH"],
    };
  }

  const partial = filledSizeUsd + 1e-9 < requested;
  if (partial) reasonCodes.push("PARTIAL_FILL");

  // ── Adverse selection flag ────────────────────────────────────────────────
  let adverse = false;

  const minFillRatio =
    config?.orderbook && isFiniteNum(config.orderbook.minFillRatio)
      ? config.orderbook.minFillRatio
      : 0;
  if (fillRatio < minFillRatio) {
    adverse = true;
    reasonCodes.push("ADVERSE_THIN_LIQUIDITY");
  }

  const maxWalkSlippage =
    config?.orderbook && isFiniteNum(config.orderbook.maxWalkSlippage)
      ? config.orderbook.maxWalkSlippage
      : Number.POSITIVE_INFINITY;
  if (isFiniteNum(walk.slippage) && walk.slippage > maxWalkSlippage) {
    adverse = true;
    reasonCodes.push("ADVERSE_HIGH_SLIPPAGE");
  }

  if (
    volRegime === "HIGH_VOL" ||
    volRegime === "JUMPY" ||
    volRegime === "DATA_STALE"
  ) {
    adverse = true;
    reasonCodes.push(`ADVERSE_VOL_REGIME_${volRegime}`);
  }

  // Surface poor fill quality from the underlying walk if present.
  if (Array.isArray(walk.reasonCodes) && walk.reasonCodes.includes("FILL_QUALITY_POOR")) {
    reasonCodes.push("FILL_QUALITY_POOR");
  }

  return {
    filled: true,
    fillPrice,
    filledSizeUsd,
    adverse,
    reasonCodes,
  };
}
