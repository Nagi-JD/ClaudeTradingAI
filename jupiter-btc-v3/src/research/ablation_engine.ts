// Ablation engine: does adding microstructure tilts actually help out-of-sample?
// Groups RESOLVED paper trades by ablation variant and reports, per variant:
//   n        — resolved sample size
//   brier    — calibration of the predicted fair price vs realized outcome
//   avgEdgeNet — mean post-cost edge claimed at decision time
//   netPnl   — realized net pnl summed across resolved trades
//
// shouldDisableTilt() is the honesty gate: the full-tilt variant must beat the
// baseline on ALL THREE of {brier (lower), CLV-style edge, netPnl}. If it does
// not strictly improve every axis, tilts are recommended OFF. We never assume
// tilts help; the burden of proof is on them.

import type { AblationVariant, PaperTrade } from "../jupiter_prediction/models";
import { brierScore, type ProbSample } from "./reliability_metrics";

const ABLATION_VARIANTS: AblationVariant[] = [
  "base_only",
  "base_plus_cvd",
  "base_plus_liquidations",
  "base_plus_momentum",
  "base_plus_all",
];

export interface VariantStats {
  n: number;
  brier: number | null;
  avgEdgeNet: number;
  netPnl: number;
}

export type AblationReport = Record<AblationVariant, VariantStats>;

function isFiniteNum(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/** A resolved trade has a concrete YES/NO/VOID outcome. VOID is excluded from
 *  the brier sample (no informative 0/1 label) but its pnl (≈0) still counts. */
function outcomeToLabel(
  outcome: PaperTrade["outcome"],
  side: "YES" | "NO",
): 0 | 1 | null {
  if (outcome !== "YES" && outcome !== "NO") return null;
  // The predicted probability is for the side actually taken. Label is 1 if the
  // taken side won, else 0.
  if (side === "YES") return outcome === "YES" ? 1 : 0;
  return outcome === "NO" ? 1 : 0;
}

function emptyReport(): AblationReport {
  const out = {} as AblationReport;
  for (const v of ABLATION_VARIANTS) {
    out[v] = { n: 0, brier: null, avgEdgeNet: 0, netPnl: 0 };
  }
  return out;
}

/**
 * Group RESOLVED trades by variant and compute stats. Only trades with a
 * non-null outcome are considered resolved. brier is null when a variant has no
 * trade carrying both a usable probability (fairPriceAtDecision) and a 0/1
 * label (VOID-only or unresolved variants → null brier).
 */
export function compareVariants(trades: PaperTrade[]): AblationReport {
  const report = emptyReport();
  if (!Array.isArray(trades)) return report;

  const samplesByVariant: Record<string, ProbSample[]> = {};
  const edgeSumByVariant: Record<string, number> = {};
  const edgeCountByVariant: Record<string, number> = {};
  for (const v of ABLATION_VARIANTS) {
    samplesByVariant[v] = [];
    edgeSumByVariant[v] = 0;
    edgeCountByVariant[v] = 0;
  }

  for (const t of trades) {
    if (!t || typeof t !== "object") continue;
    const variant = t.variant;
    if (!ABLATION_VARIANTS.includes(variant)) continue;

    // Only resolved trades participate.
    const outcome = t.outcome;
    if (outcome === undefined || outcome === null) continue;

    report[variant].n += 1;

    if (isFiniteNum(t.realizedPnlUsd)) {
      report[variant].netPnl += t.realizedPnlUsd;
    }

    if (isFiniteNum(t.edgeNet)) {
      edgeSumByVariant[variant] += t.edgeNet;
      edgeCountByVariant[variant] += 1;
    }

    const label = outcomeToLabel(outcome, t.side);
    if (label !== null && isFiniteNum(t.fairPriceAtDecision)) {
      samplesByVariant[variant].push({
        p: t.fairPriceAtDecision,
        outcome: label,
      });
    }
  }

  for (const v of ABLATION_VARIANTS) {
    const ec = edgeCountByVariant[v];
    report[v].avgEdgeNet = ec > 0 ? edgeSumByVariant[v] / ec : 0;
    report[v].brier =
      samplesByVariant[v].length > 0 ? brierScore(samplesByVariant[v]) : null;
  }

  return report;
}

export interface DisableTiltDecision {
  disable: boolean;
  reason: string;
}

/**
 * Decide whether tilts should be disabled. Tilts (base_plus_all) must STRICTLY
 * improve over base_only on ALL of:
 *   - brier (lower is better)
 *   - average net edge (proxy for CLV/edge improvement)
 *   - net pnl (higher is better)
 * If the full-tilt variant fails to improve any one axis — or lacks the data to
 * prove improvement — disable is recommended. Fail-safe: insufficient data →
 * disable=true (do not deploy unproven tilts).
 */
export function shouldDisableTilt(
  report: AblationReport,
): DisableTiltDecision {
  const base = report?.base_only;
  const all = report?.base_plus_all;

  if (!base || !all) {
    return {
      disable: true,
      reason: "Missing base_only or base_plus_all variant stats.",
    };
  }

  if (base.n === 0 || all.n === 0) {
    return {
      disable: true,
      reason:
        "Insufficient resolved trades to compare tilts vs baseline; tilts unproven.",
    };
  }

  // Brier: both must exist to compare. Lower is better → improvement requires
  // all.brier < base.brier. Missing brier on either side → cannot prove → fail.
  const haveBrier = base.brier !== null && all.brier !== null;
  const brierImproved = haveBrier && (all.brier as number) < (base.brier as number);

  const edgeImproved = all.avgEdgeNet > base.avgEdgeNet;
  const pnlImproved = all.netPnl > base.netPnl;

  if (!haveBrier) {
    return {
      disable: true,
      reason:
        "Cannot compare Brier (missing calibration sample on baseline or full-tilt); tilts unproven.",
    };
  }

  if (brierImproved && edgeImproved && pnlImproved) {
    return {
      disable: false,
      reason:
        "base_plus_all strictly improves Brier, net edge, and net PnL vs base_only.",
    };
  }

  const failures: string[] = [];
  if (!brierImproved) failures.push("Brier not improved");
  if (!edgeImproved) failures.push("net edge not improved");
  if (!pnlImproved) failures.push("net PnL not improved");

  return {
    disable: true,
    reason: `Tilts do not improve out-of-sample on all axes (${failures.join(
      "; ",
    )}).`,
  };
}
