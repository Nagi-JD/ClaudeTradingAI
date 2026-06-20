import { describe, it, expect } from "vitest";
import { classifyMarket, normalizePosition, diffPositions, snapshotFrom, posKey } from "../src/position-watch.js";

describe("classifyMarket", () => {
  it("tags 5m / sport / evt", () => {
    expect(classifyMarket("Solana Up or Down - June 6")).toBe("5m");
    expect(classifyMarket("Libema Open, Qualification: Alexander Ma vs Shintaro Mochizuki")).toBe("sport");
    expect(classifyMarket("2026 FIFA World Cup Winner")).toBe("sport"); // tournoi = sport (long)
    expect(classifyMarket("Bitcoin above $150k in 2026")).toBe("evt");
  });
});

describe("normalizePosition (micro-USD -> USD)", () => {
  it("converts prices and contracts", () => {
    const p = normalizePosition({
      ownerPubkey: "W", marketId: "POLY-1-0", isYes: true, contracts: "1326",
      avgPriceUsd: "710000", markPriceUsd: "720000", sellPriceUsd: "700000",
      eventMetadata: { title: "X vs Y" },
    });
    expect(p.contracts).toBe(1326);
    expect(p.avgPriceUsd).toBeCloseTo(0.71);
    expect(p.markPriceUsd).toBeCloseTo(0.72);
    expect(p.marketType).toBe("sport");
  });
});

const wp = (over: any = {}) =>
  normalizePosition({ ownerPubkey: "W", marketId: "M", isYes: true, contracts: "100", avgPriceUsd: "500000", markPriceUsd: "520000", sellPriceUsd: "480000", marketTitle: "A vs B", ...over });

describe("diffPositions", () => {
  it("new key => entry (at mark price)", () => {
    const ev = diffPositions(new Map(), snapshotFrom([{ ownerPubkey: "W", marketId: "M", isYes: true, contracts: "100", markPriceUsd: "520000", marketTitle: "A vs B" }]));
    expect(ev).toHaveLength(1);
    expect(ev[0].type).toBe("entry");
    expect(ev[0].priceUsd).toBeCloseTo(0.52);
  });

  it("more contracts => increase; fewer => decrease; gone => exit; same => nothing", () => {
    const prev = snapshotFrom([{ ownerPubkey: "W", marketId: "M", isYes: true, contracts: "100", sellPriceUsd: "480000", markPriceUsd: "520000", marketTitle: "A vs B" }]);
    const inc = snapshotFrom([{ ownerPubkey: "W", marketId: "M", isYes: true, contracts: "150", markPriceUsd: "520000", marketTitle: "A vs B" }]);
    const dec = snapshotFrom([{ ownerPubkey: "W", marketId: "M", isYes: true, contracts: "40", sellPriceUsd: "480000", marketTitle: "A vs B" }]);
    expect(diffPositions(prev, inc)[0].type).toBe("increase");
    expect(diffPositions(prev, dec)[0].type).toBe("decrease");
    expect(diffPositions(prev, new Map())[0].type).toBe("exit");
    expect(diffPositions(prev, prev)).toHaveLength(0);
  });

  it("exit uses the sell price", () => {
    const prev = snapshotFrom([{ ownerPubkey: "W", marketId: "M", isYes: true, contracts: "100", sellPriceUsd: "480000", marketTitle: "A vs B" }]);
    const ev = diffPositions(prev, new Map());
    expect(ev[0].priceUsd).toBeCloseTo(0.48);
  });
});
