// Central type contracts for Jupiter BTC V3.
// Every module imports its shared vocabulary from here. Do NOT redefine these
// elsewhere. Research-first: types carry reasonCodes / blockedBy so that a
// NO_TRADE is always explainable and auditable.

// ─────────────────────────────────────────────────────────────── providers ──
export type VenueProvider = "polymarket" | "kalshi" | "unknown";

export type MarketType = "UP_DOWN" | "ABOVE_BELOW" | "UNKNOWN";

// ───────────────────────────────────────────────────────────── settlement ──
export interface SettlementSpec {
  provider: VenueProvider;
  marketId: string;
  eventId: string;
  marketType: MarketType;
  ruleConfidence: number;
  settlementIndexName: string | null;
  settlementIndexUrl?: string;
  settlementPriceField?: string;
  startPrice?: number;
  targetPrice?: number;
  closeTime?: string;
  resolveAt?: string;
  /** "POINT_IN_TIME" | "TWAP" | "WINDOW" | "UNKNOWN" — drives σ conditioning. */
  settlementMechanic?: SettlementMechanic;
  canTrade: boolean;
  blockedBy: string[];
  rawRules: unknown;
}

export type SettlementMechanic = "POINT_IN_TIME" | "TWAP" | "WINDOW" | "UNKNOWN";

export interface SettlementIndexSnapshot {
  provider: VenueProvider;
  marketId: string;
  indexName: string | null;
  indexPrice: number | null;
  timestamp: string;
  dataAgeMs: number;
  confidence: number;
  rawPayload?: unknown;
}

// ──────────────────────────────────────────────────────────────── markets ──
export interface NormalizedMarketSnapshot {
  timestamp: string;
  provider: VenueProvider;
  eventId: string;
  marketId: string;
  eventTitle: string;
  marketTitle: string;
  category?: string;
  status?: string;
  isActive: boolean;
  isLive: boolean;
  openTime?: string;
  closeTime?: string;
  resolveAt?: string;
  timeLeftSeconds: number | null;
  buyYesPriceUsd?: number;
  buyNoPriceUsd?: number;
  sellYesPriceUsd?: number;
  sellNoPriceUsd?: number;
  yesBid?: number;
  yesAsk?: number;
  noBid?: number;
  noAsk?: number;
  volume?: number;
  volumeUsd?: number;
  rulesPrimary?: string;
  rulesSecondary?: string;
  clobTokenIds?: unknown;
  marketResultPubkey?: string;
  rawPayload: unknown;
}

// ────────────────────────────────────────────────────────── btc context ──
export interface BtcContextSnapshot {
  timestamp: string;
  btcCexPriceNow: number | null;
  btcChange1m?: number;
  btcChange3m?: number;
  btcChange5m?: number;
  realizedVolatility1m?: number;
  realizedVolatility5m?: number;
  cvd1m?: number;
  cvd3m?: number;
  cvd5m?: number;
  buyPressure5m?: number;
  sellPressure5m?: number;
  netImbalance5m?: number;
  liquidationLongVolume5m?: number;
  liquidationShortVolume5m?: number;
  liquidationImbalance5m?: number;
  nearLiqLongValue1pct?: number;
  nearLiqShortValue1pct?: number;
  nearLiqLongValue2pct?: number;
  nearLiqShortValue2pct?: number;
  dataAgeMs: number;
  rawSources?: unknown;
}

// ─────────────────────────────────────────────────────────── volatility ──
export type VolRegime =
  | "LOW_VOL"
  | "NORMAL_VOL"
  | "HIGH_VOL"
  | "JUMPY"
  | "DATA_STALE";

export interface VolSnapshot {
  rv10s?: number;
  rv30s?: number;
  rv1m?: number;
  rv3m?: number;
  rv5m?: number;
  ewmaVol?: number;
  jumpAdjustedVol?: number;
  regime: VolRegime;
  expectedMoveUsd: number | null;
  volConfidence: number;
  reasonCodes: string[];
}

// ──────────────────────────────────────────────────────────────── basis ──
export interface BasisSnapshot {
  settlementIndexPrice: number | null;
  cexReferencePrice: number | null;
  basisUsd: number | null;
  basisBps: number | null;
  basisVolatilityBps?: number;
  basisTrend?: number;
  isStable: boolean;
  reasonCodes: string[];
}

// ───────────────────────────────────────────────── microstructure tilt ──
export type AblationVariant =
  | "base_only"
  | "base_plus_cvd"
  | "base_plus_liquidations"
  | "base_plus_momentum"
  | "base_plus_all";

export interface TiltResult {
  tiltTotal: number;
  tiltBreakdown: {
    cvd: number;
    liquidations: number;
    momentum: number;
  };
  usedFeatures: string[];
  reasonCodes: string[];
  /** per-variant tilt totals so ablation can replay without recompute. */
  variants: Record<AblationVariant, number>;
}

// ───────────────────────────────────────────────────────── orderbook ──
export interface OrderbookLevel {
  price: number;
  size: number;
}

export interface OrderbookWalkResult {
  side: "YES" | "NO";
  requestedSizeUsd: number;
  avgFillPrice: number | null;
  worstFillPrice: number | null;
  availableSizeUsd: number;
  fillRatio: number;
  slippage: number | null;
  liquidityScore: number;
  filledAtMid: false; // invariant: never true
  reasonCodes: string[];
}

// ─────────────────────────────────────────────────────────── latency ──
export interface MeasuredLatencySnapshot {
  marketFetchMs?: number;
  orderbookFetchMs?: number;
  settlementIndexFetchMs?: number;
  btcContextFetchMs?: number;
  decisionMs?: number;
  totalDataAgeMs: number;
  p50: number;
  p95: number;
  p99: number;
  withinBudget: boolean;
  reasonCodes: string[];
}

// ──────────────────────────────────────────────────────────── costs ──
export interface CostModelResult {
  effectiveBuyYesPrice: number | null;
  effectiveBuyNoPrice: number | null;
  expectedSlippage: number;
  latencyPenalty: number;
  failedFillPenalty: number;
  feeEstimate: number;
  netEdgeYes: number | null;
  netEdgeNo: number | null;
  fillQualityScore: number;
  reasonCodes: string[];
}

// ───────────────────────────────────────────────────── fair value ──
export interface FairValueResult {
  fairYesBase: number | null;
  fairNoBase: number | null;
  fairYesTilted: number | null;
  fairNoTilted: number | null;
  zScore: number | null;
  expectedMoveUsd: number | null;
  distanceToTarget: number | null;
  edgeYesGross: number | null;
  edgeNoGross: number | null;
  edgeYesNet: number | null;
  edgeNoNet: number | null;
  confidenceScore: number;
  reasonCodes: string[];
}

// ─────────────────────────────────────────────────────────────── risk ──
export interface RiskDecision {
  allowed: boolean;
  side: "YES" | "NO" | "NONE";
  blockedBy: string[];
  sizeUsd: number;
  explanation: string;
}

export type StrategyAction = "NO_TRADE" | "PAPER_TRADE" | "LIVE_ORDER_BLOCKED";

export type StrategySignal =
  | "BASELINE_ONLY"
  | "YES_EDGE"
  | "NO_EDGE"
  | "NO_TRADE"
  | "SETTLEMENT_UNKNOWN"
  | "BASIS_UNSTABLE"
  | "VOL_LOW_CONFIDENCE"
  | "FILL_QUALITY_POOR"
  | "LATENCY_TOO_HIGH"
  | "TILT_DISABLED";

export interface StrategyDecision {
  timestamp: string;
  market: NormalizedMarketSnapshot;
  settlement: SettlementSpec;
  settlementIndex: SettlementIndexSnapshot;
  btcContext: BtcContextSnapshot;
  basis: BasisSnapshot;
  vol: VolSnapshot;
  fairValue: FairValueResult;
  risk: RiskDecision;
  latency?: MeasuredLatencySnapshot;
  orderbookYes?: OrderbookWalkResult;
  orderbookNo?: OrderbookWalkResult;
  cost?: CostModelResult;
  signal: StrategySignal;
  action: StrategyAction;
}

// ──────────────────────────────────────────────────────── paper trade ──
export interface PaperTrade {
  timestamp: string;
  marketId: string;
  provider: VenueProvider;
  side: "YES" | "NO";
  sizeUsd: number;
  effectiveFillPrice: number;
  fairPriceAtDecision: number;
  edgeNet: number;
  timeLeftSeconds: number | null;
  settlementIndexPrice: number | null;
  targetPrice: number | null;
  volRegime: VolRegime;
  basisBps: number | null;
  latencyP95: number;
  variant: AblationVariant;
  reasonCodes: string[];
  /** populated by reconciler after settlement; null until resolved. */
  outcome?: "YES" | "NO" | "VOID" | null;
  realizedPnlUsd?: number | null;
}

// ───────────────────────────────────────── correlation grouping ──
export interface ExposureGroupKey {
  asset: "BTC";
  provider: VenueProvider;
  settlementIndexName: string | null;
  windowBucket: string; // overlapping-time bucket id
  targetBucket: string; // similar-target bucket id
  direction: "YES" | "NO";
}

// Convenience: an empty/blocked index snapshot factory used widely.
export function blockedIndexSnapshot(
  provider: VenueProvider,
  marketId: string,
  reason: string,
): SettlementIndexSnapshot {
  return {
    provider,
    marketId,
    indexName: null,
    indexPrice: null,
    timestamp: new Date().toISOString(),
    dataAgeMs: Number.POSITIVE_INFINITY,
    confidence: 0,
    rawPayload: { blocked: reason },
  };
}
