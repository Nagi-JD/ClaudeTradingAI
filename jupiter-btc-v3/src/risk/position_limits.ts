// Position size limits. Fail-safe: any non-positive, non-finite, or
// over-cap size is rejected with explicit reason codes.

import type { Config } from "../config/load_config";

export interface PositionLimitResult {
  ok: boolean;
  blockedBy: string[];
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/**
 * Validate a proposed position size in USD against config caps.
 * - size must be a finite, strictly positive number
 * - size must not exceed config.risk.maxPositionUsd
 */
export function checkPositionLimit(
  sizeUsd: number,
  config: Config,
): PositionLimitResult {
  const blockedBy: string[] = [];

  if (!isFiniteNumber(sizeUsd)) {
    blockedBy.push("POSITION_SIZE_INVALID");
    return { ok: false, blockedBy };
  }

  if (sizeUsd <= 0) {
    blockedBy.push("POSITION_SIZE_NON_POSITIVE");
  }

  const cap = config?.risk?.maxPositionUsd;
  if (!isFiniteNumber(cap) || cap <= 0) {
    // Without a valid cap we cannot certify the size as safe.
    blockedBy.push("POSITION_LIMIT_CONFIG_MISSING");
  } else if (isFiniteNumber(sizeUsd) && sizeUsd > cap) {
    blockedBy.push("POSITION_SIZE_OVER_CAP");
  }

  return { ok: blockedBy.length === 0, blockedBy };
}
