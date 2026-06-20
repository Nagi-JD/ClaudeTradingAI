// BTC market discovery.
//
// The Jupiter `/events` listing does NOT surface the ephemeral "Bitcoin Up or
// Down" 5-minute binary markets (it returns curated/featured events, mostly
// sports). Those high-frequency BTC markets are only discoverable from the live
// trade stream, exactly like the user's tradetap/discover-watch daemons do:
//
//   1. GET /trades          → recent trades; filter eventTitle for BTC up/down
//   2. dedupe marketIds      → the currently-active BTC markets
//   3. GET /markets/{id}     → full market detail (status, pricing micro-USD,
//                              closeTime, rules, provider, marketResultPubkey)
//   4. normalizeMarket(...)  → NormalizedMarketSnapshot
//
// A secondary /events?category=crypto pass is kept as a best-effort supplement
// for any longer-dated BTC markets that DO appear there.
//
// DEFENSIVE: tolerates every payload shape; the client already folds transport
// errors / 429s into ok:false, so this just merges what it can. Never throws.

import type { Config } from "../config/load_config";
import type { NormalizedMarketSnapshot } from "./models";
import { JupiterPredictionClient } from "./client";
import { normalizeMarket } from "./normalizer";
import { identifyProvider } from "../venues/venue_registry";

// ────────────────────────────────────────────────────────────── helpers ──

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function toArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    for (const key of ["data", "events", "results", "items", "markets", "trades"]) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }
  return [];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// "Bitcoin Up or Down" + any plain BTC reference.
const BTC_RE = /\b(btc|bitcoin|xbt)\b/i;
const UPDOWN_RE = /up or down/i;

function looksBtc(...texts: string[]): boolean {
  return texts.some((t) => BTC_RE.test(t) || UPDOWN_RE.test(t));
}

function safeIdentify(raw: unknown): NormalizedMarketSnapshot["provider"] {
  try {
    return identifyProvider(raw);
  } catch {
    return "unknown";
  }
}

// ──────────────────────────────────────────────────────────── main API ──

export async function discoverBtcMarkets(
  client: JupiterPredictionClient,
  config: Config,
): Promise<NormalizedMarketSnapshot[]> {
  const out: NormalizedMarketSnapshot[] = [];
  const seenMarketIds = new Set<string>();

  // ── 1+2. discover active BTC marketIds from the live trade stream ────────
  const wanted: { marketId: string; eventId: string; eventTitle: string }[] = [];
  try {
    const tr = await client.getTrades({});
    if (tr.ok) {
      for (const raw of toArray(tr.data ?? tr.raw)) {
        const t = asRecord(raw);
        const marketId = str(t["marketId"] ?? t["market_id"]);
        const eventTitle = str(t["eventTitle"] ?? t["event_title"]);
        if (!marketId || !looksBtc(eventTitle)) continue;
        if (seenMarketIds.has(marketId)) continue;
        seenMarketIds.add(marketId);
        wanted.push({
          marketId,
          eventId: str(t["eventId"] ?? t["event_id"]),
          eventTitle,
        });
      }
    }
  } catch {
    // fail safe
  }

  // ── 3+4. fetch market detail for each + normalize ───────────────────────
  for (const w of wanted) {
    try {
      const md = await client.getMarketDetails(w.eventId, w.marketId);
      if (!md.ok) continue;
      const market = asRecord(md.data ?? md.raw);
      if (Object.keys(market).length === 0) continue;
      const provider = safeIdentify(market);
      const snap = normalizeMarket(
        { eventId: w.eventId, title: w.eventTitle },
        market,
        provider,
      );
      if (keepByDuration(snap, config)) out.push(snap);
    } catch {
      // fail safe — one bad market never aborts discovery
    }
  }

  // ── secondary: best-effort /events?category=crypto with nested markets ──
  try {
    const ev = await client.getEvents({
      category: config?.jupiter?.category ?? "crypto",
      filter: "live",
      includeMarkets: true,
    });
    if (ev.ok) {
      for (const rawEvent of toArray(ev.data ?? ev.raw)) {
        const event = asRecord(rawEvent);
        const eventTitle = str(event["title"] ?? event["name"]);
        const markets = Array.isArray(event["markets"])
          ? (event["markets"] as unknown[])
          : [];
        for (const rawMarket of markets) {
          const mk = asRecord(rawMarket);
          const marketId = str(mk["marketId"] ?? mk["id"]);
          const marketTitle = str(mk["title"] ?? mk["name"]);
          if (!marketId || seenMarketIds.has(marketId)) continue;
          if (!looksBtc(eventTitle, marketTitle)) continue;
          seenMarketIds.add(marketId);
          try {
            const provider = safeIdentify(mk);
            const snap = normalizeMarket(rawEvent, rawMarket, provider);
            if (keepByDuration(snap, config)) out.push(snap);
          } catch {
            // fail safe
          }
        }
      }
    }
  } catch {
    // fail safe — secondary pass is purely supplemental
  }

  return out;
}

// Short-duration filter where detectable. Unknown time-left (null) is KEPT —
// better to surface a market than to silently drop it.
function keepByDuration(
  snap: NormalizedMarketSnapshot,
  config: Config,
): boolean {
  const maxTimeLeft = config?.risk?.maxTimeLeftSeconds;
  if (
    typeof maxTimeLeft === "number" &&
    Number.isFinite(maxTimeLeft) &&
    snap.timeLeftSeconds !== null &&
    snap.timeLeftSeconds > maxTimeLeft
  ) {
    return false;
  }
  return true;
}
