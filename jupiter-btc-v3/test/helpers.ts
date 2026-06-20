// Shared test helpers: minimal valid model constructors matching the REAL types
// from src/jupiter_prediction/models. Kept deterministic.

import { loadConfig } from "../src/config/load_config";
import type {
  BasisSnapshot,
  BtcContextSnapshot,
  FairValueResult,
  MeasuredLatencySnapshot,
  NormalizedMarketSnapshot,
  OrderbookWalkResult,
  SettlementIndexSnapshot,
  SettlementSpec,
  VolSnapshot,
} from "../src/jupiter_prediction/models";

export function getConfig() {
  return loadConfig().config;
}

/** A VolSnapshot with an exact, known expectedMoveUsd so z is deterministic. */
export function volWithMove(expectedMoveUsd: number): VolSnapshot {
  return {
    rv1m: 0.0001,
    ewmaVol: 0.0001,
    jumpAdjustedVol: 0.0001,
    regime: "NORMAL_VOL",
    expectedMoveUsd,
    volConfidence: 1,
    reasonCodes: [],
  };
}

export function healthyMarket(
  over: Partial<NormalizedMarketSnapshot> = {},
): NormalizedMarketSnapshot {
  const now = Date.now();
  const closeMs = now + 90_000; // 90s left -> within [20,180]
  return {
    timestamp: new Date(now).toISOString(),
    provider: "polymarket",
    eventId: "evt-1",
    marketId: "mkt-1",
    eventTitle: "Bitcoin above $68,000?",
    marketTitle: "Will BTC settle above $68,000 on Coinbase?",
    category: "crypto",
    status: "active",
    isActive: true,
    isLive: true,
    closeTime: new Date(closeMs).toISOString(),
    timeLeftSeconds: 90,
    buyYesPriceUsd: 0.5,
    buyNoPriceUsd: 0.5,
    rawPayload: { provider: "polymarket" },
    ...over,
  };
}

export function healthySettlement(
  over: Partial<SettlementSpec> = {},
): SettlementSpec {
  return {
    provider: "polymarket",
    marketId: "mkt-1",
    eventId: "evt-1",
    marketType: "ABOVE_BELOW",
    ruleConfidence: 0.95,
    settlementIndexName: "Coinbase",
    targetPrice: 68_000,
    closeTime: new Date(Date.now() + 90_000).toISOString(),
    settlementMechanic: "POINT_IN_TIME",
    canTrade: true,
    blockedBy: [],
    rawRules: {},
    ...over,
  };
}

export function healthyIndex(
  over: Partial<SettlementIndexSnapshot> = {},
): SettlementIndexSnapshot {
  return {
    provider: "polymarket",
    marketId: "mkt-1",
    indexName: "Coinbase",
    indexPrice: 68_000,
    timestamp: new Date().toISOString(),
    dataAgeMs: 200,
    confidence: 0.9,
    ...over,
  };
}

export function healthyBasis(over: Partial<BasisSnapshot> = {}): BasisSnapshot {
  return {
    settlementIndexPrice: 68_000,
    cexReferencePrice: 68_000,
    basisUsd: 0,
    basisBps: 0,
    basisVolatilityBps: 0,
    isStable: true,
    reasonCodes: [],
    ...over,
  };
}

export function healthyLatency(
  over: Partial<MeasuredLatencySnapshot> = {},
): MeasuredLatencySnapshot {
  return {
    totalDataAgeMs: 300,
    p50: 100,
    p95: 200,
    p99: 250,
    withinBudget: true,
    reasonCodes: [],
    ...over,
  };
}

export function healthyFairValue(
  over: Partial<FairValueResult> = {},
): FairValueResult {
  return {
    fairYesBase: 0.6,
    fairNoBase: 0.4,
    fairYesTilted: 0.6,
    fairNoTilted: 0.4,
    zScore: 0.25,
    expectedMoveUsd: 400,
    distanceToTarget: 100,
    edgeYesGross: 0.12,
    edgeNoGross: -0.1,
    edgeYesNet: 0.1,
    edgeNoNet: -0.1,
    confidenceScore: 0.9,
    reasonCodes: [],
    ...over,
  };
}

export function healthyWalk(
  side: "YES" | "NO" = "YES",
  over: Partial<OrderbookWalkResult> = {},
): OrderbookWalkResult {
  return {
    side,
    requestedSizeUsd: 5,
    avgFillPrice: 0.5,
    worstFillPrice: 0.51,
    availableSizeUsd: 1000,
    fillRatio: 1,
    slippage: 0.005,
    liquidityScore: 0.95,
    filledAtMid: false,
    reasonCodes: [],
    ...over,
  };
}

export function btcContext(
  over: Partial<BtcContextSnapshot> = {},
): BtcContextSnapshot {
  return {
    timestamp: new Date().toISOString(),
    btcCexPriceNow: 68_000,
    dataAgeMs: 200,
    ...over,
  };
}
