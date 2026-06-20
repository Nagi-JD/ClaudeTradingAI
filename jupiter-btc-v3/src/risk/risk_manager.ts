// Risk manager — the final gate before a trade signal becomes actionable.
//
// Applies ALL spec §16 block rules. The output RiskDecision ALWAYS lists every
// blockedBy reason code when a trade is not allowed; a blocked trade never
// returns an empty blockedBy. Side is chosen from the best net edge (YES vs NO)
// and size is the min of the position cap and remaining correlated headroom.
//
// Live-trading permission is NOT evaluated here: a paper signal is still
// evaluated even when liveTradingPermitted is false. The strategy layer is
// responsible for refusing to send a live order. This keeps research signals
// flowing in read-only / dry-run modes.

import type { AppFlags, Config } from "../config/load_config";
import type {
  BasisSnapshot,
  CostModelResult,
  FairValueResult,
  MeasuredLatencySnapshot,
  NormalizedMarketSnapshot,
  OrderbookWalkResult,
  RiskDecision,
  SettlementIndexSnapshot,
  SettlementSpec,
  VolSnapshot,
} from "../jupiter_prediction/models";
import { CorrelationRiskManager } from "./correlation_risk_manager";
import { LossTracker } from "./loss_limits";
import { checkPositionLimit } from "./position_limits";

export interface EvaluateRiskInput {
  market: NormalizedMarketSnapshot;
  settlement: SettlementSpec;
  settlementIndex: SettlementIndexSnapshot;
  basis: BasisSnapshot;
  vol: VolSnapshot;
  fairValue: FairValueResult;
  latency: MeasuredLatencySnapshot;
  cost?: CostModelResult;
  walkYes?: OrderbookWalkResult;
  walkNo?: OrderbookWalkResult;
  flags: AppFlags;
  config: Config;
  correlation: CorrelationRiskManager;
  lossTracker: LossTracker;
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/** Pick the side with the best (highest) net edge. Returns null if neither. */
function chooseSideByEdge(
  edgeYesNet: number | null | undefined,
  edgeNoNet: number | null | undefined,
): { side: "YES" | "NO"; edge: number } | null {
  const yes = isFiniteNumber(edgeYesNet) ? edgeYesNet : null;
  const no = isFiniteNumber(edgeNoNet) ? edgeNoNet : null;
  if (yes === null && no === null) return null;
  if (yes !== null && (no === null || yes >= no)) return { side: "YES", edge: yes };
  return { side: "NO", edge: no as number };
}

export function evaluateRisk(input: EvaluateRiskInput): RiskDecision {
  const blockedBy: string[] = [];
  const {
    market,
    settlement,
    settlementIndex,
    basis,
    vol,
    fairValue,
    latency,
    cost,
    walkYes,
    walkNo,
    flags,
    config,
    correlation,
    lossTracker,
  } = input ?? ({} as EvaluateRiskInput);

  const add = (code: string) => {
    if (!blockedBy.includes(code)) blockedBy.push(code);
  };

  // Defensive: if core inputs are missing, block hard.
  if (!config || !market || !settlement || !fairValue) {
    add("RISK_INPUT_MISSING");
    return {
      allowed: false,
      side: "NONE",
      blockedBy,
      sizeUsd: 0,
      explanation: "Missing required risk inputs; blocked fail-safe.",
    };
  }

  // ── §16: read-only vs live attempt ─────────────────────────────────────────
  // readOnly mode does not block paper evaluation; but a TRUE live attempt
  // (enableLiveTrading set while still readOnly) is contradictory → block.
  if (flags?.readOnly === true && flags?.enableLiveTrading === true) {
    add("READ_ONLY_LIVE_CONFLICT");
  }

  // ── §16: provider unknown / unsupported ────────────────────────────────────
  if (settlement.provider === "unknown" || market.provider === "unknown") {
    add("PROVIDER_UNKNOWN");
  }

  // ── §16: settlement rule unclear / target missing ─────────────────────────
  if (settlement.canTrade === false) {
    add("SETTLEMENT_BLOCKED");
  }
  if (Array.isArray(settlement.blockedBy)) {
    for (const code of settlement.blockedBy) {
      if (typeof code === "string" && code.length > 0) add(code);
    }
  }
  if (!isFiniteNumber(settlement.targetPrice)) {
    add("TARGET_MISSING");
  }

  // ── §16: settlement index unavailable / stale ──────────────────────────────
  const maxDataAgeMs = config.risk?.maxDataAgeMs;
  if (!settlementIndex || settlementIndex.confidence === 0) {
    add("SETTLEMENT_INDEX_UNAVAILABLE");
  } else if (
    isFiniteNumber(maxDataAgeMs) &&
    isFiniteNumber(settlementIndex.dataAgeMs) &&
    settlementIndex.dataAgeMs > maxDataAgeMs
  ) {
    add("SETTLEMENT_INDEX_STALE");
  } else if (!isFiniteNumber(settlementIndex.dataAgeMs)) {
    add("SETTLEMENT_INDEX_STALE");
  }

  // ── §16: basis unstable ─────────────────────────────────────────────────────
  if (!basis || basis.isStable === false) {
    add("BASIS_UNSTABLE");
  }

  // ── §16: vol confidence low ────────────────────────────────────────────────
  if (!vol) {
    add("VOL_UNAVAILABLE");
  } else {
    if (vol.regime === "DATA_STALE") add("VOL_DATA_STALE");
    if (!isFiniteNumber(vol.volConfidence) || vol.volConfidence <= 0) {
      add("VOL_CONFIDENCE_LOW");
    }
  }

  // ── §16: time-left out of bounds ───────────────────────────────────────────
  const timeLeft = market.timeLeftSeconds;
  const minTL = config.risk?.minTimeLeftSeconds;
  const maxTL = config.risk?.maxTimeLeftSeconds;
  if (!isFiniteNumber(timeLeft)) {
    add("TIME_LEFT_UNKNOWN");
  } else {
    if (isFiniteNumber(minTL) && (timeLeft as number) < minTL) {
      add("TIME_LEFT_TOO_SHORT");
    }
    if (isFiniteNumber(maxTL) && (timeLeft as number) > maxTL) {
      add("TIME_LEFT_TOO_LONG");
    }
  }

  // ── §16: latency budget ────────────────────────────────────────────────────
  if (!latency || latency.withinBudget === false) {
    add("LATENCY_BUDGET_EXCEEDED");
    if (latency && Array.isArray(latency.reasonCodes)) {
      for (const code of latency.reasonCodes) {
        if (typeof code === "string" && code.length > 0) add(code);
      }
    }
  }

  // ── side selection (needed for liquidity / fill checks) ────────────────────
  const chosen = chooseSideByEdge(fairValue.edgeYesNet, fairValue.edgeNoNet);

  // ── §16: orderbook liquidity insufficient ──────────────────────────────────
  const minFillRatio = config.orderbook?.minFillRatio;
  const walkForSide =
    chosen?.side === "YES" ? walkYes : chosen?.side === "NO" ? walkNo : undefined;
  if (chosen) {
    if (!walkForSide) {
      add("LIQUIDITY_UNAVAILABLE");
    } else if (
      isFiniteNumber(minFillRatio) &&
      (!isFiniteNumber(walkForSide.fillRatio) ||
        walkForSide.fillRatio < minFillRatio)
    ) {
      add("LIQUIDITY_INSUFFICIENT");
    }
    if (
      walkForSide &&
      Array.isArray(walkForSide.reasonCodes) &&
      walkForSide.reasonCodes.includes("FILL_QUALITY_POOR")
    ) {
      add("FILL_QUALITY_POOR");
    }
  }

  // ── §16: fill quality poor (from cost model) ───────────────────────────────
  if (cost) {
    if (
      isFiniteNumber(cost.fillQualityScore) &&
      cost.fillQualityScore <= 0
    ) {
      add("FILL_QUALITY_POOR");
    }
    if (Array.isArray(cost.reasonCodes) && cost.reasonCodes.includes("FILL_QUALITY_POOR")) {
      add("FILL_QUALITY_POOR");
    }
  }

  // ── §16: net edge below minimum ────────────────────────────────────────────
  const minEdgeNet = config.risk?.minEdgeNet;
  if (!chosen) {
    add("NO_NET_EDGE");
  } else if (isFiniteNumber(minEdgeNet) && chosen.edge < minEdgeNet) {
    add("EDGE_BELOW_MIN");
  }

  // ── §16: confidence below minimum ──────────────────────────────────────────
  const minConfidence = config.risk?.minConfidence;
  if (
    !isFiniteNumber(fairValue.confidenceScore) ||
    (isFiniteNumber(minConfidence) && fairValue.confidenceScore < minConfidence)
  ) {
    add("CONFIDENCE_BELOW_MIN");
  }

  // ── §16: market not active / open ──────────────────────────────────────────
  if (market.isActive === false) {
    add("MARKET_NOT_ACTIVE");
  }
  if (isFiniteNumber(market.timeLeftSeconds) && (market.timeLeftSeconds as number) <= 0) {
    add("MARKET_CLOSED");
  }

  // ── §16: daily loss exceeded ───────────────────────────────────────────────
  if (lossTracker && lossTracker.exceeded(config)) {
    add("DAILY_LOSS_EXCEEDED");
  }

  // ── correlated exposure + sizing ───────────────────────────────────────────
  // Compute sizing only when a side is chosen, so headroom uses the right group.
  let sizeUsd = 0;
  if (chosen && correlation) {
    const key = correlation.groupKey(market, settlement, chosen.side, config);
    const headroom = correlation.remainingHeadroomUsd(key, config);
    const cap = config.risk?.maxPositionUsd;
    const capUsd = isFiniteNumber(cap) && cap > 0 ? cap : 0;
    // sizeUsd = min(position cap, remaining correlated headroom).
    sizeUsd = Math.max(0, Math.min(capUsd, headroom));

    if (headroom <= 0) {
      add("CORRELATED_EXPOSURE_EXCEEDED");
    }
  } else if (!correlation) {
    add("CORRELATION_MANAGER_MISSING");
  }

  // ── §16: position size sanity ──────────────────────────────────────────────
  if (chosen) {
    const posCheck = checkPositionLimit(sizeUsd, config);
    if (!posCheck.ok) {
      for (const code of posCheck.blockedBy) add(code);
    }
  }

  const allowed = blockedBy.length === 0 && chosen !== null && sizeUsd > 0;

  const side: "YES" | "NO" | "NONE" = allowed && chosen ? chosen.side : "NONE";
  const finalSize = allowed ? sizeUsd : 0;

  const explanation = allowed
    ? `Allowed ${side} sizeUsd=${finalSize.toFixed(2)} netEdge=${chosen!.edge.toFixed(4)} confidence=${fairValue.confidenceScore.toFixed(3)}`
    : `Blocked by: ${blockedBy.join(", ") || "UNKNOWN"}`;

  return {
    allowed,
    side,
    blockedBy,
    sizeUsd: finalSize,
    explanation,
  };
}
