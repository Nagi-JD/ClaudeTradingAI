// Market normalizer: turns a raw (event, market) pair from the Jupiter
// Prediction BETA API — which proxies Polymarket / Kalshi style payloads — into
// a stable NormalizedMarketSnapshot.
//
// PURE + DEFENSIVE: never throws. Missing/unparseable fields become `undefined`
// (or `null` for timeLeftSeconds). Tolerates the field-name variants seen
// across providers (e.g. buyYesPriceUsd vs prices[] vs yesPrice).

import type {
  NormalizedMarketSnapshot,
  VenueProvider,
} from "./models";

// ────────────────────────────────────────────────────────────── helpers ──

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function num(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

// Jupiter pricing is micro-USD: 1_000_000 units = $1.00 (e.g. 650000 = $0.65).
function micro(v: unknown): number | undefined {
  const n = num(v);
  return n === undefined ? undefined : n / 1e6;
}

function str(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

function bool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "1" || s === "active" || s === "open") return true;
    if (s === "false" || s === "0" || s === "closed" || s === "resolved")
      return false;
  }
  if (typeof v === "number") return v !== 0;
  return undefined;
}

// Pick the first defined value from a list of candidate keys.
function pick(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (k in obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

// Normalize a probability/price into [0,1] USD-per-contract terms. Some
// providers express prices as cents (0-100) or percentages; treat >1.5 as cents.
function normPrice(v: unknown): number | undefined {
  const n = num(v);
  if (n === undefined) return undefined;
  if (n < 0) return undefined;
  if (n > 1.5) return n / 100; // cents → dollars
  return n;
}

// Convert various time representations to an ISO string when possible.
function toIso(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number" && Number.isFinite(v)) {
    // Heuristic: <1e12 looks like seconds, else milliseconds.
    const ms = v < 1e12 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  if (typeof v === "string" && v.trim() !== "") {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    // Maybe a numeric epoch encoded as a string.
    const epoch = Number(v);
    if (Number.isFinite(epoch)) return toIso(epoch);
  }
  return undefined;
}

function isoToMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
}

// Extract YES/NO prices from a Polymarket-style `prices`/`outcomePrices` array.
// Arrays are typically [yes, no] or [{outcome, price}, ...].
function pricesFromArray(
  v: unknown,
): { yes?: number; no?: number } {
  if (!Array.isArray(v)) return {};
  // Array of scalars: [yes, no]
  if (v.every((x) => typeof x === "number" || typeof x === "string")) {
    return { yes: normPrice(v[0]), no: normPrice(v[1]) };
  }
  // Array of objects with outcome labels.
  let yes: number | undefined;
  let no: number | undefined;
  for (const item of v) {
    const rec = asRecord(item);
    const outcome = (str(pick(rec, ["outcome", "name", "label", "side"])) ?? "")
      .trim()
      .toLowerCase();
    const price = normPrice(pick(rec, ["price", "value", "prob", "probability"]));
    if (outcome === "yes" || outcome === "up" || outcome === "above") yes = price;
    else if (outcome === "no" || outcome === "down" || outcome === "below")
      no = price;
  }
  return { yes, no };
}

// ──────────────────────────────────────────────────────────── main API ──

export function normalizeMarket(
  rawEvent: unknown,
  rawMarket: unknown,
  provider: VenueProvider,
): NormalizedMarketSnapshot {
  const ev = asRecord(rawEvent);
  const mk = asRecord(rawMarket);
  const nowIso = new Date().toISOString();

  const eventId =
    str(pick(ev, ["eventId", "event_id", "id", "slug", "ticker"])) ?? "";
  const marketId =
    str(
      pick(mk, [
        "marketId",
        "market_id",
        "id",
        "conditionId",
        "condition_id",
        "ticker",
        "slug",
      ]),
    ) ?? "";

  const eventTitle =
    str(pick(ev, ["title", "name", "question", "eventTitle"])) ?? "";
  const marketTitle =
    str(
      pick(mk, ["title", "name", "question", "marketTitle", "groupItemTitle"]),
    ) ?? eventTitle;

  const category = str(pick(ev, ["category", "tag", "tags"])) ??
    str(pick(mk, ["category"]));
  const status = str(pick(mk, ["status", "state"])) ?? str(pick(ev, ["status"]));

  // ── time fields ──
  const openTime = toIso(
    pick(mk, ["openTime", "open_time", "startTime", "start_time", "startDate"]) ??
      pick(ev, ["startTime", "startDate", "openTime"]),
  );
  const closeTime = toIso(
    pick(mk, [
      "closeTime",
      "close_time",
      "endTime",
      "end_time",
      "endDate",
      "expiration",
      "expirationTime",
      "expiry",
    ]) ?? pick(ev, ["closeTime", "endTime", "endDate", "expiration"]),
  );
  const resolveAt = toIso(
    pick(mk, [
      "resolveAt",
      "resolve_at",
      "resolutionTime",
      "resolution_time",
      "settleTime",
    ]),
  );

  const closeMs = isoToMs(closeTime);
  const timeLeftSeconds =
    closeMs !== undefined ? Math.round((closeMs - Date.now()) / 1000) : null;

  // ── activity flags ──
  const isActive =
    bool(pick(mk, ["isActive", "active", "is_active"])) ??
    (status ? status.toLowerCase() === "active" || status.toLowerCase() === "open" : false);
  const isLive =
    bool(pick(mk, ["isLive", "live", "is_live", "accepting_orders", "acceptingOrders"])) ??
    (isActive && (timeLeftSeconds === null || timeLeftSeconds > 0));

  // ── prices ──
  const arrPrices = pricesFromArray(
    pick(mk, ["prices", "outcomePrices", "outcome_prices"]),
  );

  // Real Jupiter shape nests micro-USD prices under `pricing`. Prefer that,
  // then fall back to flat/legacy field-name variants, then array prices.
  const pricing = asRecord(pick(mk, ["pricing"]));

  const buyYesPriceUsd =
    micro(pricing["buyYesPriceUsd"]) ??
    normPrice(
      pick(mk, [
        "buyYesPriceUsd",
        "buyYesPrice",
        "yesPrice",
        "yes_price",
        "bestAskYes",
        "askYes",
      ]),
    ) ??
    arrPrices.yes;
  const buyNoPriceUsd =
    micro(pricing["buyNoPriceUsd"]) ??
    normPrice(
      pick(mk, [
        "buyNoPriceUsd",
        "buyNoPrice",
        "noPrice",
        "no_price",
        "bestAskNo",
        "askNo",
      ]),
    ) ??
    arrPrices.no;
  const sellYesPriceUsd =
    micro(pricing["sellYesPriceUsd"]) ??
    normPrice(
      pick(mk, ["sellYesPriceUsd", "sellYesPrice", "bidYes", "bestBidYes"]),
    );
  const sellNoPriceUsd =
    micro(pricing["sellNoPriceUsd"]) ??
    normPrice(pick(mk, ["sellNoPriceUsd", "sellNoPrice", "bidNo", "bestBidNo"]));

  const yesBid = normPrice(pick(mk, ["yesBid", "yes_bid", "bidYes"]));
  const yesAsk = normPrice(pick(mk, ["yesAsk", "yes_ask", "askYes"]));
  const noBid = normPrice(pick(mk, ["noBid", "no_bid", "bidNo"]));
  const noAsk = normPrice(pick(mk, ["noAsk", "no_ask", "askNo"]));

  // ── volume ──
  const volume =
    num(pricing["volume"]) ?? num(pick(mk, ["volume", "volume24h", "vol"]));
  const volumeUsd = num(
    pick(mk, ["volumeUsd", "volume_usd", "volumeUSD", "volumeNum"]),
  );

  // ── settlement rule text ──
  const rulesPrimary = str(
    pick(mk, ["rules", "rulesPrimary", "description", "resolutionSource"]) ??
      pick(ev, ["rules", "description"]),
  );
  const rulesSecondary = str(
    pick(mk, ["rulesSecondary", "longDescription", "additionalRules", "notes"]),
  );

  const clobTokenIds = pick(mk, [
    "clobTokenIds",
    "clob_token_ids",
    "tokenIds",
    "token_ids",
  ]);
  const marketResultPubkey = str(
    pick(mk, [
      "marketResultPubkey",
      "market_result_pubkey",
      "resultPubkey",
      "resultAccount",
    ]),
  );

  return {
    timestamp: nowIso,
    provider,
    eventId,
    marketId,
    eventTitle,
    marketTitle,
    category,
    status,
    isActive,
    isLive,
    openTime,
    closeTime,
    resolveAt,
    timeLeftSeconds,
    buyYesPriceUsd,
    buyNoPriceUsd,
    sellYesPriceUsd,
    sellNoPriceUsd,
    yesBid,
    yesAsk,
    noBid,
    noAsk,
    volume,
    volumeUsd,
    rulesPrimary,
    rulesSecondary,
    clobTokenIds,
    marketResultPubkey,
    rawPayload: { event: rawEvent, market: rawMarket },
  };
}
