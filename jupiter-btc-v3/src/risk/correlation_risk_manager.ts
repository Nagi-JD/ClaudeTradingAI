// Correlation risk manager.
//
// Overlapping BTC 5-minute markets that share the same settlement window,
// target price band, and trade direction are NOT independent bets — they are
// effectively the same position taken multiple times. This manager buckets
// markets into ExposureGroupKeys and caps aggregate exposure per group.

import type { Config } from "../config/load_config";
import type {
  ExposureGroupKey,
  NormalizedMarketSnapshot,
  SettlementSpec,
} from "../jupiter_prediction/models";

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/** Parse an ISO timestamp into epoch ms, or null if unparseable. */
function toEpochMs(iso?: string): number | null {
  if (typeof iso !== "string" || iso.length === 0) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export class CorrelationRiskManager {
  // keyString -> accumulated exposure USD
  private readonly exposure = new Map<string, number>();

  /**
   * Build the exposure grouping key for a (market, settlement, side) tuple.
   * - windowBucket: close-time bucketed by overlapWindowSeconds. Two markets
   *   closing within the same window are correlated in time.
   * - targetBucket: target price bucketed into coarse bins so near-identical
   *   targets collapse to the same bin.
   */
  groupKey(
    market: NormalizedMarketSnapshot,
    settlement: SettlementSpec,
    side: "YES" | "NO",
    config: Config,
  ): ExposureGroupKey {
    const provider = market?.provider ?? settlement?.provider ?? "unknown";
    const settlementIndexName = settlement?.settlementIndexName ?? null;

    // ── window bucket ───────────────────────────────────────────────────────
    const windowSecRaw = config?.correlation?.overlapWindowSeconds;
    const windowSec =
      isFiniteNumber(windowSecRaw) && windowSecRaw > 0 ? windowSecRaw : 300;
    const windowMs = windowSec * 1000;

    const closeMs =
      toEpochMs(settlement?.closeTime) ?? toEpochMs(market?.closeTime);
    let windowBucket: string;
    if (closeMs === null) {
      windowBucket = "w:unknown";
    } else {
      windowBucket = `w:${Math.floor(closeMs / windowMs)}`;
    }

    // ── target bucket ───────────────────────────────────────────────────────
    const target = isFiniteNumber(settlement?.targetPrice)
      ? (settlement.targetPrice as number)
      : null;
    let targetBucket: string;
    if (!isFiniteNumber(target)) {
      targetBucket = "t:unknown";
    } else {
      // Coarse bins. For BTC-scale targets a $50 bin collapses near-identical
      // strikes while keeping clearly different strikes distinct. Use a
      // relative bin so the scheme is robust across price magnitudes.
      const binSize = Math.max(1, Math.abs(target as number) * 0.0005); // ~5bps
      targetBucket = `t:${Math.round((target as number) / binSize)}`;
    }

    return {
      asset: "BTC",
      provider,
      settlementIndexName,
      windowBucket,
      targetBucket,
      direction: side,
    };
  }

  /** Stable string identity for a group key (used as the map key). */
  keyString(k: ExposureGroupKey): string {
    if (!k) return "invalid";
    return [
      k.asset,
      k.provider,
      k.settlementIndexName ?? "null",
      k.windowBucket,
      k.targetBucket,
      k.direction,
    ].join("|");
  }

  /** Current accumulated exposure (USD) for a group. */
  currentExposureUsd(k: ExposureGroupKey): number {
    const cur = this.exposure.get(this.keyString(k));
    return isFiniteNumber(cur) ? cur : 0;
  }

  /**
   * Would adding addUsd to this group exceed the configured correlated cap?
   * Defensive: invalid addUsd or missing/invalid cap → treat as exceeded.
   */
  wouldExceed(k: ExposureGroupKey, addUsd: number, config: Config): boolean {
    if (!isFiniteNumber(addUsd) || addUsd < 0) return true;
    const cap = config?.correlation?.maxCorrelatedExposureUsd;
    if (!isFiniteNumber(cap) || cap < 0) return true;
    const next = this.currentExposureUsd(k) + addUsd;
    return next > cap;
  }

  /**
   * Remaining headroom (USD) before the correlated cap for this group.
   * Returns 0 when config is invalid (no headroom = conservative).
   */
  remainingHeadroomUsd(k: ExposureGroupKey, config: Config): number {
    const cap = config?.correlation?.maxCorrelatedExposureUsd;
    if (!isFiniteNumber(cap) || cap < 0) return 0;
    return Math.max(0, cap - this.currentExposureUsd(k));
  }

  /** Add realized/intended exposure to a group. Ignores invalid amounts. */
  addExposure(k: ExposureGroupKey, usd: number): void {
    if (!isFiniteNumber(usd) || usd <= 0) return;
    const key = this.keyString(k);
    const cur = this.exposure.get(key);
    this.exposure.set(key, (isFiniteNumber(cur) ? cur : 0) + usd);
  }
}
