import { describe, it, expect } from "vitest";
import { normalizeMarket } from "../src/jupiter_prediction/normalizer";
import {
  identifyProvider,
  isProviderSupported,
  describeProvider,
} from "../src/venues/venue_registry";
import { parseSettlementRules } from "../src/settlement/rule_parser";
import { buildSettlementSpec } from "../src/settlement/settlement_model";
import { fetchSettlementIndex } from "../src/settlement/settlement_index_adapter";
import { getConfig, healthyMarket, healthySettlement } from "./helpers";

describe("normalizer schema-drift safety", () => {
  it("does not throw on junk input and yields safe values", () => {
    expect(() => normalizeMarket(42, "not-an-object", "polymarket")).not.toThrow();
    const snap = normalizeMarket(null, undefined, "polymarket");
    expect(snap.eventId).toBe("");
    expect(snap.marketId).toBe("");
    expect(snap.timeLeftSeconds).toBeNull();
    expect(snap.buyYesPriceUsd).toBeUndefined();
  });

  it("normalizes cent-scale prices into [0,1]", () => {
    const snap = normalizeMarket(
      { id: "e", title: "BTC up?" },
      { id: "m", yesPrice: 55, noPrice: 45 },
      "polymarket",
    );
    expect(snap.buyYesPriceUsd).toBeCloseTo(0.55, 6);
    expect(snap.buyNoPriceUsd).toBeCloseTo(0.45, 6);
  });
});

describe("venue_registry provider identification", () => {
  it("identifies known providers and blocks unknown/ambiguous", () => {
    expect(identifyProvider({ provider: "polymarket" })).toBe("polymarket");
    expect(identifyProvider({ venue: "Kalshi" })).toBe("kalshi");
    expect(identifyProvider({ provider: "betfair" })).toBe("unknown");
    // ambiguous mention of both -> unknown (fail safe)
    expect(identifyProvider("polymarket and kalshi")).toBe("unknown");
  });

  it("provider support + describe reason codes", () => {
    expect(isProviderSupported("polymarket")).toBe(true);
    expect(isProviderSupported("unknown")).toBe(false);
    expect(describeProvider("unknown").reasonCodes).toContain("PROVIDER_UNKNOWN");
    expect(describeProvider("polymarket").supported).toBe(true);
  });
});

describe("rule_parser schema-drift safety + block codes", () => {
  it("never throws on junk and returns safe low-confidence values", () => {
    const parsed = parseSettlementRules({
      eventTitle: "",
      marketTitle: "",
      provider: "unknown",
      rawMarket: 12345,
    });
    expect(parsed.marketType).toBe("UNKNOWN");
    expect(parsed.confidence).toBe(0);
    expect(parsed.blockedBy).toContain("PROVIDER_UNKNOWN");
    expect(parsed.blockedBy).toContain("SETTLEMENT_RULE_UNCLEAR");
  });

  it("blocks when settlement rule is unclear", () => {
    const parsed = parseSettlementRules({
      eventTitle: "Some random sports event",
      marketTitle: "Who wins?",
      provider: "polymarket",
      rawMarket: {},
    });
    expect(parsed.blockedBy).toContain("SETTLEMENT_RULE_UNCLEAR");
  });

  it("blocks when target price is missing", () => {
    const parsed = parseSettlementRules({
      eventTitle: "Bitcoin above some level?",
      marketTitle: "Will BTC be above the threshold?",
      provider: "polymarket",
      rawMarket: {},
    });
    expect(parsed.blockedBy).toContain("TARGET_MISSING");
  });

  it("parses an above/below market with explicit target", () => {
    const parsed = parseSettlementRules({
      eventTitle: "Bitcoin above $68,000?",
      marketTitle: "Will BTC settle above $68,000 on Coinbase?",
      provider: "polymarket",
      rawMarket: {},
    });
    expect(parsed.marketType).toBe("ABOVE_BELOW");
    expect(parsed.targetPrice).toBe(68000);
    expect(parsed.settlementIndexName).toBe("Coinbase");
    expect(parsed.blockedBy).not.toContain("TARGET_MISSING");
  });
});

describe("settlement_model gates", () => {
  const config = getConfig();

  it("unknown provider blocks trade", () => {
    const m = healthyMarket({ provider: "unknown" });
    const spec = buildSettlementSpec(m, config);
    expect(spec.canTrade).toBe(false);
    expect(spec.blockedBy).toContain("PROVIDER_UNKNOWN");
  });

  it("unclear rule blocks trade", () => {
    const m = healthyMarket({
      provider: "polymarket",
      eventTitle: "Random event",
      marketTitle: "No threshold here",
    });
    const spec = buildSettlementSpec(m, config);
    expect(spec.canTrade).toBe(false);
    expect(spec.blockedBy).toContain("SETTLEMENT_RULE_UNCLEAR");
  });

  it("missing target blocks trade", () => {
    const m = healthyMarket({
      provider: "polymarket",
      eventTitle: "Will BTC be above the level on Coinbase?",
      marketTitle: "Above the threshold?",
    });
    const spec = buildSettlementSpec(m, config);
    expect(spec.canTrade).toBe(false);
    expect(spec.blockedBy).toContain("TARGET_MISSING");
  });
});

describe("settlement_index_adapter", () => {
  it("blocks (confidence 0) when no exact index without fallback", async () => {
    const spec = healthySettlement({ provider: "polymarket" });
    const snap = await fetchSettlementIndex(spec, {
      allowCexResearchFallback: false,
    });
    expect(snap.confidence).toBe(0);
    expect(snap.indexPrice).toBeNull();
  });

  it("kalshi also blocks without fallback", async () => {
    const spec = healthySettlement({ provider: "kalshi" });
    const snap = await fetchSettlementIndex(spec, {
      allowCexResearchFallback: false,
    });
    expect(snap.confidence).toBe(0);
    expect(snap.indexPrice).toBeNull();
  });

  it("unknown provider blocks", async () => {
    const spec = healthySettlement({ provider: "unknown" });
    const snap = await fetchSettlementIndex(spec, {
      allowCexResearchFallback: false,
    });
    expect(snap.confidence).toBe(0);
  });

  it("CEX research fallback is low-confidence and clearly flagged", async () => {
    const spec = healthySettlement({ provider: "polymarket" });
    const snap = await fetchSettlementIndex(spec, {
      allowCexResearchFallback: true,
      btcContextPrice: 68_000,
    });
    expect(snap.confidence).toBeLessThan(0.5);
    expect(snap.indexPrice).toBe(68_000);
    expect(String(snap.indexName)).toContain("CEX_RESEARCH_PROXY");
  });
});
