// Paper trader. Builds a PaperTrade record from a StrategyDecision WITHOUT ever
// touching the live order path. There is NO call to client.createOrder anywhere
// in this module — paper trades are pure bookkeeping derived from already-
// computed pricing/cost/risk outputs.
//
// The effective fill price comes from the cost model (the real price we'd pay
// crossing ask liquidity, never the mid). The fair price and net edge are taken
// for the chosen side. Fail-safe: never throws.

import type {
  AblationVariant,
  PaperTrade,
  StrategyDecision,
} from "../jupiter_prediction/models";

export interface MakePaperTradeInput {
  decision: StrategyDecision;
  variant: AblationVariant;
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/**
 * Construct a PaperTrade from a decision. The side is taken from the risk
 * decision; when risk did not select a side we fall back to "YES" but still
 * mark the trade with the reason codes carried by the decision. Effective fill
 * price and net edge are pulled for the chosen side from the cost/fair outputs.
 *
 * NEVER sends a real order — this is research bookkeeping only.
 */
export function makePaperTrade(input: MakePaperTradeInput): PaperTrade {
  const decision = input?.decision;
  const variant: AblationVariant = input?.variant ?? "base_only";

  const risk = decision?.risk;
  const cost = decision?.cost;
  const fair = decision?.fairValue;
  const market = decision?.market;
  const settlement = decision?.settlement;
  const settlementIndex = decision?.settlementIndex;
  const basis = decision?.basis;
  const vol = decision?.vol;
  const latency = decision?.latency;

  // Side: prefer the risk-selected side; fall back to YES for a record.
  const side: "YES" | "NO" =
    risk?.side === "NO" ? "NO" : risk?.side === "YES" ? "YES" : "YES";

  // Effective fill price for the chosen side (cost model, never mid).
  const effRaw =
    side === "YES" ? cost?.effectiveBuyYesPrice : cost?.effectiveBuyNoPrice;
  const effectiveFillPrice = isFiniteNumber(effRaw) ? effRaw : 0;

  // Fair (tilted) price for the chosen side.
  const fairRaw =
    side === "YES" ? fair?.fairYesTilted : fair?.fairNoTilted;
  const fairPriceAtDecision = isFiniteNumber(fairRaw) ? fairRaw : 0;

  // Net edge for the chosen side (cost-model net edge).
  const edgeRaw = side === "YES" ? fair?.edgeYesNet : fair?.edgeNoNet;
  const edgeNet = isFiniteNumber(edgeRaw) ? edgeRaw : 0;

  const sizeUsd = isFiniteNumber(risk?.sizeUsd) ? (risk!.sizeUsd as number) : 0;

  // Aggregate reason codes from the decision for auditability.
  const reasonCodes: string[] = [];
  const pushCodes = (codes: unknown) => {
    if (Array.isArray(codes)) {
      for (const c of codes) {
        if (typeof c === "string" && c.length > 0 && !reasonCodes.includes(c)) {
          reasonCodes.push(c);
        }
      }
    }
  };
  pushCodes(risk?.blockedBy);
  pushCodes(fair?.reasonCodes);
  pushCodes(cost?.reasonCodes);

  const trade: PaperTrade = {
    timestamp: new Date().toISOString(),
    marketId: market?.marketId ?? settlement?.marketId ?? "",
    provider: market?.provider ?? settlement?.provider ?? "unknown",
    side,
    sizeUsd,
    effectiveFillPrice,
    fairPriceAtDecision,
    edgeNet,
    timeLeftSeconds: isFiniteNumber(market?.timeLeftSeconds)
      ? (market!.timeLeftSeconds as number)
      : null,
    settlementIndexPrice: isFiniteNumber(settlementIndex?.indexPrice)
      ? (settlementIndex!.indexPrice as number)
      : null,
    targetPrice: isFiniteNumber(settlement?.targetPrice)
      ? (settlement!.targetPrice as number)
      : null,
    volRegime: vol?.regime ?? "DATA_STALE",
    basisBps: isFiniteNumber(basis?.basisBps)
      ? (basis!.basisBps as number)
      : null,
    latencyP95: isFiniteNumber(latency?.p95) ? (latency!.p95 as number) : 0,
    variant,
    reasonCodes,
    outcome: null,
    realizedPnlUsd: null,
  };

  return trade;
}

/**
 * Records paper trades in-memory and (optionally) to an injected logger.
 * The logger only needs a `write(o)` method (e.g. JsonlLogger). NEVER places
 * live orders.
 */
export class PaperTrader {
  private readonly logger?: { write(o: unknown): void };
  private readonly recorded: PaperTrade[] = [];

  constructor(logger?: { write(o: unknown): void }) {
    this.logger = logger;
  }

  /** Record a paper trade. Logging failures never crash the caller. */
  record(trade: PaperTrade): void {
    if (!trade || typeof trade !== "object") return;
    this.recorded.push(trade);
    try {
      this.logger?.write(trade);
    } catch {
      // never throw on logging
    }
  }

  /** A copy of all recorded paper trades. */
  trades(): PaperTrade[] {
    return this.recorded.slice();
  }
}
