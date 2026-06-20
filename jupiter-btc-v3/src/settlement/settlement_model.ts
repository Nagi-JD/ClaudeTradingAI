// Settlement model: turns a normalized market into a SettlementSpec by wrapping
// the rule parser + venue registry and applying the config settlement gates.
// This is where canTrade / blockedBy are finalized for the settlement layer.
// Fail-safe: any unknown provider, unclear rule, or missing target blocks.

import type {
  NormalizedMarketSnapshot,
  SettlementSpec,
} from "../jupiter_prediction/models";
import type { Config } from "../config/load_config";
import { parseSettlementRules } from "./rule_parser";
import { isProviderSupported, describeProvider } from "../venues/venue_registry";

export function buildSettlementSpec(
  market: NormalizedMarketSnapshot,
  config: Config,
): SettlementSpec {
  const blockedBy: string[] = [];

  // Defensive read of config gates with safe (conservative) fallbacks.
  const settlementCfg = config?.settlement ?? ({} as Config["settlement"]);
  const blockIfRuleUnclear = settlementCfg.blockIfRuleUnclear ?? true;
  const minRuleConfidence =
    typeof settlementCfg.minRuleConfidence === "number"
      ? settlementCfg.minRuleConfidence
      : 1; // conservative: require perfect confidence if misconfigured

  const provider = market?.provider ?? "unknown";

  // Parse the rules (pure, never throws).
  const parsed = parseSettlementRules({
    eventTitle: market?.eventTitle ?? "",
    marketTitle: market?.marketTitle ?? "",
    rulesPrimary: market?.rulesPrimary,
    rulesSecondary: market?.rulesSecondary,
    provider,
    rawMarket: market?.rawPayload,
  });

  // Carry forward all rule-level block codes.
  for (const code of parsed.blockedBy) blockedBy.push(code);

  // ── provider gate ────────────────────────────────────────────────────
  const providerDesc = describeProvider(provider);
  if (provider === "unknown") {
    blockedBy.push("PROVIDER_UNKNOWN");
  } else if (!isProviderSupported(provider)) {
    blockedBy.push("PROVIDER_UNSUPPORTED");
  }

  // ── rule clarity / confidence gate ───────────────────────────────────
  if (blockIfRuleUnclear && parsed.marketType === "UNKNOWN") {
    blockedBy.push("SETTLEMENT_RULE_UNCLEAR");
  }
  if (parsed.confidence < minRuleConfidence) {
    blockedBy.push("RULE_CONFIDENCE_BELOW_MIN");
  }

  // ── target gate ──────────────────────────────────────────────────────
  const hasUsableTarget =
    parsed.marketType === "UP_DOWN"
      ? parsed.startPrice !== undefined || parsed.targetPrice !== undefined
      : parsed.targetPrice !== undefined;
  if (!hasUsableTarget) {
    blockedBy.push("TARGET_MISSING");
  }

  // ── mechanic clarity (drives σ conditioning downstream) ──────────────
  if (parsed.settlementMechanic === "UNKNOWN" && blockIfRuleUnclear) {
    blockedBy.push("SETTLEMENT_MECHANIC_UNCLEAR");
  }

  const dedupBlocked = Array.from(new Set(blockedBy));
  const canTrade = dedupBlocked.length === 0;

  const spec: SettlementSpec = {
    provider,
    marketId: market?.marketId ?? "",
    eventId: market?.eventId ?? "",
    marketType: parsed.marketType,
    ruleConfidence: parsed.confidence,
    settlementIndexName: parsed.settlementIndexName,
    startPrice: parsed.startPrice,
    targetPrice: parsed.targetPrice,
    closeTime: parsed.closeTime ?? market?.closeTime,
    resolveAt: parsed.resolveAt ?? market?.resolveAt,
    settlementMechanic: parsed.settlementMechanic,
    canTrade,
    blockedBy: dedupBlocked,
    rawRules: {
      parsed: parsed.raw,
      providerSupport: providerDesc,
      gates: { blockIfRuleUnclear, minRuleConfidence },
    },
  };

  return spec;
}
