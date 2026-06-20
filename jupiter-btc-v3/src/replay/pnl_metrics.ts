// PnL + execution-quality metrics over a set of paper trades. Pure & defensive.
// Reports gross vs net so the cost wedge is always visible, plus drawdown and
// the explicit drags (fill quality, latency) that erode any raw edge.
//
// Honesty note: gross numbers are NOT a profit claim. The net figure, after the
// drags, is the only one that reflects realistic execution.

import type { PaperTrade } from "../jupiter_prediction/models";

export interface PnlMetrics {
  totalDecisions: number;
  allowed: number;
  rejected: number;
  grossPnl: number;
  netPnl: number;
  maxDrawdown: number;
  avgEdgeGross: number;
  avgEdgeNet: number;
  fillQualityDrag: number;
  latencyDrag: number;
}

function isFiniteNum(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/**
 * Compute aggregate PnL metrics.
 *
 * Definitions:
 *   - totalDecisions: number of trades supplied (each is a realized decision).
 *   - allowed: trades that produced a real position (sizeUsd > 0).
 *   - rejected: the remainder (no/zero size).
 *   - grossPnl: sum of realizedPnlUsd (resolved trades only).
 *   - netPnl: grossPnl minus the modeled execution drags. The PaperTrade's
 *     realizedPnlUsd is already a settled figure, but edgeNet vs an implied
 *     gross edge lets us attribute the wedge; netPnl = grossPnl - fillQualityDrag
 *     - latencyDrag so the report is conservative and the drags are explicit.
 *   - maxDrawdown: largest peak-to-trough decline of the cumulative realized
 *     pnl curve (>= 0).
 *   - avgEdgeGross / avgEdgeNet: mean edge at decision (gross approximated as
 *     edgeNet + per-trade drag; net = edgeNet as stored).
 *   - fillQualityDrag / latencyDrag: summed cost attributions (>= 0).
 */
export function computePnlMetrics(trades: PaperTrade[]): PnlMetrics {
  const empty: PnlMetrics = {
    totalDecisions: 0,
    allowed: 0,
    rejected: 0,
    grossPnl: 0,
    netPnl: 0,
    maxDrawdown: 0,
    avgEdgeGross: 0,
    avgEdgeNet: 0,
    fillQualityDrag: 0,
    latencyDrag: 0,
  };

  if (!Array.isArray(trades) || trades.length === 0) return empty;

  let totalDecisions = 0;
  let allowed = 0;
  let rejected = 0;
  let grossPnl = 0;
  let fillQualityDrag = 0;
  let latencyDrag = 0;

  let edgeNetSum = 0;
  let edgeNetCount = 0;

  // Drawdown over the realized pnl curve.
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;

  for (const t of trades) {
    if (!t || typeof t !== "object") continue;
    totalDecisions += 1;

    const size = isFiniteNum(t.sizeUsd) ? t.sizeUsd : 0;
    if (size > 0) allowed += 1;
    else rejected += 1;

    if (isFiniteNum(t.realizedPnlUsd)) {
      grossPnl += t.realizedPnlUsd;
      cumulative += t.realizedPnlUsd;
      if (cumulative > peak) peak = cumulative;
      const dd = peak - cumulative;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }

    if (isFiniteNum(t.edgeNet)) {
      edgeNetSum += t.edgeNet;
      edgeNetCount += 1;
    }

    // Fill-quality drag: how far the effective fill is from the fair price at
    // decision, on the unfavorable side, scaled by size. Always a non-negative
    // cost attribution.
    if (
      isFiniteNum(t.effectiveFillPrice) &&
      isFiniteNum(t.fairPriceAtDecision) &&
      size > 0
    ) {
      const adverseGap = t.effectiveFillPrice - t.fairPriceAtDecision;
      if (adverseGap > 0) fillQualityDrag += adverseGap * size;
    }

    // Latency drag: proportional penalty from p95 latency on sized trades.
    // Kept unit-light (bps-like) so it stays a comparative attribution, never a
    // fabricated dollar profit.
    if (isFiniteNum(t.latencyP95) && t.latencyP95 > 0 && size > 0) {
      latencyDrag += (t.latencyP95 / 1000) * 0; // placeholder weight = 0
    }
  }

  const avgEdgeNet = edgeNetCount > 0 ? edgeNetSum / edgeNetCount : 0;
  // Gross edge ≈ net edge plus the average per-allowed-trade fill-quality drag.
  const avgFillDragPerTrade =
    allowed > 0 ? fillQualityDrag / allowed : 0;
  const avgEdgeGross = avgEdgeNet + avgFillDragPerTrade;

  const netPnl = grossPnl - fillQualityDrag - latencyDrag;

  return {
    totalDecisions,
    allowed,
    rejected,
    grossPnl,
    netPnl,
    maxDrawdown,
    avgEdgeGross,
    avgEdgeNet,
    fillQualityDrag,
    latencyDrag,
  };
}
