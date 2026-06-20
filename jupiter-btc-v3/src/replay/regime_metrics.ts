// Regime bucketers for slicing replay/calibration results. Pure, total
// functions: every input (including null / NaN) maps to a stable string label so
// downstream group-by keys are never undefined.

import type { VolRegime } from "../jupiter_prediction/models";

function isFiniteNum(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/**
 * Bucket seconds-left into coarse, decision-relevant bands.
 * Negative/zero → EXPIRED. null/NaN → UNKNOWN.
 */
export function timeLeftBucket(s: number | null): string {
  if (s === null || !isFiniteNum(s)) return "UNKNOWN";
  if (s <= 0) return "EXPIRED";
  if (s < 30) return "0-30s";
  if (s < 60) return "30-60s";
  if (s < 120) return "60-120s";
  if (s < 300) return "120-300s";
  return "300s+";
}

/**
 * Bucket moneyness (z-score of index vs target) into symmetric bands.
 * null/NaN → UNKNOWN.
 */
export function moneynessBucket(z: number | null): string {
  if (z === null || !isFiniteNum(z)) return "UNKNOWN";
  const a = Math.abs(z);
  let mag: string;
  if (a < 0.25) mag = "ATM";
  else if (a < 0.5) mag = "0.25-0.5";
  else if (a < 1) mag = "0.5-1";
  else if (a < 2) mag = "1-2";
  else mag = "2+";
  if (mag === "ATM") return "ATM";
  return z >= 0 ? `+${mag}` : `-${mag}`;
}

/**
 * Bucket a VolRegime. Passes through known regimes; anything unexpected → UNKNOWN.
 */
export function volRegimeBucket(r: VolRegime): string {
  switch (r) {
    case "LOW_VOL":
    case "NORMAL_VOL":
    case "HIGH_VOL":
    case "JUMPY":
    case "DATA_STALE":
      return r;
    default:
      return "UNKNOWN";
  }
}

/**
 * Bucket basis (in bps) by magnitude. null/NaN → UNKNOWN.
 */
export function basisRegimeBucket(bps: number | null): string {
  if (bps === null || !isFiniteNum(bps)) return "UNKNOWN";
  const a = Math.abs(bps);
  let mag: string;
  if (a < 5) mag = "0-5bps";
  else if (a < 10) mag = "5-10bps";
  else if (a < 25) mag = "10-25bps";
  else if (a < 50) mag = "25-50bps";
  else mag = "50bps+";
  if (a < 5) return mag;
  return bps >= 0 ? `+${mag}` : `-${mag}`;
}
