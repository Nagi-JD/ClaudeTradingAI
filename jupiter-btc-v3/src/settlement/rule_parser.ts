// Settlement rule parser: best-effort extraction of WHAT a market settles on
// (target price, start price, settlement index, point-in-time vs window) from
// titles + free-text rules. Pure + defensive — never throws. When anything is
// unclear it returns LOW confidence and explicit blockedBy codes so the caller
// can refuse to trade rather than guessing.

import type {
  VenueProvider,
  MarketType,
  SettlementMechanic,
} from "../jupiter_prediction/models";

export interface ParsedRules {
  provider: VenueProvider;
  marketType: MarketType;
  targetPrice?: number;
  startPrice?: number;
  closeTime?: string;
  resolveAt?: string;
  settlementIndexName: string | null;
  settlementMechanic: SettlementMechanic;
  confidence: number;
  blockedBy: string[];
  raw: unknown;
}

export interface ParseSettlementRulesInput {
  eventTitle: string;
  marketTitle: string;
  rulesPrimary?: string;
  rulesSecondary?: string;
  provider: VenueProvider;
  rawMarket: unknown;
}

// ──────────────────────────────────────────────────────────── helpers ──

function safeStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Parse a "$68,000.50" / "68000" style money token to a number. */
function parseMoneyToken(token: string): number | undefined {
  const cleaned = token.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d+)?[kKmM]?$/.test(cleaned)) return undefined;
  const mult = /[kK]$/.test(cleaned) ? 1_000 : /[mM]$/.test(cleaned) ? 1_000_000 : 1;
  const num = parseFloat(cleaned.replace(/[kKmM]$/, ""));
  if (!Number.isFinite(num)) return undefined;
  const val = num * mult;
  return val > 0 ? val : undefined;
}

/** Extract the first plausible price target from free text. */
function extractPrice(text: string): number | undefined {
  if (!text) return undefined;
  // Prefer explicit dollar amounts.
  const dollarMatches = text.match(/\$\s?\d[\d,]*(?:\.\d+)?\s?[kKmM]?/g);
  if (dollarMatches) {
    for (const m of dollarMatches) {
      const v = parseMoneyToken(m);
      if (v !== undefined) return v;
    }
  }
  // Fall back to bare numbers that look like BTC-scale prices (>= 1000).
  const bareMatches = text.match(/\b\d[\d,]*(?:\.\d+)?[kKmM]?\b/g);
  if (bareMatches) {
    for (const m of bareMatches) {
      const v = parseMoneyToken(m);
      if (v !== undefined && (v >= 1000 || /[kKmM]/.test(m))) return v;
    }
  }
  return undefined;
}

function detectMarketType(haystack: string): MarketType {
  const lc = haystack.toLowerCase();
  const upDown =
    /\bup\s*(?:or|\/|&)?\s*down\b/.test(lc) ||
    /\bhigher\s*(?:or|\/)?\s*lower\b/.test(lc) ||
    (/\bup\b/.test(lc) && /\bdown\b/.test(lc));
  const aboveBelow =
    /\babove\b/.test(lc) ||
    /\bbelow\b/.test(lc) ||
    /\bgreater than\b/.test(lc) ||
    /\bless than\b/.test(lc) ||
    /\breach(?:es)?\b/.test(lc) ||
    /\bhit(?:s)?\b/.test(lc) ||
    /[><]=?/.test(lc);

  // UP_DOWN is a stricter signal (explicit direction question); prefer it when
  // both fire only if there is no explicit threshold target language.
  if (upDown && !/\babove\b|\bbelow\b/.test(lc)) return "UP_DOWN";
  if (aboveBelow) return "ABOVE_BELOW";
  if (upDown) return "UP_DOWN";
  return "UNKNOWN";
}

function detectMechanic(haystack: string, marketType: MarketType): SettlementMechanic {
  const lc = haystack.toLowerCase();
  const mentionsAvg =
    /\baverage\b/.test(lc) ||
    /\bmean\b/.test(lc) ||
    /\btwap\b/.test(lc) ||
    /\btime[-\s]?weighted\b/.test(lc);
  const mentionsWindow =
    /\bwindow\b/.test(lc) ||
    /\bover the (?:last|final|period)\b/.test(lc) ||
    /\binterval\b/.test(lc) ||
    /\bduring\b.*\bperiod\b/.test(lc);

  if (mentionsAvg) return "TWAP";
  if (mentionsWindow) return "WINDOW";
  // Default: point-in-time close for clear up/down or above/below markets.
  if (marketType === "UP_DOWN" || marketType === "ABOVE_BELOW") {
    return "POINT_IN_TIME";
  }
  return "UNKNOWN";
}

/** Detect a named settlement index if the text mentions one. */
function detectIndexName(haystack: string): string | null {
  const lc = haystack.toLowerCase();
  const candidates: { re: RegExp; name: string }[] = [
    { re: /coinbase/, name: "Coinbase" },
    { re: /chainlink/, name: "Chainlink" },
    { re: /pyth/, name: "Pyth" },
    { re: /cf benchmarks|cme cf|brr\b|bitcoin reference rate/, name: "CME CF BRR" },
    { re: /coingecko/, name: "CoinGecko" },
    { re: /\buma\b|optimistic oracle/, name: "UMA Optimistic Oracle" },
  ];
  for (const c of candidates) {
    if (c.re.test(lc)) return c.name;
  }
  // Generic "settles based on the X index" capture.
  const m = haystack.match(/\bsettle[sd]?\b[^.]*\b(?:on|using|per|via)\b\s+(?:the\s+)?([A-Za-z][\w .'-]{2,40}?)\s+(?:index|oracle|price|rate)/i);
  if (m && m[1]) return m[1].trim();
  return null;
}

function readField(raw: unknown, keys: string[]): string | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number" && Number.isFinite(v)) return new Date(v).toISOString();
  }
  return undefined;
}

// ──────────────────────────────────────────────────────────── main ──

export function parseSettlementRules(
  input: ParseSettlementRulesInput,
): ParsedRules {
  const blockedBy: string[] = [];

  let eventTitle = "";
  let marketTitle = "";
  let rulesPrimary = "";
  let rulesSecondary = "";
  let provider: VenueProvider = "unknown";
  let rawMarket: unknown = undefined;

  try {
    eventTitle = safeStr(input?.eventTitle);
    marketTitle = safeStr(input?.marketTitle);
    rulesPrimary = safeStr(input?.rulesPrimary);
    rulesSecondary = safeStr(input?.rulesSecondary);
    provider = input?.provider ?? "unknown";
    rawMarket = input?.rawMarket;
  } catch {
    // fall through with safe defaults
  }

  const haystack = [eventTitle, marketTitle, rulesPrimary, rulesSecondary]
    .filter(Boolean)
    .join(" \n ");

  const titleHaystack = [eventTitle, marketTitle].filter(Boolean).join(" \n ");

  // Defensive parsing — each step is wrapped so one bad regex never throws.
  let marketType: MarketType = "UNKNOWN";
  let targetPrice: number | undefined;
  let startPrice: number | undefined;
  let settlementIndexName: string | null = null;
  let settlementMechanic: SettlementMechanic = "UNKNOWN";

  try {
    marketType = detectMarketType(haystack || titleHaystack);
  } catch {
    marketType = "UNKNOWN";
  }

  try {
    settlementMechanic = detectMechanic(haystack, marketType);
  } catch {
    settlementMechanic = "UNKNOWN";
  }

  try {
    settlementIndexName = detectIndexName(haystack);
  } catch {
    settlementIndexName = null;
  }

  try {
    // For UP_DOWN markets the target is the START price (settles vs open).
    // For ABOVE_BELOW the target is the threshold in the title.
    if (marketType === "UP_DOWN") {
      startPrice = extractPrice(haystack);
      // Up/down may also state an explicit reference; keep target undefined
      // unless a distinct threshold is present.
      const thr = extractPrice(titleHaystack);
      if (thr !== undefined && thr !== startPrice) targetPrice = thr;
    } else {
      targetPrice = extractPrice(titleHaystack) ?? extractPrice(haystack);
    }
  } catch {
    targetPrice = undefined;
    startPrice = undefined;
  }

  // Timestamps from the raw market payload, defensively.
  const closeTime = readField(rawMarket, [
    "closeTime",
    "close_time",
    "endDate",
    "end_date",
    "closesAt",
    "closes_at",
  ]);
  const resolveAt = readField(rawMarket, [
    "resolveAt",
    "resolve_at",
    "resolutionTime",
    "resolution_time",
    "resolveTime",
    "resolve_time",
  ]);

  // ── confidence scoring + block codes ─────────────────────────────────
  let confidence = 0;

  if (provider === "unknown") {
    blockedBy.push("PROVIDER_UNKNOWN");
  }

  if (marketType === "UNKNOWN") {
    blockedBy.push("SETTLEMENT_RULE_UNCLEAR");
  } else {
    confidence += 0.35;
  }

  if (settlementMechanic === "UNKNOWN") {
    blockedBy.push("SETTLEMENT_RULE_UNCLEAR");
  } else {
    confidence += 0.2;
  }

  // Target / reference price requirement depends on type.
  const hasUsableTarget =
    marketType === "UP_DOWN"
      ? startPrice !== undefined || targetPrice !== undefined
      : targetPrice !== undefined;

  if (!hasUsableTarget) {
    blockedBy.push("TARGET_MISSING");
  } else {
    confidence += 0.3;
  }

  if (settlementIndexName) {
    confidence += 0.15;
  }
  // Note: a missing index NAME here is not itself a hard block at parse time —
  // the index ADAPTER enforces SETTLEMENT_INDEX_UNKNOWN. We only express our
  // confidence in the parse.

  // Dedup block codes.
  const dedupBlocked = Array.from(new Set(blockedBy));

  confidence = Math.max(0, Math.min(1, confidence));

  return {
    provider,
    marketType,
    targetPrice,
    startPrice,
    closeTime,
    resolveAt,
    settlementIndexName,
    settlementMechanic,
    confidence,
    blockedBy: dedupBlocked,
    raw: {
      eventTitle,
      marketTitle,
      rulesPrimary,
      rulesSecondary,
    },
  };
}
