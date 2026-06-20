// Measured latency engine.
//
// Records per-stage latency samples and computes p50/p95/p99 over a rolling
// window. The snapshot decides whether the measured latency leaves enough room
// inside the time remaining before settlement to act safely. Fail-safe: any
// missing/degenerate input resolves to withinBudget=false with reason codes.

import type { Config } from "../config/load_config";
import type { MeasuredLatencySnapshot } from "../jupiter_prediction/models";

type LatencySnapshot = MeasuredLatencySnapshot;

export interface LatencySample {
  marketFetchMs?: number;
  orderbookFetchMs?: number;
  settlementIndexFetchMs?: number;
  btcContextFetchMs?: number;
  decisionMs?: number;
}

export interface LatencySnapshotInput {
  secondsLeft: number | null;
  totalDataAgeMs: number;
  config: Config;
}

const DEFAULT_MAX_SAMPLES = 256;

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/** Sum the per-stage latencies that are present in a sample (defensive). */
function sampleTotalMs(s: LatencySample): number {
  let total = 0;
  if (isFiniteNumber(s.marketFetchMs) && s.marketFetchMs >= 0) {
    total += s.marketFetchMs;
  }
  if (isFiniteNumber(s.orderbookFetchMs) && s.orderbookFetchMs >= 0) {
    total += s.orderbookFetchMs;
  }
  if (isFiniteNumber(s.settlementIndexFetchMs) && s.settlementIndexFetchMs >= 0) {
    total += s.settlementIndexFetchMs;
  }
  if (isFiniteNumber(s.btcContextFetchMs) && s.btcContextFetchMs >= 0) {
    total += s.btcContextFetchMs;
  }
  if (isFiniteNumber(s.decisionMs) && s.decisionMs >= 0) {
    total += s.decisionMs;
  }
  return total;
}

/**
 * Nearest-rank percentile over a sorted ascending array.
 * Returns 0 for empty input (caller treats no-data as a block separately).
 */
function percentile(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  if (n === 1) return sortedAsc[0];
  const clamped = Math.min(1, Math.max(0, p));
  // Nearest-rank: rank = ceil(p * n), 1-indexed.
  const rank = Math.max(1, Math.ceil(clamped * n));
  const idx = Math.min(n - 1, rank - 1);
  return sortedAsc[idx];
}

export class LatencyEngine {
  private readonly samples: number[] = [];
  private readonly maxSamples: number;

  constructor(maxSamples: number = DEFAULT_MAX_SAMPLES) {
    this.maxSamples =
      isFiniteNumber(maxSamples) && maxSamples > 0
        ? Math.floor(maxSamples)
        : DEFAULT_MAX_SAMPLES;
  }

  /** Record one combined-latency sample (sum of present stage timings). */
  record(sample: LatencySample): void {
    if (sample === null || typeof sample !== "object") return;
    const total = sampleTotalMs(sample);
    if (!isFiniteNumber(total) || total < 0) return;
    this.samples.push(total);
    // Rolling window: drop oldest beyond cap.
    while (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }
  }

  /** Number of retained samples. */
  size(): number {
    return this.samples.length;
  }

  /**
   * Produce a latency snapshot and budget verdict.
   * withinBudget is false (with reason codes) when:
   *   - no samples have been recorded (cannot reason about latency)
   *   - p95 > config.latency.maxAbsoluteMs
   *   - p95 > maxFractionOfTimeLeft * timeLeftMs
   *   - timeLeft < blockUnderSecondsLeft
   *   - timeLeft is unknown/non-positive
   */
  snapshot(input: LatencySnapshotInput): LatencySnapshot {
    const reasonCodes: string[] = [];
    const cfg = input?.config?.latency;

    const sorted = [...this.samples].sort((a, b) => a - b);
    const haveSamples = sorted.length > 0;

    const p50 = percentile(sorted, 0.5);
    const p95 = percentile(sorted, 0.95);
    const p99 = percentile(sorted, 0.99);

    const totalDataAgeMs =
      isFiniteNumber(input?.totalDataAgeMs) && input.totalDataAgeMs >= 0
        ? input.totalDataAgeMs
        : Number.POSITIVE_INFINITY;

    let withinBudget = true;

    // Defensive: if config is malformed, block.
    if (!cfg) {
      reasonCodes.push("LATENCY_CONFIG_MISSING");
      withinBudget = false;
    }

    if (!haveSamples) {
      reasonCodes.push("LATENCY_NO_SAMPLES");
      withinBudget = false;
    }

    // Time-left handling.
    const secondsLeft = input?.secondsLeft;
    const timeLeftKnown = isFiniteNumber(secondsLeft);
    if (!timeLeftKnown) {
      reasonCodes.push("TIME_LEFT_UNKNOWN");
      withinBudget = false;
    } else {
      const timeLeftMs = (secondsLeft as number) * 1000;

      if (cfg && (secondsLeft as number) < cfg.blockUnderSecondsLeft) {
        reasonCodes.push("LATENCY_TIME_LEFT_TOO_SHORT");
        withinBudget = false;
      }

      if (cfg && haveSamples && p95 > cfg.maxAbsoluteMs) {
        reasonCodes.push("LATENCY_P95_OVER_ABSOLUTE");
        withinBudget = false;
      }

      if (cfg && haveSamples) {
        const fractionalBudgetMs = cfg.maxFractionOfTimeLeft * timeLeftMs;
        if (timeLeftMs <= 0 || p95 > fractionalBudgetMs) {
          reasonCodes.push("LATENCY_P95_OVER_TIME_FRACTION");
          withinBudget = false;
        }
      }
    }

    if (!isFiniteNumber(totalDataAgeMs) || totalDataAgeMs === Number.POSITIVE_INFINITY) {
      reasonCodes.push("DATA_AGE_UNKNOWN");
      withinBudget = false;
    }

    return {
      totalDataAgeMs,
      p50,
      p95,
      p99,
      withinBudget,
      reasonCodes,
    };
  }
}
