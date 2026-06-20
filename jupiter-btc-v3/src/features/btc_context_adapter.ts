// BTC context adapter — orchestrates the secondary CEX / order-flow features.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ SECONDARY SIGNAL ONLY — READ THIS.                                     │
// │                                                                        │
// │ Everything produced here (CVD, liquidations, momentum, CEX price) is   │
// │ AUXILIARY market-microstructure context. It MUST NEVER be used as the  │
// │ primary settlement price for any prediction market. The authoritative  │
// │ price always comes from settlement/settlement_index_adapter. This      │
// │ snapshot only feeds the optional, ablatable microstructure tilt and    │
// │ basis monitoring. On ANY failure we degrade to an all-null snapshot.   │
// └──────────────────────────────────────────────────────────────────────┘
//
// This adapter cannot import the user's existing MoonDev Python scripts, so it
// implements a clean HTTP adapter against a MoonDev-style API. The endpoints
// live behind small, clearly-commented functions below so the user can point
// them at their real scripts / services later. If MOONDEV_API_KEY is not
// provided, or any fetch fails, we return an all-null snapshot gracefully and
// NEVER throw.

import type { BtcContextSnapshot } from "../jupiter_prediction/models";
import { computeCvdFeatures } from "./cvd_features";
import { computeLiquidationFeatures } from "./liquidation_features";
import { computeMomentumFeatures } from "./momentum_features";

// ─────────────────────────────────────────────────────────── constants ──

/**
 * Base URL for the MoonDev-style HTTP API. Override via env var
 * MOONDEV_API_BASE if the user runs their scripts behind a custom service.
 * Point this at your real endpoint(s) when wiring up the existing scripts.
 */
const MOONDEV_API_BASE =
  process.env.MOONDEV_API_BASE ?? "https://api.moondev.local";

/** Per-request timeout. Kept short — this is a secondary, non-blocking signal. */
const FETCH_TIMEOUT_MS = 4000;

// ───────────────────────────────────────────────────────────── helpers ──

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Build an all-null BtcContextSnapshot. Every optional numeric feature is left
 * undefined; btcCexPriceNow is null; dataAgeMs is Infinity to signal "do not
 * trust". `rawSources.reason` documents WHY this is empty.
 */
function nullSnapshot(reason: string): BtcContextSnapshot {
  return {
    timestamp: nowIso(),
    btcCexPriceNow: null,
    dataAgeMs: Number.POSITIVE_INFINITY,
    rawSources: { reason, secondaryOnly: true },
  };
}

/** Index helper: treat unknown as an indexable record. */
function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Single defensive GET against the MoonDev-style API. Returns parsed JSON or
 * null on ANY failure (no key handling here — caller gates on key). Never throws.
 *
 * NOTE: This is intentionally a thin, replaceable wrapper. To wire the user's
 * real scripts, change the URL construction / response parsing here only.
 */
async function safeGet(
  path: string,
  apiKey: string,
): Promise<unknown | null> {
  try {
    const url = `${MOONDEV_API_BASE}${path}`;
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res || !res.ok) return null;
    return await res.json();
  } catch {
    // Network error, timeout, abort, JSON parse error → fail-safe null.
    return null;
  }
}

// ─────────────────────────────────────── MoonDev-style endpoint fetchers ──
// Each fetcher hits one logical feed and returns the raw payload (or null). The
// raw shapes flow straight into the pure feature computers, which are liberal
// about field names. Re-point these paths at your real scripts/endpoints.

/** Order-flow / CVD feed (e.g. aggregated taker buy/sell trades). */
async function fetchCvdRaw(apiKey: string): Promise<unknown | null> {
  return safeGet("/btc/cvd", apiKey);
}

/** Liquidation feed (volumes + near-price liquidation heatmap). */
async function fetchLiquidationRaw(apiKey: string): Promise<unknown | null> {
  return safeGet("/btc/liquidations", apiKey);
}

/** Price/momentum feed (recent price series + spot mark). */
async function fetchMomentumRaw(apiKey: string): Promise<unknown | null> {
  return safeGet("/btc/momentum", apiKey);
}

// ───────────────────────────────────────────────────────────── adapter ──

/**
 * Fetch the secondary BTC market-context snapshot.
 *
 * Behavior:
 *  - No API key (opts.moondevApiKey falsy / no MOONDEV_API_KEY env) →
 *    all-null snapshot, dataAgeMs=Infinity, reason="NO_API_KEY". Never throws.
 *  - Key present → fetches the three feeds in parallel, computes partials via
 *    the pure feature functions, merges them, stamps timestamp + dataAgeMs.
 *  - If ALL fetches fail → all-null snapshot, reason="ALL_FETCHES_FAILED".
 *  - If SOME succeed → partial snapshot with whatever was derivable; dataAgeMs
 *    reflects wall-clock fetch latency.
 *  - Any unexpected error anywhere → all-null snapshot, reason="ADAPTER_ERROR".
 *
 * IMPORTANT: never used as a primary settlement price (see header banner).
 */
export async function fetchBtcContext(opts: {
  moondevApiKey?: string;
}): Promise<BtcContextSnapshot> {
  try {
    const apiKey = opts?.moondevApiKey ?? process.env.MOONDEV_API_KEY ?? "";
    if (!apiKey) {
      return nullSnapshot("NO_API_KEY");
    }

    const startMs = Date.now();

    // Fetch all three feeds concurrently; each resolves to payload-or-null.
    const [cvdRaw, liqRaw, momRaw] = await Promise.all([
      fetchCvdRaw(apiKey),
      fetchLiquidationRaw(apiKey),
      fetchMomentumRaw(apiKey),
    ]);

    if (cvdRaw === null && liqRaw === null && momRaw === null) {
      return nullSnapshot("ALL_FETCHES_FAILED");
    }

    const fetchLatencyMs = Date.now() - startMs;

    // Compute each partial defensively (these never throw).
    const cvdPartial = computeCvdFeatures(cvdRaw ?? {});
    const liqPartial = computeLiquidationFeatures(liqRaw ?? {});
    const momPartial = computeMomentumFeatures(momRaw ?? {});

    // Best-effort spot mark for basis/banding. Prefer the momentum feed, then
    // any feed that carries a price. This is context only — NOT settlement.
    const btcCexPriceNow =
      num(asRecord(momRaw).btcCexPriceNow) ??
      num(asRecord(momRaw).price) ??
      num(asRecord(momRaw).priceNow) ??
      num(asRecord(cvdRaw).price) ??
      num(asRecord(liqRaw).price) ??
      null;

    const snapshot: BtcContextSnapshot = {
      timestamp: nowIso(),
      btcCexPriceNow,
      dataAgeMs: Number.isFinite(fetchLatencyMs)
        ? fetchLatencyMs
        : Number.POSITIVE_INFINITY,
      ...cvdPartial,
      ...liqPartial,
      ...momPartial,
      rawSources: {
        secondaryOnly: true,
        fetched: {
          cvd: cvdRaw !== null,
          liquidations: liqRaw !== null,
          momentum: momRaw !== null,
        },
        cvd: cvdRaw ?? null,
        liquidations: liqRaw ?? null,
        momentum: momRaw ?? null,
      },
    };

    return snapshot;
  } catch {
    // Absolute fail-safe: any unexpected throw collapses to an all-null snapshot.
    return nullSnapshot("ADAPTER_ERROR");
  }
}
