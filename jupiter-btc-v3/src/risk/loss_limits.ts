// Daily loss tracker. Sums realized losses (negative pnl only) over a trailing
// 24h window and blocks when the configured daily loss cap is exceeded.
// Fail-safe: malformed inputs are ignored on record and treated conservatively.

import type { Config } from "../config/load_config";

interface PnlEntry {
  t: number; // epoch ms
  pnlUsd: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

export class LossTracker {
  private readonly entries: PnlEntry[] = [];

  /** Record a realized pnl (USD). Negative = loss. t defaults to now. */
  record(pnlUsd: number, t?: number): void {
    if (!isFiniteNumber(pnlUsd)) return;
    const ts = isFiniteNumber(t) ? (t as number) : Date.now();
    this.entries.push({ t: ts, pnlUsd });
  }

  /**
   * Total realized LOSS (as a positive USD number) in the trailing 24h.
   * Only negative pnl contributes; gains do not offset losses for the cap.
   */
  dailyLossUsd(nowMs?: number): number {
    const now = isFiniteNumber(nowMs) ? (nowMs as number) : Date.now();
    const cutoff = now - DAY_MS;
    let loss = 0;
    for (const e of this.entries) {
      if (e.t >= cutoff && e.t <= now && e.pnlUsd < 0) {
        loss += -e.pnlUsd;
      }
    }
    return loss;
  }

  /**
   * True when the trailing-24h loss meets or exceeds config.risk.maxDailyLossUsd.
   * Defensive: if the cap is missing/invalid, do NOT block on loss alone here
   * (the risk manager owns the final block decision) — return false so callers
   * can apply their own missing-config handling, but treat a zero/negative cap
   * as "any loss exceeds" to stay conservative.
   */
  exceeded(config: Config, nowMs?: number): boolean {
    const cap = config?.risk?.maxDailyLossUsd;
    const loss = this.dailyLossUsd(nowMs);
    if (!isFiniteNumber(cap)) return false;
    if (cap <= 0) return loss > 0;
    return loss >= cap;
  }
}
