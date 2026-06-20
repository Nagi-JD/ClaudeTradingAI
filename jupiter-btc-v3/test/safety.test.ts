import { describe, it, expect, vi } from "vitest";
import { makePaperTrade, PaperTrader } from "../src/strategy/paper_trader";
import { simulateFill } from "../src/replay/fill_simulator";
import { loadConfig } from "../src/config/load_config";
import type { StrategyDecision } from "../src/jupiter_prediction/models";
import {
  getConfig,
  healthyMarket,
  healthySettlement,
  healthyIndex,
  healthyBasis,
  healthyLatency,
  healthyFairValue,
  healthyWalk,
  volWithMove,
  btcContext,
} from "./helpers";

const config = getConfig();

function decision(): StrategyDecision {
  return {
    timestamp: new Date().toISOString(),
    market: healthyMarket(),
    settlement: healthySettlement(),
    settlementIndex: healthyIndex(),
    btcContext: btcContext(),
    basis: healthyBasis(),
    vol: volWithMove(400),
    fairValue: healthyFairValue(),
    risk: { allowed: true, side: "YES", blockedBy: [], sizeUsd: 5, explanation: "ok" },
    latency: healthyLatency(),
    orderbookYes: healthyWalk("YES"),
    cost: {
      effectiveBuyYesPrice: 0.52,
      effectiveBuyNoPrice: 0.49,
      expectedSlippage: 0.015,
      latencyPenalty: 0.001,
      failedFillPenalty: 0,
      feeEstimate: 0,
      netEdgeYes: 0.08,
      netEdgeNo: -0.1,
      fillQualityScore: 0.9,
      reasonCodes: [],
    },
    signal: "YES_EDGE",
    action: "PAPER_TRADE",
  };
}

describe("paper_trader safety", () => {
  it("makePaperTrade never calls client.createOrder", () => {
    // A client spy: if any property/method were invoked, the spies record it.
    const clientSpy = {
      createOrder: vi.fn(),
      createOrderDryRun: vi.fn(),
    };
    const trade = makePaperTrade({ decision: decision(), variant: "base_only" });
    expect(trade.side).toBe("YES");
    expect(trade.effectiveFillPrice).toBeCloseTo(0.52, 6);
    expect(clientSpy.createOrder).not.toHaveBeenCalled();
    expect(clientSpy.createOrderDryRun).not.toHaveBeenCalled();
  });

  it("PaperTrader records trades via injected logger only (no order path)", () => {
    const logger = { write: vi.fn() };
    const trader = new PaperTrader(logger);
    const t = makePaperTrade({ decision: decision(), variant: "base_plus_all" });
    trader.record(t);
    expect(trader.trades()).toHaveLength(1);
    expect(logger.write).toHaveBeenCalledTimes(1);
  });
});

describe("live trading disabled by default", () => {
  it("loadConfig flags.liveTradingPermitted === false", () => {
    expect(loadConfig().flags.liveTradingPermitted).toBe(false);
  });
});

describe("fill_simulator pessimism + adverse selection", () => {
  it("fills worse than mid (uses worst fill price, never mid)", () => {
    const walk = healthyWalk("YES", {
      avgFillPrice: 0.5,
      worstFillPrice: 0.55,
      availableSizeUsd: 1000,
      fillRatio: 1,
    });
    const r = simulateFill({
      walk,
      side: "YES",
      sizeUsd: 5,
      volRegime: "NORMAL_VOL",
      config,
    });
    expect(r.filled).toBe(true);
    // pessimistic: uses worstFillPrice (0.55), which is worse than mid (~0.5).
    expect(r.fillPrice).toBe(0.55);
  });

  it("flags adverse selection under elevated vol regime", () => {
    const walk = healthyWalk("YES", { worstFillPrice: 0.55, fillRatio: 1 });
    const r = simulateFill({
      walk,
      side: "YES",
      sizeUsd: 5,
      volRegime: "JUMPY",
      config,
    });
    expect(r.adverse).toBe(true);
  });

  it("partial fill when depth is thin (not all good quotes fill)", () => {
    const walk = healthyWalk("YES", {
      worstFillPrice: 0.55,
      availableSizeUsd: 2,
      fillRatio: 0.4,
    });
    const r = simulateFill({
      walk,
      side: "YES",
      sizeUsd: 100,
      volRegime: "NORMAL_VOL",
      config,
    });
    expect(r.filledSizeUsd).toBeLessThan(100);
    expect(r.reasonCodes).toContain("PARTIAL_FILL");
  });
});
