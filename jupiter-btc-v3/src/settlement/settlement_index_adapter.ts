// Settlement index adapter: fetches the EXACT price index a market settles on.
//
// CRITICAL: This system is settlement-index-aware. We must NOT settle/price a
// market against a CEX (Binance/Coinbase) price when the market actually
// resolves against a specific oracle/index. Doing so silently would produce
// confident-but-wrong fair values. Therefore:
//
//   * Polymarket settles via its own resolution (frequently a UMA optimistic
//     oracle, or a manually specified data source). There is NO generic
//     programmatic "Polymarket BTC index" endpoint we can trust here — mapping
//     a given market to its exact resolution source is GENUINELY MANUAL.
//   * Kalshi settles against named indices (e.g. its own reference series). The
//     exact market-id → index-series mapping is GENUINELY MANUAL and not
//     auto-discoverable from the market payload.
//
// So both provider stubs intentionally return confidence 0 + a block
// (SETTLEMENT_INDEX_UNKNOWN) via blockedIndexSnapshot(). The ONLY non-blocked
// path is an explicit research fallback (opts.allowCexResearchFallback) which
// uses opts.btcContextPrice at LOW confidence — clearly flagged as research,
// never as a true settlement value.

import type {
  SettlementSpec,
  SettlementIndexSnapshot,
  VenueProvider,
} from "../jupiter_prediction/models";
import { blockedIndexSnapshot } from "../jupiter_prediction/models";
import { getLatestPyth } from "../pricing/proxy_index";

export interface FetchSettlementIndexOpts {
  allowCexResearchFallback: boolean;
  btcContextPrice?: number | null;
  /**
   * Research proxy: when the exact settlement stream is not wired, use the
   * free Pyth BTC/USD feed as a LOW-confidence proxy index. Rules-driven — the
   * snapshot annotates the TRUE parsed settlement source and is never presented
   * as settlement-grade.
   */
  allowProxyIndex?: boolean;
  /** Max age (ms) of the latest proxy observation before it is treated stale. */
  proxyMaxAgeMs?: number;
}

// Deliberately LOW — a proxy is never settlement-grade.
const PROXY_INDEX_CONFIDENCE = (() => {
  const v = Number(process.env.PROXY_INDEX_CONFIDENCE);
  return Number.isFinite(v) && v > 0 && v < 1 ? v : 0.3;
})();

// ─────────────────────────────────────────── in-memory tick buffer ──

const MAX_TICKS_PER_MARKET = 2000;
const tickBuffers = new Map<string, { t: number; price: number }[]>();

/** Record a settlement-index tick into the rolling per-market buffer. */
export function recordIndexTick(
  marketId: string,
  price: number,
  t?: number,
): void {
  try {
    if (typeof marketId !== "string" || marketId.length === 0) return;
    if (typeof price !== "number" || !Number.isFinite(price)) return;
    const ts = typeof t === "number" && Number.isFinite(t) ? t : Date.now();

    let buf = tickBuffers.get(marketId);
    if (!buf) {
      buf = [];
      tickBuffers.set(marketId, buf);
    }
    buf.push({ t: ts, price });
    // Cap the rolling buffer (drop oldest).
    if (buf.length > MAX_TICKS_PER_MARKET) {
      buf.splice(0, buf.length - MAX_TICKS_PER_MARKET);
    }
  } catch {
    // never throw in a hot path
  }
}

/** Read a copy of the recorded ticks for a market (oldest → newest). */
export function getIndexTicks(
  marketId: string,
): { t: number; price: number }[] {
  const buf = tickBuffers.get(marketId);
  return buf ? buf.slice() : [];
}

// ─────────────────────────────────────────────── provider stubs ──

/**
 * Polymarket: exact resolution-source mapping is MANUAL (often UMA optimistic
 * oracle). We do not have a trustworthy programmatic index endpoint here, so we
 * block. Wiring a real Polymarket oracle reader is a deliberate future task.
 */
async function fetchPolymarketIndex(
  spec: SettlementSpec,
): Promise<SettlementIndexSnapshot> {
  return blockedIndexSnapshot(
    "polymarket",
    spec.marketId,
    "POLYMARKET_ORACLE_MAPPING_MANUAL: exact resolution source (e.g. UMA) not " +
      "auto-resolvable from market payload — SETTLEMENT_INDEX_UNKNOWN",
  );
}

/**
 * Kalshi: settles against a named reference series. The market-id → series
 * mapping is MANUAL and not derivable from the payload alone, so we block.
 */
async function fetchKalshiIndex(
  spec: SettlementSpec,
): Promise<SettlementIndexSnapshot> {
  return blockedIndexSnapshot(
    "kalshi",
    spec.marketId,
    "KALSHI_INDEX_MAPPING_MANUAL: market→settlement-series mapping not " +
      "auto-resolvable from market payload — SETTLEMENT_INDEX_UNKNOWN",
  );
}

function fetchUnknownProvider(
  spec: SettlementSpec,
): SettlementIndexSnapshot {
  return blockedIndexSnapshot(
    "unknown",
    spec.marketId,
    "PROVIDER_UNKNOWN: cannot select a settlement index",
  );
}

/**
 * CEX research fallback — ONLY reached when allowCexResearchFallback is true.
 * This is explicitly NOT a true settlement price; it is a research proxy using
 * the BTC context price, returned at deliberately LOW confidence and flagged.
 */
function cexResearchFallback(
  spec: SettlementSpec,
  btcContextPrice: number | null | undefined,
): SettlementIndexSnapshot {
  if (
    typeof btcContextPrice !== "number" ||
    !Number.isFinite(btcContextPrice) ||
    btcContextPrice <= 0
  ) {
    return blockedIndexSnapshot(
      spec.provider,
      spec.marketId,
      "CEX_RESEARCH_FALLBACK_NO_PRICE: no usable btcContextPrice",
    );
  }
  return {
    provider: spec.provider,
    marketId: spec.marketId,
    indexName: spec.settlementIndexName
      ? `${spec.settlementIndexName} (CEX_RESEARCH_PROXY)`
      : "CEX_RESEARCH_PROXY",
    indexPrice: btcContextPrice,
    timestamp: new Date().toISOString(),
    dataAgeMs: 0,
    // Deliberately low — this is research, not a real settlement index.
    confidence: 0.2,
    rawPayload: {
      source: "CEX_RESEARCH_FALLBACK",
      note:
        "NOT a true settlement index — research proxy from btcContextPrice. " +
        "Do not treat as settlement-grade.",
      btcContextPrice,
    },
  };
}

/**
 * Pyth proxy index — RESEARCH ONLY. Returns the latest free Pyth BTC/USD as a
 * LOW-confidence proxy when the true settlement stream is unavailable. The
 * indexName records the TRUE parsed settlement source so it is never confused
 * with a settlement-grade read. Returns null when no fresh proxy is available
 * (caller then blocks).
 */
function pythProxyIndex(
  spec: SettlementSpec,
  proxyMaxAgeMs: number | undefined,
): SettlementIndexSnapshot | null {
  const q = getLatestPyth();
  if (!q || !(q.price > 0)) return null;
  // Staleness is measured on OUR observation time, not Pyth's publish time.
  const ageMs = Date.now() - q.tMs;
  const maxAge = Number.isFinite(proxyMaxAgeMs as number)
    ? (proxyMaxAgeMs as number)
    : 10000;
  if (ageMs > maxAge) return null;
  const trueSrc = spec.settlementIndexName ?? "UNKNOWN_SETTLEMENT_SOURCE";
  return {
    provider: spec.provider,
    marketId: spec.marketId,
    indexName: `${trueSrc} (PYTH_PROXY)`,
    indexPrice: q.price,
    timestamp: new Date(q.tMs).toISOString(),
    dataAgeMs: Math.max(0, ageMs),
    confidence: PROXY_INDEX_CONFIDENCE,
    rawPayload: {
      source: "PYTH_PROXY",
      note:
        "Research proxy for the true settlement source — NOT settlement-grade. " +
        "Pyth BTC/USD via Hermes, low confidence.",
      trueSettlementSource: trueSrc,
      pythConfUsd: q.confUsd,
      pythPublishMs: q.publishMs,
    },
  };
}

// ─────────────────────────────────────────────────── entrypoint ──

export async function fetchSettlementIndex(
  spec: SettlementSpec,
  opts: FetchSettlementIndexOpts,
): Promise<SettlementIndexSnapshot> {
  try {
    const provider: VenueProvider = spec?.provider ?? "unknown";
    const marketId = spec?.marketId ?? "";

    // If the settlement layer already could not identify the index name and the
    // provider is unknown, try the proxy (research) before blocking.
    if (provider === "unknown") {
      if (opts?.allowProxyIndex) {
        const proxy = pythProxyIndex({ ...spec, provider, marketId }, opts.proxyMaxAgeMs);
        if (proxy) return proxy;
      }
      if (opts?.allowCexResearchFallback) {
        return cexResearchFallback(
          { ...spec, provider, marketId },
          opts.btcContextPrice,
        );
      }
      return fetchUnknownProvider({ ...spec, provider, marketId });
    }

    // Attempt the provider-specific (manual / stubbed) index lookup.
    let snapshot: SettlementIndexSnapshot;
    if (provider === "polymarket") {
      snapshot = await fetchPolymarketIndex(spec);
    } else if (provider === "kalshi") {
      snapshot = await fetchKalshiIndex(spec);
    } else {
      snapshot = fetchUnknownProvider(spec);
    }

    const stubBlocked =
      snapshot.indexPrice === null || snapshot.confidence <= 0;

    // Provider stub blocked (no exact index). Prefer the LOW-confidence Pyth
    // proxy when enabled (rules-driven, true source annotated), then the CEX
    // research fallback. Never silently present a proxy as settlement-grade.
    if (stubBlocked && opts?.allowProxyIndex) {
      const proxy = pythProxyIndex(spec, opts.proxyMaxAgeMs);
      if (proxy) return proxy;
    }
    if (stubBlocked && opts?.allowCexResearchFallback) {
      return cexResearchFallback(spec, opts.btcContextPrice);
    }

    return snapshot;
  } catch (err) {
    // Defensive: any unexpected error → blocked snapshot, never throw.
    return blockedIndexSnapshot(
      spec?.provider ?? "unknown",
      spec?.marketId ?? "",
      `SETTLEMENT_INDEX_FETCH_ERROR:${String(err)}`,
    );
  }
}
