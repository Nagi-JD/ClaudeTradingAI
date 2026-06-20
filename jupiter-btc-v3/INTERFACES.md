# V3 Module Interface Contract (AUTHORITATIVE)

Every module MUST expose exactly these signatures. Consumers call these names.
Import all shared types from `src/jupiter_prediction/models` and config from
`src/config/load_config`. **Do NOT redefine model types.** ESM + `bundler`
resolution → import WITHOUT `.js` extension. Node 20 has global `fetch`.
Defensive parsing everywhere; on schema drift return a safe/blocked value, never throw in hot paths.

## config/load_config.ts  (DONE)
- `loadConfig(pathOverride?: string): LoadedConfig`
- types: `Config`, `AppFlags`, `LoadedConfig` (fields: `config`, `flags`, `env`, `configPath`)
- `flags`: `{ readOnly, dryRun, enableLiveTrading, liveTradingPermitted, allowCexResearchFallback }`

## jupiter_prediction/client.ts
- `class JupiterPredictionClient`
  - `constructor(opts: { baseUrl: string; apiKey: string; timeoutMs: number; maxRetries: number; liveTradingPermitted: boolean })`
  - all GET methods return `Promise<{ raw: unknown; ok: boolean; status: number; data?: any }>`:
    `getTradingStatus()`, `getEvents(params?: Record<string,any>)`, `searchEvents(query: string)`,
    `getEvent(eventId: string)`, `getMarketDetails(eventId: string, marketId: string)`,
    `getOrderbook(marketId: string)`, `getTrades(params?: Record<string,any>)`,
    `getLeaderboards(params?: Record<string,any>)`, `getPositions(ownerPubkey: string)`,
    `getOrders(params?: Record<string,any>)`, `getOrderStatus(orderPubkey: string)`
  - `createOrderDryRun(orderRequest: unknown): Promise<{ raw: unknown; simulated: true }>`
  - `createOrder(orderRequest: unknown): Promise<never>` — MUST throw unless `liveTradingPermitted===true`. In this build it always throws.
  - Always sends header `x-api-key`. Uses timeout (AbortSignal.timeout) + retries with backoff; on 429 backs off. Preserves `raw`. Validates shape with zod where reasonable; on failure sets `ok:false` and returns raw (fail-safe, no throw).

## jupiter_prediction/normalizer.ts
- `normalizeMarket(rawEvent: unknown, rawMarket: unknown, provider: VenueProvider): NormalizedMarketSnapshot`
- Pure + defensive; missing fields → undefined; computes `timeLeftSeconds` from closeTime vs now.

## jupiter_prediction/market_discovery.ts
- `discoverBtcMarkets(client: JupiterPredictionClient, config: Config): Promise<NormalizedMarketSnapshot[]>`
- Uses `getEvents`/`searchEvents` for BTC crypto markets, identifies provider via venue_registry, normalizes each.

## venues/venue_registry.ts
- `identifyProvider(raw: unknown): VenueProvider`  (returns "unknown" on ambiguity)
- `isProviderSupported(p: VenueProvider): boolean`  (polymarket, kalshi → true)
- `describeProvider(p: VenueProvider): { supported: boolean; reasonCodes: string[] }`

## settlement/rule_parser.ts
- `interface ParsedRules { provider: VenueProvider; marketType: MarketType; targetPrice?: number; startPrice?: number; closeTime?: string; resolveAt?: string; settlementIndexName: string | null; settlementMechanic: SettlementMechanic; confidence: number; blockedBy: string[]; raw: unknown }`
- `parseSettlementRules(input: { eventTitle: string; marketTitle: string; rulesPrimary?: string; rulesSecondary?: string; provider: VenueProvider; rawMarket: unknown }): ParsedRules`
- If source/target unclear: low confidence + blockedBy includes `SETTLEMENT_RULE_UNCLEAR` and/or `TARGET_MISSING`.

## settlement/settlement_model.ts
- `buildSettlementSpec(market: NormalizedMarketSnapshot, config: Config): SettlementSpec`
- Wraps rule_parser + venue_registry; sets `canTrade`/`blockedBy` from config gates (`blockIfRuleUnclear`, `minRuleConfidence`, unknown provider, missing target).

## settlement/settlement_index_adapter.ts
- `fetchSettlementIndex(spec: SettlementSpec, opts: { allowCexResearchFallback: boolean; btcContextPrice?: number | null }): Promise<SettlementIndexSnapshot>`
- Provider stubs; if exact index unavailable → confidence 0 + block (use `blockedIndexSnapshot`). NEVER silent Binance fallback; CEX only when `allowCexResearchFallback` → low confidence.
- `recordIndexTick(marketId: string, price: number, t?: number): void`
- `getIndexTicks(marketId: string): { t: number; price: number }[]`

## settlement/result_reconciler.ts
- `reconcileResult(client: JupiterPredictionClient, market: NormalizedMarketSnapshot): Promise<{ outcome: "YES" | "NO" | "VOID" | null; raw: unknown }>`
- `reconcilePaperTrade(trade: PaperTrade, outcome: "YES" | "NO" | "VOID" | null): PaperTrade` (sets `outcome`, `realizedPnlUsd`; $1 settled contract value, pessimistic on VOID=0 pnl)

## pricing/normal_cdf.ts  (DONE)  → `normalCdf(z)`, `normalPdf(z)`, `erf(x)`

## pricing/vol_engine.ts
- `computeVol(input: { indexTicks: { t: number; price: number }[]; secondsLeft: number; settlementMechanic: SettlementMechanic; config: Config; nowMs?: number }): VolSnapshot`
- log-returns rv windows + EWMA + jump detection; stale/insufficient → regime DATA_STALE/volConfidence 0 + reasonCodes. σ conditioned on mechanic: POINT_IN_TIME=terminal move; TWAP/WINDOW=reduce variance (~÷√3); UNKNOWN→volConfidence 0. `expectedMoveUsd = lastPrice * volPerSec * sqrt(secondsLeft)` (mechanic-adjusted).

## pricing/binary_pricer.ts
- `interface BinaryPriceResult { fairYesBase: number | null; fairNoBase: number | null; zScore: number | null; expectedMoveUsd: number | null; distanceToTarget: number | null; reasonCodes: string[] }`
- `priceBinaryMarket(input: { settlementIndexPrice: number | null; targetPrice: number | null; secondsLeft: number; volSnapshot: VolSnapshot; config: Config }): BinaryPriceResult`
- `z = (settlementIndexPrice - targetPrice) / expectedMoveUsd`; `fairYesBase = normalCdf(z)`; clamp to [clampMin,clampMax]. Missing target/price/expMove too small/secondsLeft<=0/low volConfidence → nulls + reasonCodes.

## pricing/basis_monitor.ts
- `computeBasis(input: { settlementIndex: SettlementIndexSnapshot; btcContext: BtcContextSnapshot; history: number[]; config: Config }): BasisSnapshot`
- basisBps vs maxBasisBps, basisVolatilityBps vs maxBasisVolBps; missing/stale index → isStable=false + reasonCodes (`SETTLEMENT_INDEX_MISSING`, `SETTLEMENT_INDEX_STALE`, `BASIS_TOO_WIDE`, `BASIS_TOO_VOLATILE`).

## pricing/microstructure_tilt.ts
- `computeTilt(input: { btcContext: BtcContextSnapshot; basis: BasisSnapshot; fairYesBase: number | null; config: Config }): TiltResult`
- DISABLED by default (`config.tilts.enabled===false` → all zeros + reasonCode `TILT_DISABLED`). If basis unstable → zeros. Caps per config. Fills `variants` map for all `AblationVariant`.

## pricing/orderbook_walker.ts
- `parseOrderbook(raw: unknown): { yesAsks: OrderbookLevel[]; noAsks: OrderbookLevel[]; reasonCodes: string[] }`  (Jupiter books are BIDS-ONLY; real asks = opposite side flipped at 1−price)
- `walkOrderbook(input: { rawOrderbook: unknown; side: "YES" | "NO"; targetSizeUsd: number; config: Config }): OrderbookWalkResult`
- NEVER fill at mid (`filledAtMid:false` invariant); supports partial fills; insufficient depth → low fillRatio + reasonCode `FILL_QUALITY_POOR`.

## pricing/cost_model.ts
- `computeCosts(input: { walkYes?: OrderbookWalkResult; walkNo?: OrderbookWalkResult; latency: MeasuredLatencySnapshot; volRegime: VolRegime; secondsLeft: number; fairYesTilted: number | null; fairNoTilted: number | null; config: Config }): CostModelResult`
- effective prices from walk avgFill (never mid) + slippage + latency penalty + failedFill + fee; netEdge = fair − effectivePrice − penalties. Adverse selection: treat good unfilled quotes as NOT free.

## pricing/fair_value_engine.ts  (ASSEMBLER — no cycles)
- `computeFairValue(input: { binary: BinaryPriceResult; tilt: TiltResult; cost?: CostModelResult; market: NormalizedMarketSnapshot; settlement: SettlementSpec; vol: VolSnapshot; basis: BasisSnapshot; latency?: MeasuredLatencySnapshot; config: Config }): FairValueResult`
- fairYesTilted = clamp(fairYesBase + tilt.tiltTotal). gross edges vs market buy prices; net edges from cost. confidenceScore reduced by low ruleConfidence/volConfidence/basis instability/poor fill/high latency.

## features/btc_context_adapter.ts
- `fetchBtcContext(opts: { moondevApiKey?: string }): Promise<BtcContextSnapshot>`  (secondary features only; on any failure → nulls + dataAgeMs=Infinity, never throw)
- may call helpers from cvd_features/liquidation_features/momentum_features.

## features/cvd_features.ts → `computeCvdFeatures(raw: unknown): Partial<BtcContextSnapshot>`
## features/liquidation_features.ts → `computeLiquidationFeatures(raw: unknown): Partial<BtcContextSnapshot>`
## features/momentum_features.ts → `computeMomentumFeatures(raw: unknown): Partial<BtcContextSnapshot>`
(All pure, defensive, return partials merged by btc_context_adapter.)

## risk/measured_latency_engine.ts
- `class LatencyEngine { record(sample: { marketFetchMs?: number; orderbookFetchMs?: number; settlementIndexFetchMs?: number; btcContextFetchMs?: number; decisionMs?: number }): void; snapshot(input: { secondsLeft: number | null; totalDataAgeMs: number; config: Config }): MeasuredLatencySnapshot }`
- p50/p95/p99 over rolling samples; block if p95>maxAbsoluteMs, p95>maxFractionOfTimeLeft*timeLeft, or timeLeft<blockUnderSecondsLeft (reasonCodes + withinBudget=false).

## risk/position_limits.ts → `checkPositionLimit(sizeUsd: number, config: Config): { ok: boolean; blockedBy: string[] }`
## risk/loss_limits.ts → `class LossTracker { record(pnlUsd: number, t?: number): void; dailyLossUsd(nowMs?: number): number; exceeded(config: Config): boolean }`

## risk/correlation_risk_manager.ts
- `class CorrelationRiskManager { groupKey(market: NormalizedMarketSnapshot, settlement: SettlementSpec, side: "YES"|"NO", config: Config): ExposureGroupKey; keyString(k: ExposureGroupKey): string; currentExposureUsd(k: ExposureGroupKey): number; wouldExceed(k: ExposureGroupKey, addUsd: number, config: Config): boolean; addExposure(k: ExposureGroupKey, usd: number): void }`
- Overlapping BTC 5-min markets in same window/target/dir are NOT independent.

## risk/risk_manager.ts
- `evaluateRisk(input: { market: NormalizedMarketSnapshot; settlement: SettlementSpec; settlementIndex: SettlementIndexSnapshot; basis: BasisSnapshot; vol: VolSnapshot; fairValue: FairValueResult; latency: MeasuredLatencySnapshot; cost?: CostModelResult; walkYes?: OrderbookWalkResult; walkNo?: OrderbookWalkResult; flags: AppFlags; config: Config; correlation: CorrelationRiskManager; lossTracker: LossTracker }): RiskDecision`
- Applies ALL block rules from the spec §16. Returns side YES/NO/NONE + sizeUsd (≤ maxPositionUsd) + blockedBy + explanation.

## strategy/paper_trader.ts
- `makePaperTrade(input: { decision: StrategyDecision; variant: AblationVariant }): PaperTrade`  (uses cost effective fill; NEVER calls client.createOrder)
- `class PaperTrader { constructor(logger?: { write(o: unknown): void }); record(trade: PaperTrade): void; trades(): PaperTrade[] }`

## strategy/jupiter_btc_strategy.ts
- `class JupiterBtcStrategy { constructor(deps: { loaded: LoadedConfig; client: JupiterPredictionClient }); evaluateMarket(market: NormalizedMarketSnapshot): Promise<StrategyDecision>; runOnce(): Promise<StrategyDecision[]>; }`
- Wires the full pipeline §19. Maps blocks → `signal` (StrategySignal) + `action`. Live → action `LIVE_ORDER_BLOCKED` (never sends). Dry-run + allowed → builds paper trade.

## logging/jsonl_logger.ts → `class JsonlLogger { constructor(filePath: string); write(obj: unknown): void; close(): void }`
## logging/csv_logger.ts → `class CsvLogger { constructor(filePath: string, headers: string[]); write(row: Record<string, unknown>): void }`
## logging/snapshot_logger.ts → `class SnapshotLogger { constructor(dir: string); logMarket(s: NormalizedMarketSnapshot): void; logDecision(d: StrategyDecision): void }`
## logging/decision_logger.ts → `class DecisionLogger { constructor(dir: string); log(d: StrategyDecision): void }`

## research/reliability_metrics.ts
- `brierScore(samples: { p: number; outcome: 0 | 1 }[]): number`
- `logLoss(samples: { p: number; outcome: 0 | 1 }[]): number`
- `reliabilityCurve(samples: { p: number; outcome: 0 | 1 }[], buckets: number): { bucket: number; predicted: number; observed: number; n: number }[]`

## research/clv_engine.ts
- `computeClv(input: { side: "YES" | "NO"; entryPrice: number; closingYesPrice: number; closingNoPrice: number; costs?: number }): { clv: number; clvNet: number }`
- `aggregateClvByVariant(trades: (PaperTrade & { closingYesPrice?: number; closingNoPrice?: number })[]): Record<AblationVariant, { n: number; avgClv: number; avgClvNet: number }>`

## research/ablation_engine.ts
- `compareVariants(trades: PaperTrade[]): Record<AblationVariant, { n: number; brier: number | null; avgEdgeNet: number; netPnl: number }>`
- `shouldDisableTilt(report: ReturnType<typeof compareVariants>): { disable: boolean; reason: string }`

## research/calibration_engine.ts
- `buildCalibrationReport(trades: PaperTrade[], config: Config): { brier: number | null; logLoss: number | null; reliability: ReturnType<typeof import('./reliability_metrics').reliabilityCurve>; nResolved: number; byVariant: ReturnType<typeof import('./ablation_engine').compareVariants>; sigmaForecastError: number | null; notes: string[] }`

## replay/fill_simulator.ts
- `simulateFill(input: { walk: OrderbookWalkResult; side: "YES" | "NO"; sizeUsd: number; volRegime: VolRegime; config: Config }): { filled: boolean; fillPrice: number | null; filledSizeUsd: number; adverse: boolean; reasonCodes: string[] }`
- Pessimistic: never mid; partial allowed; adverse selection encoded.

## replay/regime_metrics.ts
- `timeLeftBucket(s: number | null): string`, `moneynessBucket(z: number | null): string`, `volRegimeBucket(r: VolRegime): string`, `basisRegimeBucket(bps: number | null): string`

## replay/pnl_metrics.ts
- `computePnlMetrics(trades: PaperTrade[]): { totalDecisions: number; allowed: number; rejected: number; grossPnl: number; netPnl: number; maxDrawdown: number; avgEdgeGross: number; avgEdgeNet: number; fillQualityDrag: number; latencyDrag: number }`

## replay/replay_engine.ts
- `replaySnapshots(input: { dir: string; config: Config }): Promise<{ decisions: StrategyDecision[]; trades: PaperTrade[]; pnl: ReturnType<typeof import('./pnl_metrics').computePnlMetrics> }>`
- Reads saved JSONL decision snapshots; re-simulates fills pessimistically.

## scripts (tsx entrypoints)
- `scripts/jupiter_collect_readonly.ts` — loadConfig → client → discover → evaluate → SnapshotLogger; READ-ONLY; no paper trades unless config allows; prints summary.
- `scripts/jupiter_btc_dashboard.ts` — renders panels §23 to terminal (pragmatic ANSI table; no heavy TUI dep). One-shot render of current state + risk blocks.
- `scripts/replay_jupiter_strategy.ts` — replayEngine over data/jupiter_decisions → pnl_metrics print.
- `scripts/calibration_report.ts` — buildCalibrationReport → print Brier/reliability/CLV/ablation.

All scripts must print a banner showing flags (READ_ONLY/DRY_RUN/ENABLE_LIVE_TRADING) and that live trading is disabled.
