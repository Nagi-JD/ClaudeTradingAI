// Jupiter BTC strategy — the §19 pipeline orchestrator.
//
// SAFETY POSTURE (load-bearing):
//   - This module NEVER signs, NEVER constructs a real order, and NEVER calls
//     client.createOrder. In dry-run + allowed it builds a PAPER_TRADE only.
//   - If a LIVE attempt is somehow configured (liveTradingPermitted), the
//     action is LIVE_ORDER_BLOCKED and no order is sent — the live path is a
//     hard wall here.
//   - Every pipeline step is wrapped so that one malformed market can never
//     crash the loop; a failed step degrades to a safe/blocked value.
//
// §19 pipeline per market:
//   provider → settlement spec → fetch + record index tick → vol (from
//   recorded ticks) → btc context → basis → binary price → tilt → orderbook
//   fetch + walk YES/NO → latency snapshot → cost → fair value assemble →
//   evaluateRisk → map to signal/action → (paper trade if dry-run+allowed).
//
// Shared per-strategy state: ONE LatencyEngine, ONE CorrelationRiskManager,
// ONE LossTracker — so latency percentiles and correlated exposure accumulate
// across markets within a run.

import type { LoadedConfig } from "../config/load_config";
import type {
  BasisSnapshot,
  BtcContextSnapshot,
  CostModelResult,
  FairValueResult,
  MeasuredLatencySnapshot,
  NormalizedMarketSnapshot,
  OrderbookWalkResult,
  RiskDecision,
  SettlementIndexSnapshot,
  SettlementSpec,
  StrategyAction,
  StrategyDecision,
  StrategySignal,
  VolSnapshot,
} from "../jupiter_prediction/models";
import { blockedIndexSnapshot } from "../jupiter_prediction/models";
import { JupiterPredictionClient } from "../jupiter_prediction/client";
import { discoverBtcMarkets } from "../jupiter_prediction/market_discovery";
import { buildSettlementSpec } from "../settlement/settlement_model";
import {
  fetchSettlementIndex,
  recordIndexTick,
  getIndexTicks,
} from "../settlement/settlement_index_adapter";
import { computeVol } from "../pricing/vol_engine";
import { priceBinaryMarket } from "../pricing/binary_pricer";
import { computeBasis } from "../pricing/basis_monitor";
import { computeTilt } from "../pricing/microstructure_tilt";
import { walkOrderbook } from "../pricing/orderbook_walker";
import { computeCosts } from "../pricing/cost_model";
import { computeFairValue } from "../pricing/fair_value_engine";
import { fetchBtcContext } from "../features/btc_context_adapter";
import {
  getProxyTicks,
  getLatestConsensus,
  getProxyPriceAt,
} from "../pricing/proxy_index";
import { LatencyEngine } from "../risk/measured_latency_engine";
import { CorrelationRiskManager } from "../risk/correlation_risk_manager";
import { LossTracker } from "../risk/loss_limits";
import { evaluateRisk } from "../risk/risk_manager";

export interface JupiterBtcStrategyDeps {
  loaded: LoadedConfig;
  client: JupiterPredictionClient;
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/** Time a promise; returns [result, elapsedMs]. Elapsed is best-effort. */
async function timed<T>(p: Promise<T>): Promise<[T, number]> {
  const start = Date.now();
  const r = await p;
  return [r, Math.max(0, Date.now() - start)];
}

export class JupiterBtcStrategy {
  private readonly loaded: LoadedConfig;
  private readonly client: JupiterPredictionClient;

  // Shared, run-scoped state.
  private readonly latency = new LatencyEngine();
  private readonly correlation = new CorrelationRiskManager();
  private readonly lossTracker = new LossTracker();

  // Rolling per-market basis history (bps) for the basis monitor.
  private readonly basisHistory = new Map<string, number[]>();
  private static readonly MAX_BASIS_HISTORY = 64;

  // Proxy mode only: per-market window-OPEN anchor price (the up/down target).
  // Captured the FIRST time we see a market early in its window. Approximate
  // (our capture ≈ open, not the exact official open) — reflected by the proxy
  // index's low confidence. Markets first seen too late get no anchor (honest).
  private readonly openAnchors = new Map<
    string,
    { price: number; tMs: number; capturedSecondsLeft: number }
  >();
  // Max tolerance (ms) between a market's computed window-open instant and the
  // nearest recorded proxy tick. Wider than the poll interval, tight enough that
  // a window we never observed near open yields no anchor.
  private static readonly ANCHOR_TOLERANCE_MS = Number(
    process.env.PROXY_ANCHOR_TOLERANCE_MS ?? 120000,
  );

  // Near-strike band (bps, PRICE space). band = max(k·dispersion_now, p99 floor)
  // + bias cushion. Biased WIDE on purpose: skipping a marginal trade is cheap;
  // taking a close-call the proxy mismeasures fabricates a false edge that
  // corrupts the whole verdict. Cushion covers the systematic consensus↔Chainlink
  // bias that dispersion cannot see (shrinks once on-chain calibration lands).
  private static readonly NEARSTRIKE_K = Number(process.env.NEARSTRIKE_K ?? 3);
  private static readonly NEARSTRIKE_P99_FLOOR_BPS = Number(process.env.NEARSTRIKE_P99_FLOOR_BPS ?? 8);
  private static readonly NEARSTRIKE_BIAS_BPS = Number(process.env.NEARSTRIKE_BIAS_BPS ?? 5);

  /**
   * Derive the window length (ms) from the two clock times in an event title,
   * e.g. "...3:45AM-4:00AM ET" → 15min. Timezone-independent (uses the DELTA
   * between the two times, mod 24h). Returns null if not parseable.
   */
  private static windowDurationMs(title: string): number | null {
    if (typeof title !== "string") return null;
    const re = /(\d{1,2}):(\d{2})\s*([AaPp][Mm])/g;
    const mins: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(title)) !== null && mins.length < 2) {
      let h = parseInt(m[1], 10) % 12;
      const min = parseInt(m[2], 10);
      if (/[Pp]/.test(m[3])) h += 12;
      if (Number.isFinite(h) && Number.isFinite(min)) mins.push(h * 60 + min);
    }
    if (mins.length < 2) return null;
    let delta = (((mins[1] - mins[0]) % 1440) + 1440) % 1440; // minutes, mod 24h
    if (delta <= 0 || delta > 24 * 60) return null;
    return delta * 60000;
  }

  constructor(deps: JupiterBtcStrategyDeps) {
    this.loaded = deps.loaded;
    this.client = deps.client;
  }

  /**
   * Run the full pipeline for a single market and return its decision.
   * Never throws — any internal failure resolves to a NO_TRADE decision with
   * explanatory reason codes folded into the risk/fair outputs.
   */
  async evaluateMarket(
    market: NormalizedMarketSnapshot,
  ): Promise<StrategyDecision> {
    const config = this.loaded.config;
    const flags = this.loaded.flags;
    const decisionStart = Date.now();

    // ── settlement spec ──────────────────────────────────────────────────
    let settlement: SettlementSpec;
    try {
      settlement = buildSettlementSpec(market, config);
    } catch {
      settlement = this.fallbackSettlement(market);
    }

    const marketId = settlement.marketId || market?.marketId || "";

    // ── btc context (secondary; needed for index fallback + basis) ────────
    let btcContext: BtcContextSnapshot;
    let btcFetchMs = 0;
    try {
      const [ctx, ms] = await timed(
        fetchBtcContext({ moondevApiKey: this.loaded.env?.moondevApiKey }),
      );
      btcContext = ctx;
      btcFetchMs = ms;
    } catch {
      btcContext = this.nullBtcContext();
    }
    let btcContextPrice = isFiniteNumber(btcContext?.btcCexPriceNow)
      ? (btcContext.btcCexPriceNow as number)
      : null;

    // Proxy mode: feed the basis monitor an INDEPENDENT USD venue (NOT Binance —
    // it's BTC/USDT, ~+11bps rich, which would fire a FALSE BASIS_UNSTABLE on the
    // USDT basis, not real decoupling). Using a USD source (Coinbase/Kraken) makes
    // the basis re-measure USD inter-source agreement: tight when venues agree,
    // widening only on genuine decoupling.
    if (flags?.allowProxyIndex === true && btcContextPrice === null) {
      const cons = getLatestConsensus();
      const usdRef = cons?.sources.find((s) => s.unit === "USD" && s.source !== "PYTH")
        ?? cons?.sources.find((s) => s.unit === "USD");
      if (usdRef && isFiniteNumber(usdRef.price) && usdRef.price > 0) {
        btcContextPrice = usdRef.price;
        btcContext = {
          ...btcContext,
          btcCexPriceNow: usdRef.price,
          dataAgeMs: Math.max(0, Date.now() - usdRef.tMs),
          rawSources: {
            ...(btcContext.rawSources as Record<string, unknown>),
            basisCrossCheck: usdRef.source,
            usdtBasisBps: cons?.usdtBasisBps,
            secondaryOnly: true,
          },
        };
      }
    }

    // ── settlement index (authoritative price source) + record tick ──────
    let settlementIndex: SettlementIndexSnapshot;
    let indexFetchMs = 0;
    try {
      const [idx, ms] = await timed(
        fetchSettlementIndex(settlement, {
          allowCexResearchFallback: flags?.allowCexResearchFallback === true,
          allowProxyIndex: flags?.allowProxyIndex === true,
          btcContextPrice,
        }),
      );
      settlementIndex = idx;
      indexFetchMs = ms;
    } catch {
      settlementIndex = blockedIndexSnapshot(
        settlement.provider,
        marketId,
        "SETTLEMENT_INDEX_FETCH_THREW",
      );
    }
    // Record the index tick so the vol engine can build RV windows over time.
    try {
      if (
        marketId &&
        isFiniteNumber(settlementIndex?.indexPrice) &&
        (settlementIndex.indexPrice as number) > 0
      ) {
        recordIndexTick(marketId, settlementIndex.indexPrice as number);
      }
    } catch {
      // never throw
    }

    const secondsLeft = isFiniteNumber(market?.timeLeftSeconds)
      ? (market.timeLeftSeconds as number)
      : 0;

    // ── proxy mode: window-open anchor target + low-confidence fold ────────
    const proxySrc = (settlementIndex?.rawPayload as { source?: string } | undefined)?.source;
    const indexIsProxy =
      flags?.allowProxyIndex === true &&
      isFiniteNumber(settlementIndex?.indexPrice) &&
      (settlementIndex.indexPrice as number) > 0 &&
      (proxySrc === "USD_CONSENSUS_PROXY" || proxySrc === "PYTH_PROXY");

    if (indexIsProxy) {
      // (a) Anchor the UP_DOWN target on the proxy price AT THE WINDOW OPEN when
      //     no numeric target was parsed. The open instant = closeTime − window
      //     length (parsed from the title). We look that price up in our own
      //     high-frequency proxy tick buffer; if the buffer doesn't cover the
      //     open (we weren't running yet), there is NO anchor → honest NO_TRADE.
      if (
        settlement.marketType === "UP_DOWN" &&
        !isFiniteNumber(settlement.targetPrice) &&
        !isFiniteNumber(settlement.startPrice)
      ) {
        let anchor = this.openAnchors.get(marketId);
        if (!anchor) {
          const closeMs = Date.parse(
            settlement.closeTime ?? market?.closeTime ?? "",
          );
          const durMs = JupiterBtcStrategy.windowDurationMs(
            market?.eventTitle ?? "",
          );
          if (Number.isFinite(closeMs) && durMs !== null) {
            const openMs = closeMs - durMs;
            const hit = getProxyPriceAt(
              openMs,
              JupiterBtcStrategy.ANCHOR_TOLERANCE_MS,
            );
            if (hit) {
              anchor = {
                price: hit.price,
                tMs: hit.t,
                capturedSecondsLeft: secondsLeft,
              };
              this.openAnchors.set(marketId, anchor);
            }
          }
        }
        if (anchor) {
          const blocked = (Array.isArray(settlement.blockedBy)
            ? settlement.blockedBy
            : []
          ).filter((c) => c !== "TARGET_MISSING");
          settlement = {
            ...settlement,
            targetPrice: anchor.price,
            blockedBy: blocked,
            canTrade: blocked.length === 0,
            rawRules: {
              ...(settlement.rawRules as Record<string, unknown>),
              anchorProxyTarget: {
                price: anchor.price,
                openTickMs: anchor.tMs,
                note:
                  "UP_DOWN target anchored on the Pyth proxy price at the window " +
                  "open (looked up from the tick buffer) — research only.",
              },
            },
          };
        }
      }

      // (b) Two-axis confidence. Axis 1 = inter-source AGREEMENT (the index's own
      //     confidence, set by the adapter from measured dispersion). Axis 2 =
      //     NEAR-STRIKE BAND: how close the index sits to the target, in PRICE/bps
      //     space (NOT z — dividing by a vol that shrinks near expiry would falsely
      //     report "far from strike"). Inside the band the UNMEASURED residual-to-
      //     Chainlink can flip the outcome, so confidence is killed there regardless
      //     of how well the sources agree. The band is DYNAMIC (widens with current
      //     dispersion) + a tail floor + a bias cushion (the systematic offset that
      //     dispersion can't see), and biased WIDE (skipping a marginal trade is
      //     cheap; taking a close-call the proxy mismeasures fabricates false edge).
      let idxConf = isFiniteNumber(settlementIndex.confidence)
        ? (settlementIndex.confidence as number)
        : 0.3;
      const rp = (settlementIndex.rawPayload ?? {}) as { dispersionBps?: number };
      const dispBps = isFiniteNumber(rp.dispersionBps) ? (rp.dispersionBps as number) : 99;
      const idxPx = settlementIndex.indexPrice as number;
      const tgt = settlement.targetPrice;
      let nearStrike = false;
      let distanceBps: number | null = null;
      let bandBps: number | null = null;
      if (isFiniteNumber(idxPx) && idxPx > 0 && isFiniteNumber(tgt)) {
        distanceBps = (Math.abs(idxPx - (tgt as number)) / idxPx) * 10000;
        // band = max(k·current_dispersion, p99 tail floor) + bias cushion
        bandBps =
          Math.max(JupiterBtcStrategy.NEARSTRIKE_K * dispBps, JupiterBtcStrategy.NEARSTRIKE_P99_FLOOR_BPS) +
          JupiterBtcStrategy.NEARSTRIKE_BIAS_BPS;
        if (distanceBps < bandBps) {
          nearStrike = true;
          idxConf = 0; // inside the residual band → abstain, do not trust the outcome
        }
      }
      settlement = {
        ...settlement,
        ruleConfidence: Math.max(0, Math.min(1, (settlement.ruleConfidence ?? 0) * idxConf)),
        rawRules: {
          ...(settlement.rawRules as Record<string, unknown>),
          proxyConfidence: {
            agreementConf: settlementIndex.confidence,
            dispersionBps: dispBps,
            distanceToStrikeBps: distanceBps,
            nearStrikeBandBps: bandBps,
            nearStrikeAbstain: nearStrike,
          },
        },
      };
    }

    // ── volatility (from recorded ticks, conditioned on mechanic) ─────────
    let vol: VolSnapshot;
    try {
      // Proxy mode uses the high-frequency shared Pyth tick buffer; otherwise
      // the per-market settlement-index ticks.
      const ticks = indexIsProxy ? getProxyTicks() : getIndexTicks(marketId);
      vol = computeVol({
        indexTicks: ticks,
        secondsLeft,
        settlementMechanic: settlement.settlementMechanic ?? "UNKNOWN",
        config,
      });
    } catch {
      vol = {
        regime: "DATA_STALE",
        expectedMoveUsd: null,
        volConfidence: 0,
        reasonCodes: ["VOL_STEP_THREW"],
      };
    }

    // ── basis monitor ─────────────────────────────────────────────────────
    let basis: BasisSnapshot;
    try {
      const history = this.basisHistory.get(marketId) ?? [];
      basis = computeBasis({ settlementIndex, btcContext, history, config });
      this.pushBasisHistory(marketId, basis.basisBps);
    } catch {
      basis = {
        settlementIndexPrice: null,
        cexReferencePrice: null,
        basisUsd: null,
        basisBps: null,
        isStable: false,
        reasonCodes: ["BASIS_STEP_THREW"],
      };
    }

    // ── binary base price ─────────────────────────────────────────────────
    let binary;
    try {
      binary = priceBinaryMarket({
        settlementIndexPrice: isFiniteNumber(settlementIndex?.indexPrice)
          ? (settlementIndex.indexPrice as number)
          : null,
        targetPrice: isFiniteNumber(settlement?.targetPrice)
          ? (settlement.targetPrice as number)
          : null,
        secondsLeft,
        volSnapshot: vol,
        config,
        // Proxy/research mode: compute fair value even at low vol confidence so
        // the edge is measurable; it stays NO_TRADE downstream.
        relaxVolConfidenceGate: indexIsProxy,
      });
    } catch {
      binary = {
        fairYesBase: null,
        fairNoBase: null,
        zScore: null,
        expectedMoveUsd: vol?.expectedMoveUsd ?? null,
        distanceToTarget: null,
        reasonCodes: ["BINARY_STEP_THREW"],
      };
    }

    // ── microstructure tilt (disabled by default) ─────────────────────────
    let tilt;
    try {
      tilt = computeTilt({
        btcContext,
        basis,
        fairYesBase: binary.fairYesBase,
        config,
      });
    } catch {
      tilt = {
        tiltTotal: 0,
        tiltBreakdown: { cvd: 0, liquidations: 0, momentum: 0 },
        usedFeatures: [],
        reasonCodes: ["TILT_STEP_THREW"],
        variants: {
          base_only: 0,
          base_plus_cvd: 0,
          base_plus_liquidations: 0,
          base_plus_momentum: 0,
          base_plus_all: 0,
        },
      };
    }

    // ── orderbook fetch + walk YES / NO ───────────────────────────────────
    let orderbookYes: OrderbookWalkResult | undefined;
    let orderbookNo: OrderbookWalkResult | undefined;
    let orderbookFetchMs = 0;
    try {
      const [ob, ms] = await timed(this.client.getOrderbook(marketId));
      orderbookFetchMs = ms;
      const rawOrderbook = ob?.ok ? (ob.data ?? ob.raw) : ob?.raw;
      const targetSizeUsd = isFiniteNumber(config?.risk?.maxPositionUsd)
        ? (config.risk.maxPositionUsd as number)
        : 0;
      orderbookYes = walkOrderbook({
        rawOrderbook,
        side: "YES",
        targetSizeUsd,
        config,
      });
      orderbookNo = walkOrderbook({
        rawOrderbook,
        side: "NO",
        targetSizeUsd,
        config,
      });
    } catch {
      orderbookYes = undefined;
      orderbookNo = undefined;
    }

    // ── latency snapshot (record this market's measured stage timings) ────
    let latencySnap: MeasuredLatencySnapshot;
    try {
      this.latency.record({
        orderbookFetchMs,
        settlementIndexFetchMs: indexFetchMs,
        btcContextFetchMs: btcFetchMs,
        decisionMs: Math.max(0, Date.now() - decisionStart),
      });
      const totalDataAgeMs = isFiniteNumber(settlementIndex?.dataAgeMs)
        ? (settlementIndex.dataAgeMs as number)
        : Number.POSITIVE_INFINITY;
      latencySnap = this.latency.snapshot({
        secondsLeft: isFiniteNumber(market?.timeLeftSeconds)
          ? (market.timeLeftSeconds as number)
          : null,
        totalDataAgeMs,
        config,
      });
    } catch {
      latencySnap = {
        totalDataAgeMs: Number.POSITIVE_INFINITY,
        p50: 0,
        p95: 0,
        p99: 0,
        withinBudget: false,
        reasonCodes: ["LATENCY_STEP_THREW"],
      };
    }

    // ── cost model ────────────────────────────────────────────────────────
    let cost: CostModelResult | undefined;
    try {
      cost = computeCosts({
        walkYes: orderbookYes,
        walkNo: orderbookNo,
        latency: latencySnap,
        volRegime: vol?.regime ?? "DATA_STALE",
        secondsLeft,
        // Tilt is applied inside fair value; cost uses the base as a proxy for
        // the tilted fair when assembling net edge. Pass base ± tilt directly.
        fairYesTilted: this.applyTilt(binary.fairYesBase, tilt?.tiltTotal, +1),
        fairNoTilted: this.applyTilt(binary.fairNoBase, tilt?.tiltTotal, -1),
        config,
      });
    } catch {
      cost = undefined;
    }

    // ── fair value assemble ───────────────────────────────────────────────
    let fairValue: FairValueResult;
    try {
      fairValue = computeFairValue({
        binary,
        tilt,
        cost,
        market,
        settlement,
        vol,
        basis,
        latency: latencySnap,
        config,
      });
    } catch {
      fairValue = this.fallbackFairValue();
    }

    // ── risk evaluation ───────────────────────────────────────────────────
    let risk: RiskDecision;
    try {
      risk = evaluateRisk({
        market,
        settlement,
        settlementIndex,
        basis,
        vol,
        fairValue,
        latency: latencySnap,
        cost,
        walkYes: orderbookYes,
        walkNo: orderbookNo,
        flags,
        config,
        correlation: this.correlation,
        lossTracker: this.lossTracker,
      });
    } catch {
      risk = {
        allowed: false,
        side: "NONE",
        blockedBy: ["RISK_STEP_THREW"],
        sizeUsd: 0,
        explanation: "Risk evaluation threw; blocked fail-safe.",
      };
    }

    // ── map → signal + action ─────────────────────────────────────────────
    const signal = this.deriveSignal({
      settlement,
      basis,
      vol,
      tilt,
      cost,
      risk,
    });
    const action = this.deriveAction(risk, flags);

    return {
      timestamp: new Date().toISOString(),
      market,
      settlement,
      settlementIndex,
      btcContext,
      basis,
      vol,
      fairValue,
      risk,
      latency: latencySnap,
      orderbookYes,
      orderbookNo,
      cost,
      signal,
      action,
    };
  }

  /**
   * Discover BTC markets and evaluate each. One bad market never aborts the
   * loop — failures are isolated per market. Never throws.
   */
  async runOnce(): Promise<StrategyDecision[]> {
    let markets: NormalizedMarketSnapshot[] = [];
    try {
      markets = await discoverBtcMarkets(this.client, this.loaded.config);
    } catch {
      markets = [];
    }

    const decisions: StrategyDecision[] = [];
    for (const market of markets) {
      try {
        const decision = await this.evaluateMarket(market);
        decisions.push(decision);
      } catch {
        // Defensive double-guard: evaluateMarket already never throws, but if
        // it somehow does, skip this market and continue the loop.
      }
    }
    return decisions;
  }

  // ─────────────────────────────────────────────────────────── helpers ──

  private applyTilt(
    base: number | null,
    tiltTotal: number | undefined,
    sign: 1 | -1,
  ): number | null {
    if (!isFiniteNumber(base)) return null;
    const t = isFiniteNumber(tiltTotal) ? tiltTotal : 0;
    const clampMin = isFiniteNumber(this.loaded.config?.binaryPricing?.clampMin)
      ? (this.loaded.config.binaryPricing.clampMin as number)
      : 0.01;
    const clampMax = isFiniteNumber(this.loaded.config?.binaryPricing?.clampMax)
      ? (this.loaded.config.binaryPricing.clampMax as number)
      : 0.99;
    const lo = Math.min(clampMin, clampMax);
    const hi = Math.max(clampMin, clampMax);
    return Math.max(lo, Math.min(hi, (base as number) + sign * t));
  }

  private pushBasisHistory(marketId: string, basisBps: number | null): void {
    if (!marketId || !isFiniteNumber(basisBps)) return;
    const arr = this.basisHistory.get(marketId) ?? [];
    arr.push(basisBps);
    if (arr.length > JupiterBtcStrategy.MAX_BASIS_HISTORY) {
      arr.splice(0, arr.length - JupiterBtcStrategy.MAX_BASIS_HISTORY);
    }
    this.basisHistory.set(marketId, arr);
  }

  /**
   * Map the pipeline outcome to a StrategySignal. Ordering reflects priority:
   * the first failing gate (settlement → basis → vol → fill → latency → tilt)
   * names the signal. If allowed, the chosen side's edge determines YES/NO.
   * Otherwise BASELINE_ONLY (when only the tilt is disabled but nothing else
   * blocks pricing) or NO_TRADE.
   */
  private deriveSignal(input: {
    settlement: SettlementSpec;
    basis: BasisSnapshot;
    vol: VolSnapshot;
    tilt: { reasonCodes?: string[] };
    cost?: CostModelResult;
    risk: RiskDecision;
  }): StrategySignal {
    const { settlement, basis, vol, tilt, cost, risk } = input;
    const blocked = Array.isArray(risk?.blockedBy) ? risk.blockedBy : [];

    const has = (code: string) => blocked.includes(code);

    // Allowed → edge direction.
    if (risk?.allowed === true) {
      return risk.side === "NO" ? "NO_EDGE" : "YES_EDGE";
    }

    // Settlement-class blocks.
    if (
      settlement?.canTrade === false ||
      settlement?.provider === "unknown" ||
      has("SETTLEMENT_BLOCKED") ||
      has("PROVIDER_UNKNOWN") ||
      has("TARGET_MISSING") ||
      has("SETTLEMENT_INDEX_UNAVAILABLE") ||
      has("SETTLEMENT_INDEX_STALE")
    ) {
      return "SETTLEMENT_UNKNOWN";
    }

    // Basis instability.
    if (basis?.isStable === false || has("BASIS_UNSTABLE")) {
      return "BASIS_UNSTABLE";
    }

    // Vol confidence.
    if (
      vol?.regime === "DATA_STALE" ||
      !isFiniteNumber(vol?.volConfidence) ||
      (vol?.volConfidence ?? 0) <= 0 ||
      has("VOL_CONFIDENCE_LOW") ||
      has("VOL_DATA_STALE")
    ) {
      return "VOL_LOW_CONFIDENCE";
    }

    // Fill quality.
    if (
      has("FILL_QUALITY_POOR") ||
      has("LIQUIDITY_INSUFFICIENT") ||
      has("LIQUIDITY_UNAVAILABLE") ||
      (Array.isArray(cost?.reasonCodes) &&
        cost!.reasonCodes.includes("FILL_QUALITY_POOR"))
    ) {
      return "FILL_QUALITY_POOR";
    }

    // Latency.
    if (has("LATENCY_BUDGET_EXCEEDED")) {
      return "LATENCY_TOO_HIGH";
    }

    // Tilt disabled but pricing otherwise computed → baseline-only research.
    if (
      Array.isArray(tilt?.reasonCodes) &&
      tilt.reasonCodes.includes("TILT_DISABLED")
    ) {
      return "BASELINE_ONLY";
    }

    return "NO_TRADE";
  }

  /**
   * Map the risk decision + flags to a StrategyAction.
   *   - liveTradingPermitted → LIVE_ORDER_BLOCKED (hard wall: never send).
   *   - allowed + dry-run → PAPER_TRADE.
   *   - otherwise → NO_TRADE.
   */
  private deriveAction(risk: RiskDecision, flags: {
    dryRun?: boolean;
    liveTradingPermitted?: boolean;
  }): StrategyAction {
    // Any live attempt is hard-blocked. We NEVER place a live order here.
    if (flags?.liveTradingPermitted === true) {
      return "LIVE_ORDER_BLOCKED";
    }
    if (risk?.allowed === true && flags?.dryRun === true) {
      return "PAPER_TRADE";
    }
    return "NO_TRADE";
  }

  private fallbackSettlement(
    market: NormalizedMarketSnapshot,
  ): SettlementSpec {
    return {
      provider: market?.provider ?? "unknown",
      marketId: market?.marketId ?? "",
      eventId: market?.eventId ?? "",
      marketType: "UNKNOWN",
      ruleConfidence: 0,
      settlementIndexName: null,
      settlementMechanic: "UNKNOWN",
      canTrade: false,
      blockedBy: ["SETTLEMENT_SPEC_THREW"],
      rawRules: { error: "buildSettlementSpec threw" },
    };
  }

  private fallbackFairValue(): FairValueResult {
    return {
      fairYesBase: null,
      fairNoBase: null,
      fairYesTilted: null,
      fairNoTilted: null,
      zScore: null,
      expectedMoveUsd: null,
      distanceToTarget: null,
      edgeYesGross: null,
      edgeNoGross: null,
      edgeYesNet: null,
      edgeNoNet: null,
      confidenceScore: 0,
      reasonCodes: ["FAIR_STEP_THREW"],
    };
  }

  private nullBtcContext(): BtcContextSnapshot {
    return {
      timestamp: new Date().toISOString(),
      btcCexPriceNow: null,
      dataAgeMs: Number.POSITIVE_INFINITY,
      rawSources: { reason: "BTC_CONTEXT_STEP_THREW", secondaryOnly: true },
    };
  }
}
