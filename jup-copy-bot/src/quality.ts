import type { ProfileStats } from "./types.js";

export interface QualityCfg {
  minPredictions: number;
  minWinRatePct: number;
  requirePositiveAllTime: boolean;
}

export interface Judgement {
  verified: boolean;
  winRatePct: number;
  predictions: number;
  verdict: string;
}

/**
 * Judge a wallet on POST-RESOLUTION data only (settled markets):
 * realized all-time P&L + win rate over a meaningful sample.
 * This separates skill from a single lucky week.
 */
export function judge(stats: ProfileStats, cfg: QualityCfg): Judgement {
  const predictions = stats.correct + stats.wrong;
  const winRatePct = predictions > 0 ? (100 * stats.correct) / predictions : 0;

  const bigEnough = predictions >= cfg.minPredictions;
  const winsEnough = winRatePct >= cfg.minWinRatePct;
  const profitable = !cfg.requirePositiveAllTime || stats.allTimePnlUsd > 0;
  const verified = bigEnough && winsEnough && profitable;

  let verdict: string;
  if (predictions === 0) {
    verdict = "❔ no resolved history — cannot judge";
  } else if (verified) {
    verdict = `✅ skilled — ${winRatePct.toFixed(0)}% over ${predictions}, all-time $${stats.allTimePnlUsd.toFixed(0)}`;
  } else if (!profitable) {
    verdict = `🚩 net loser all-time ($${stats.allTimePnlUsd.toFixed(0)}) — lucky week`;
  } else if (!bigEnough) {
    verdict = `⚠️ small sample (${predictions}) — unproven`;
  } else {
    verdict = `⚠️ weak edge — ${winRatePct.toFixed(0)}% win over ${predictions}`;
  }

  return { verified, winRatePct, predictions, verdict };
}
