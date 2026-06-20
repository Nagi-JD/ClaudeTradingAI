import { describe, it, expect } from "vitest";
import {
  brierScore,
  logLoss,
  reliabilityCurve,
} from "../src/research/reliability_metrics";
import { compareVariants, shouldDisableTilt } from "../src/research/ablation_engine";
import type { AblationVariant, PaperTrade } from "../src/jupiter_prediction/models";

describe("reliability_metrics.brierScore", () => {
  it("perfect predictions -> 0", () => {
    expect(
      brierScore([
        { p: 1, outcome: 1 },
        { p: 0, outcome: 0 },
      ]),
    ).toBeCloseTo(0, 9);
  });

  it("worst predictions -> ~1", () => {
    expect(
      brierScore([
        { p: 1, outcome: 0 },
        { p: 0, outcome: 1 },
      ]),
    ).toBeGreaterThan(0.99);
  });

  it("known mid value: p=0.5 -> 0.25", () => {
    expect(
      brierScore([
        { p: 0.5, outcome: 1 },
        { p: 0.5, outcome: 0 },
      ]),
    ).toBeCloseTo(0.25, 9);
  });

  it("empty / invalid input -> 0 (no throw)", () => {
    expect(brierScore([])).toBe(0);
    // junk filtered out
    expect(brierScore([{ p: NaN, outcome: 1 } as any])).toBe(0);
  });

  it("logLoss known value: p=0.5 -> ln(2)", () => {
    expect(
      logLoss([
        { p: 0.5, outcome: 1 },
        { p: 0.5, outcome: 0 },
      ]),
    ).toBeCloseTo(Math.log(2), 6);
  });

  it("reliabilityCurve emits fixed-shape buckets", () => {
    const curve = reliabilityCurve(
      [
        { p: 0.1, outcome: 0 },
        { p: 0.9, outcome: 1 },
      ],
      10,
    );
    expect(curve).toHaveLength(10);
    // p=0.1 -> floor(0.1*10)=bucket 1; p=0.9 -> bucket 9.
    expect(curve[1].n).toBe(1);
    expect(curve[9].n).toBe(1);
    expect(curve[9].observed).toBe(1);
    expect(curve[0].n).toBe(0);
  });
});

describe("ablation_engine.compareVariants", () => {
  function trade(
    variant: AblationVariant,
    over: Partial<PaperTrade> = {},
  ): PaperTrade {
    return {
      timestamp: new Date().toISOString(),
      marketId: "m",
      provider: "polymarket",
      side: "YES",
      sizeUsd: 5,
      effectiveFillPrice: 0.5,
      fairPriceAtDecision: 0.6,
      edgeNet: 0.05,
      timeLeftSeconds: 90,
      settlementIndexPrice: 68_000,
      targetPrice: 68_000,
      volRegime: "NORMAL_VOL",
      basisBps: 0,
      latencyP95: 200,
      variant,
      reasonCodes: [],
      outcome: "YES",
      realizedPnlUsd: 0.5,
      ...over,
    };
  }

  it("returns a per-variant entry for every ablation variant", () => {
    const report = compareVariants([
      trade("base_only", { fairPriceAtDecision: 0.6, outcome: "YES", realizedPnlUsd: 0.4 }),
      trade("base_plus_all", { fairPriceAtDecision: 0.8, outcome: "YES", realizedPnlUsd: 0.6 }),
    ]);
    const variants: AblationVariant[] = [
      "base_only",
      "base_plus_cvd",
      "base_plus_liquidations",
      "base_plus_momentum",
      "base_plus_all",
    ];
    for (const v of variants) {
      expect(report[v]).toBeDefined();
      expect(report[v]).toHaveProperty("n");
      expect(report[v]).toHaveProperty("brier");
      expect(report[v]).toHaveProperty("netPnl");
    }
    expect(report.base_only.n).toBe(1);
    expect(report.base_plus_all.n).toBe(1);
  });

  it("only resolved trades count; unresolved are excluded", () => {
    const report = compareVariants([
      trade("base_only", { outcome: null }),
      trade("base_only", { outcome: "YES" }),
    ]);
    expect(report.base_only.n).toBe(1);
  });

  it("shouldDisableTilt recommends disable with insufficient data", () => {
    const report = compareVariants([]);
    const d = shouldDisableTilt(report);
    expect(d.disable).toBe(true);
  });

  it("shouldDisableTilt keeps tilt when full variant strictly beats baseline", () => {
    const report = compareVariants([
      // baseline: poorly calibrated, low pnl/edge
      trade("base_only", { fairPriceAtDecision: 0.51, outcome: "YES", realizedPnlUsd: 0.1, edgeNet: 0.01 }),
      // full tilt: better calibrated, higher pnl/edge
      trade("base_plus_all", { fairPriceAtDecision: 0.95, outcome: "YES", realizedPnlUsd: 0.9, edgeNet: 0.2 }),
    ]);
    const d = shouldDisableTilt(report);
    expect(d.disable).toBe(false);
  });
});
