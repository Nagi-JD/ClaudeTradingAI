// Venue registry: identify the underlying prediction-market provider behind a
// Jupiter-relayed market and decide whether we understand its settlement well
// enough to trade. Defensive + fail-safe: ambiguous input → "unknown", which
// downstream code treats as a hard block (PROVIDER_UNKNOWN).

import type { VenueProvider } from "../jupiter_prediction/models";

/** Providers whose settlement semantics we model. */
const SUPPORTED_PROVIDERS: ReadonlySet<VenueProvider> = new Set<VenueProvider>([
  "polymarket",
  "kalshi",
]);

/**
 * Look for a provider hint anywhere in a raw value. Walks strings and shallow
 * object/array structures defensively (never throws). Returns the matched
 * provider, or "unknown" when nothing recognizable / ambiguous is found.
 */
function scanForProvider(raw: unknown, depth = 0): VenueProvider {
  if (depth > 4 || raw === null || raw === undefined) return "unknown";

  if (typeof raw === "string") {
    return matchProviderString(raw);
  }

  if (typeof raw === "number" || typeof raw === "boolean") {
    return "unknown";
  }

  // Prefer explicit provider-like fields before a blind deep scan.
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const PRIORITY_KEYS = [
      "provider",
      "venue",
      "source",
      "platform",
      "exchange",
      "market_provider",
      "marketProvider",
    ];
    for (const key of PRIORITY_KEYS) {
      const v = obj[key];
      if (typeof v === "string") {
        const m = matchProviderString(v);
        if (m !== "unknown") return m;
      }
    }

    // Shallow recursive scan of remaining values.
    const values = Array.isArray(raw) ? raw : Object.values(obj);
    for (const v of values) {
      const m = scanForProvider(v, depth + 1);
      if (m !== "unknown") return m;
    }
  }

  return "unknown";
}

/** Match a single string against known provider tokens. */
function matchProviderString(s: string): VenueProvider {
  const lc = s.toLowerCase();
  const hasPoly = lc.includes("polymarket") || lc.includes("poly");
  const hasKalshi = lc.includes("kalshi");

  // Ambiguous: mentions both → cannot disambiguate → unknown (fail safe).
  if (hasPoly && hasKalshi) return "unknown";
  if (hasPoly) return "polymarket";
  if (hasKalshi) return "kalshi";
  return "unknown";
}

/**
 * Identify the provider behind a raw market/event payload.
 * Returns "unknown" on any ambiguity — callers MUST treat that as a block.
 */
export function identifyProvider(raw: unknown): VenueProvider {
  try {
    return scanForProvider(raw);
  } catch {
    // Defensive: never throw in a hot path.
    return "unknown";
  }
}

/** True only for providers whose settlement we model (polymarket, kalshi). */
export function isProviderSupported(p: VenueProvider): boolean {
  return SUPPORTED_PROVIDERS.has(p);
}

/**
 * Human/audit-friendly description of a provider's support status with
 * explicit reasonCodes for the decision log.
 */
export function describeProvider(p: VenueProvider): {
  supported: boolean;
  reasonCodes: string[];
} {
  if (p === "unknown") {
    return { supported: false, reasonCodes: ["PROVIDER_UNKNOWN"] };
  }
  if (isProviderSupported(p)) {
    return { supported: true, reasonCodes: [`PROVIDER_SUPPORTED:${p}`] };
  }
  return {
    supported: false,
    reasonCodes: ["PROVIDER_UNSUPPORTED", `PROVIDER:${p}`],
  };
}
