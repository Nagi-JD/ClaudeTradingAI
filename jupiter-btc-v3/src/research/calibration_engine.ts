// Calibration engine: the top-level honesty report. Aggregates Brier, log loss,
// the reliability curve, per-variant ablation, and the forecast σ error. It is
// deliberately conservative: it flags small samples, never claims profitability,
// and returns nulls where the data cannot support a metric.

import type { Config } from "../config/load_config";
import type { PaperTrade } from "../jupiter_prediction/models";
import {
  brierScore,
  logLoss,
  reliabilityCurve,
  type ProbSample,
  type ReliabilityBucket,
} from "./reliability_metrics";
import { compareVariants, type AblationReport } from "./ablation_engine";

export interface CalibrationReport {
  brier: number | null;
  logLoss: number | null;
  reliability: ReliabilityBucket[];
  nResolved: number;
  byVariant: AblationReport;
  sigmaForecastError: number | null;
  notes: string[];
}

function isFiniteNum(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/** Build the predicted-prob / 0-1-label sample over resolved (YES/NO) trades. */
function buildSamples(trades: PaperTrade[]): ProbSample[] {
  const out: ProbSample[] = [];
  for (const t of trades) {
    if (!t || typeof t !== "object") continue;
    const outcome = t.outcome;
    if (outcome !== "YES" && outcome !== "NO") continue; // VOID/unresolved skip
    if (!isFiniteNum(t.fairPriceAtDecision)) continue;
    const won = t.side === outcome;
    out.push({ p: t.fairPriceAtDecision, outcome: won ? 1 : 0 });
  }
  return out;
}

/**
 * Mean absolute forecast error of the predicted move vs the realized move,
 * where both are available. We use settlementIndexPrice vs targetPrice as the
 * realized signed distance and treat the predicted move proxy as unavailable on
 * PaperTrade (no stored expectedMove field), so this is computed only when a
 * trade carries enough fields. If no trade provides a usable pair → null.
 *
 * Conservative: returns null rather than a fabricated 0 when unmeasurable.
 */
function computeSigmaForecastError(trades: PaperTrade[]): number | null {
  let sum = 0;
  let n = 0;
  for (const t of trades) {
    if (!t || typeof t !== "object") continue;
    // Realized move = |settlementIndex - target|. Predicted move proxy is the
    // implied distance from the fair price; absent a stored expectedMoveUsd on
    // PaperTrade, we can only measure realized magnitude when both endpoints
    // exist. Where a predicted move is not recoverable, the trade is skipped.
    if (!isFiniteNum(t.settlementIndexPrice) || !isFiniteNum(t.targetPrice)) {
      continue;
    }
    // Forecast error here is the realized signed distance magnitude; absent a
    // stored prediction we cannot subtract, so we skip unless a future schema
    // carries the prediction. This keeps the metric honest (null when absent).
    n += 0;
    sum += 0;
  }
  return n > 0 ? sum / n : null;
}

/**
 * Build the full calibration report. `config.calibration.minOutOfSampleTrades`
 * gates the small-sample warning; `config.calibration.brierBuckets` sets the
 * reliability resolution. Never throws.
 */
export function buildCalibrationReport(
  trades: PaperTrade[],
  config: Config,
): CalibrationReport {
  const safeTrades = Array.isArray(trades) ? trades : [];
  const notes: string[] = [];

  const buckets =
    config?.calibration?.brierBuckets &&
    Number.isFinite(config.calibration.brierBuckets) &&
    config.calibration.brierBuckets >= 1
      ? Math.floor(config.calibration.brierBuckets)
      : 10;

  const minOoS =
    config?.calibration?.minOutOfSampleTrades &&
    Number.isFinite(config.calibration.minOutOfSampleTrades)
      ? config.calibration.minOutOfSampleTrades
      : 0;

  const samples = buildSamples(safeTrades);
  const nResolved = samples.length;

  const brier = nResolved > 0 ? brierScore(samples) : null;
  const ll = nResolved > 0 ? logLoss(samples) : null;
  const reliability = reliabilityCurve(samples, buckets);
  const byVariant = compareVariants(safeTrades);
  const sigmaForecastError = computeSigmaForecastError(safeTrades);

  // ── Honesty notes ──────────────────────────────────────────────────────
  if (nResolved === 0) {
    notes.push(
      "No resolved trades with a valid predicted probability; calibration is not measurable.",
    );
  }
  if (nResolved > 0 && nResolved < minOoS) {
    notes.push(
      `Small sample: ${nResolved} resolved trade(s) < minOutOfSampleTrades (${minOoS}). ` +
        "Calibration metrics are statistically unreliable; do not act on them.",
    );
  }
  if (sigmaForecastError === null) {
    notes.push(
      "sigmaForecastError unavailable: trades do not carry a recoverable predicted-vs-realized move pair.",
    );
  }

  // Never claim an edge. State plainly that this report does not assert one.
  notes.push(
    "This report measures calibration and relative variant behavior only. " +
      "It does NOT establish that the strategy is profitable after costs.",
  );

  return {
    brier,
    logLoss: ll,
    reliability,
    nResolved,
    byVariant,
    sigmaForecastError,
    notes,
  };
}
