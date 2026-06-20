import { describe, it, expect } from "vitest";
import { computeVol } from "../src/pricing/vol_engine";
import { computeBasis } from "../src/pricing/basis_monitor";
import { computeTilt } from "../src/pricing/microstructure_tilt";
import { walkOrderbook } from "../src/pricing/orderbook_walker";
import { computeCosts } from "../src/pricing/cost_model";
import type { SettlementMechanic } from "../src/jupiter_prediction/models";
import {
  getConfig,
  healthyBasis,
  healthyIndex,
  healthyLatency,
  healthyWalk,
  btcContext,
} from "./helpers";

const config = getConfig();

// Build N ticks ending exactly at nowMs, spaced `stepMs` apart, with a small
// deterministic random-ish walk so log-returns are non-degenerate.
function makeTicks(n: number, nowMs: number, stepMs = 1000, base = 68_000) {
  const ticks: { t: number; price: number }[] = [];
  let price = base;
  for (let i = n - 1; i >= 0; i--) {
    const t = nowMs - i * stepMs;
    // alternating +/- moves -> nonzero variance, bounded
    price = price * (1 + (i % 2 === 0 ? 0.0002 : -0.0002));
    ticks.push({ t, price });
  }
  return ticks;
}

describe("vol_engine", () => {
  const now = 1_700_000_000_000;

  it("rejects insufficient data (few ticks)", () => {
    const vs = computeVol({
      indexTicks: [{ t: now, price: 68_000 }],
      secondsLeft: 90,
      settlementMechanic: "POINT_IN_TIME",
      config,
      nowMs: now,
    });
    expect(vs.regime).toBe("DATA_STALE");
    expect(vs.volConfidence).toBe(0);
    expect(vs.reasonCodes).toContain("VOL_NO_DATA");
  });

  it("rejects stale data (last tick too old)", () => {
    const ticks = makeTicks(40, now - 60_000); // ends 60s before now -> stale
    const vs = computeVol({
      indexTicks: ticks,
      secondsLeft: 90,
      settlementMechanic: "POINT_IN_TIME",
      config,
      nowMs: now,
    });
    expect(vs.regime).toBe("DATA_STALE");
    expect(vs.volConfidence).toBe(0);
    expect(vs.reasonCodes).toContain("VOL_DATA_STALE");
  });

  it("UNKNOWN mechanic blocks (volConfidence 0)", () => {
    const ticks = makeTicks(40, now);
    const vs = computeVol({
      indexTicks: ticks,
      secondsLeft: 90,
      settlementMechanic: "UNKNOWN",
      config,
      nowMs: now,
    });
    expect(vs.volConfidence).toBe(0);
    expect(vs.reasonCodes).toContain("VOL_MECHANIC_UNKNOWN");
  });

  it("computes a usable vol for fresh POINT_IN_TIME data", () => {
    const ticks = makeTicks(40, now);
    const vs = computeVol({
      indexTicks: ticks,
      secondsLeft: 90,
      settlementMechanic: "POINT_IN_TIME",
      config,
      nowMs: now,
    });
    expect(vs.expectedMoveUsd).not.toBeNull();
    expect(vs.expectedMoveUsd as number).toBeGreaterThan(0);
  });

  it("jumpy regime reduces confidence vs normal regime", () => {
    // Inject a large outlier return to trigger the jump z-threshold.
    const ticks = makeTicks(40, now);
    // Make the very last move a big jump.
    ticks[ticks.length - 1] = {
      t: now,
      price: ticks[ticks.length - 2].price * 1.05,
    };
    const jumpy = computeVol({
      indexTicks: ticks,
      secondsLeft: 90,
      settlementMechanic: "POINT_IN_TIME",
      config,
      nowMs: now,
    });
    const normal = computeVol({
      indexTicks: makeTicks(40, now),
      secondsLeft: 90,
      settlementMechanic: "POINT_IN_TIME",
      config,
      nowMs: now,
    });
    expect(jumpy.regime).toBe("JUMPY");
    expect(jumpy.volConfidence).toBeLessThan(normal.volConfidence);
  });

  it("TWAP/WINDOW settlement reduces effective variance vs POINT_IN_TIME", () => {
    const baseTicks = () => makeTicks(40, now);
    const point = computeVol({
      indexTicks: baseTicks(),
      secondsLeft: 90,
      settlementMechanic: "POINT_IN_TIME",
      config,
      nowMs: now,
    });
    const twap = computeVol({
      indexTicks: baseTicks(),
      secondsLeft: 90,
      settlementMechanic: "TWAP" as SettlementMechanic,
      config,
      nowMs: now,
    });
    expect(point.expectedMoveUsd).not.toBeNull();
    expect(twap.expectedMoveUsd).not.toBeNull();
    // Averaged settlement => smaller expected move (~ / sqrt(3)).
    expect(twap.expectedMoveUsd as number).toBeLessThan(
      point.expectedMoveUsd as number,
    );
    expect(twap.reasonCodes).toContain("VOL_MECHANIC_AVERAGED");
  });
});

describe("basis_monitor", () => {
  it("missing settlement index -> unstable", () => {
    const b = computeBasis({
      settlementIndex: healthyIndex({ indexPrice: null }),
      btcContext: btcContext(),
      history: [],
      config,
    });
    expect(b.isStable).toBe(false);
    expect(b.reasonCodes).toContain("SETTLEMENT_INDEX_MISSING");
  });

  it("stale settlement index -> unstable", () => {
    const b = computeBasis({
      settlementIndex: healthyIndex({ dataAgeMs: 60_000 }),
      btcContext: btcContext(),
      history: [],
      config,
    });
    expect(b.isStable).toBe(false);
    expect(b.reasonCodes).toContain("SETTLEMENT_INDEX_STALE");
  });

  it("tight, fresh basis is stable", () => {
    const b = computeBasis({
      settlementIndex: healthyIndex({ indexPrice: 68_000, dataAgeMs: 200, confidence: 0.9 }),
      btcContext: btcContext({ btcCexPriceNow: 68_000 }),
      history: [0, 0, 0],
      config,
    });
    expect(b.isStable).toBe(true);
  });

  it("wide basis -> unstable (BASIS_TOO_WIDE)", () => {
    const b = computeBasis({
      settlementIndex: healthyIndex({ indexPrice: 69_000, dataAgeMs: 200, confidence: 0.9 }),
      btcContext: btcContext({ btcCexPriceNow: 68_000 }),
      history: [],
      config,
    });
    expect(b.isStable).toBe(false);
    expect(b.reasonCodes).toContain("BASIS_TOO_WIDE");
  });
});

describe("microstructure_tilt", () => {
  it("disabled by default (config.tilts.enabled false) -> zeros + TILT_DISABLED", () => {
    const t = computeTilt({
      btcContext: btcContext({ netImbalance5m: 1, btcChange1m: 0.01 }),
      basis: healthyBasis(),
      fairYesBase: 0.5,
      config, // yaml has tilts.enabled=false
    });
    expect(config.tilts.enabled).toBe(false);
    expect(t.tiltTotal).toBe(0);
    expect(t.reasonCodes).toContain("TILT_DISABLED");
    expect(t.variants.base_plus_all).toBe(0);
  });

  it("when enabled, the tilt is capped at the sum of component caps", () => {
    const enabled = {
      ...config,
      tilts: { ...config.tilts, enabled: true },
    };
    const sumCap =
      enabled.tilts.cvdAdjustmentMax +
      enabled.tilts.liquidationAdjustmentMax +
      enabled.tilts.momentumAdjustmentMax;
    const t = computeTilt({
      btcContext: btcContext({
        netImbalance5m: 1e9,
        liquidationImbalance5m: 1e9,
        btcChange1m: 1e9,
      }),
      basis: healthyBasis(),
      fairYesBase: 0.5,
      config: enabled,
    });
    expect(Math.abs(t.tiltTotal)).toBeLessThanOrEqual(sumCap + 1e-9);
    expect(Math.abs(t.tiltBreakdown.cvd)).toBeLessThanOrEqual(
      enabled.tilts.cvdAdjustmentMax + 1e-9,
    );
  });

  it("unstable basis -> zeros even when enabled", () => {
    const enabled = { ...config, tilts: { ...config.tilts, enabled: true } };
    const t = computeTilt({
      btcContext: btcContext({ netImbalance5m: 1 }),
      basis: healthyBasis({ isStable: false }),
      fairYesBase: 0.5,
      config: enabled,
    });
    expect(t.tiltTotal).toBe(0);
    expect(t.reasonCodes).toContain("TILT_BASIS_UNSTABLE");
  });
});

describe("orderbook_walker", () => {
  // Jupiter books are BIDS-ONLY: YES asks come from NO bids flipped at 1-price.
  const rawBook = {
    yesBids: [
      { price: 0.49, size: 100 },
      { price: 0.48, size: 100 },
    ],
    noBids: [
      { price: 0.48, size: 50 }, // -> YES ask at 0.52, size 50
      { price: 0.46, size: 50 }, // -> YES ask at 0.54, size 50
    ],
  };

  it("never fills at mid (filledAtMid === false)", () => {
    const w = walkOrderbook({
      rawOrderbook: rawBook,
      side: "YES",
      targetSizeUsd: 10,
      config,
    });
    expect(w.filledAtMid).toBe(false);
    expect(w.avgFillPrice).not.toBeNull();
    // YES asks derive from NO bids (cheapest 0.52) -> avg fill >= 0.52, not mid (~0.5).
    expect(w.avgFillPrice as number).toBeGreaterThanOrEqual(0.52 - 1e-9);
  });

  it("supports partial fills when target exceeds available depth", () => {
    const w = walkOrderbook({
      rawOrderbook: rawBook,
      side: "YES",
      targetSizeUsd: 1_000_000, // far exceeds available notional
      config,
    });
    expect(w.fillRatio).toBeLessThan(1);
    expect(w.reasonCodes).toContain("FILL_QUALITY_POOR");
  });

  it("malformed orderbook -> empty + reason codes, no throw", () => {
    const w = walkOrderbook({
      rawOrderbook: "garbage",
      side: "YES",
      targetSizeUsd: 10,
      config,
    });
    expect(w.avgFillPrice).toBeNull();
    expect(w.reasonCodes).toContain("FILL_QUALITY_POOR");
  });
});

describe("cost_model", () => {
  it("net edge is strictly below gross edge (frictions reduce edge)", () => {
    const walkYes = healthyWalk("YES", { avgFillPrice: 0.5, fillRatio: 1 });
    const fairYes = 0.7;
    const grossEdge = fairYes - (walkYes.avgFillPrice as number); // 0.20

    const cost = computeCosts({
      walkYes,
      latency: healthyLatency(),
      volRegime: "NORMAL_VOL",
      secondsLeft: 90,
      fairYesTilted: fairYes,
      fairNoTilted: null,
      config,
    });

    expect(cost.netEdgeYes).not.toBeNull();
    expect(cost.netEdgeYes as number).toBeLessThan(grossEdge);
    // effective price degraded above the raw avg fill.
    expect(cost.effectiveBuyYesPrice as number).toBeGreaterThan(
      walkYes.avgFillPrice as number,
    );
  });

  it("poor fill charges an adverse-selection penalty (not free)", () => {
    const poorWalk = healthyWalk("YES", {
      avgFillPrice: 0.5,
      fillRatio: 0.3,
      reasonCodes: ["FILL_QUALITY_POOR"],
    });
    const cost = computeCosts({
      walkYes: poorWalk,
      latency: healthyLatency(),
      volRegime: "NORMAL_VOL",
      secondsLeft: 90,
      fairYesTilted: 0.7,
      fairNoTilted: null,
      config,
    });
    expect(cost.failedFillPenalty).toBeGreaterThan(0);
  });
});
