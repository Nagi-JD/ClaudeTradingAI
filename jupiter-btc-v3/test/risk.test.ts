import { describe, it, expect } from "vitest";
import { LatencyEngine } from "../src/risk/measured_latency_engine";
import { CorrelationRiskManager } from "../src/risk/correlation_risk_manager";
import { LossTracker } from "../src/risk/loss_limits";
import { evaluateRisk } from "../src/risk/risk_manager";
import { loadConfig } from "../src/config/load_config";
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
} from "./helpers";

const config = getConfig();
const flags = loadConfig().flags;

function baseRiskInput(over: Record<string, unknown> = {}) {
  return {
    market: healthyMarket(),
    settlement: healthySettlement(),
    settlementIndex: healthyIndex(),
    basis: healthyBasis(),
    vol: volWithMove(400),
    fairValue: healthyFairValue(),
    latency: healthyLatency(),
    walkYes: healthyWalk("YES"),
    walkNo: healthyWalk("NO"),
    flags,
    config,
    correlation: new CorrelationRiskManager(),
    lossTracker: new LossTracker(),
    ...over,
  };
}

describe("LatencyEngine", () => {
  it("p95 above absolute threshold blocks (withinBudget false)", () => {
    const eng = new LatencyEngine();
    for (let i = 0; i < 40; i++) eng.record({ marketFetchMs: 5000 }); // > maxAbsoluteMs(1500)
    const snap = eng.snapshot({ secondsLeft: 90, totalDataAgeMs: 300, config });
    expect(snap.withinBudget).toBe(false);
    expect(snap.reasonCodes).toContain("LATENCY_P95_OVER_ABSOLUTE");
  });

  it("no samples blocks", () => {
    const eng = new LatencyEngine();
    const snap = eng.snapshot({ secondsLeft: 90, totalDataAgeMs: 300, config });
    expect(snap.withinBudget).toBe(false);
    expect(snap.reasonCodes).toContain("LATENCY_NO_SAMPLES");
  });

  it("fast samples within budget", () => {
    const eng = new LatencyEngine();
    for (let i = 0; i < 40; i++) eng.record({ marketFetchMs: 100, decisionMs: 50 });
    const snap = eng.snapshot({ secondsLeft: 90, totalDataAgeMs: 300, config });
    expect(snap.withinBudget).toBe(true);
  });
});

describe("CorrelationRiskManager grouping", () => {
  it("overlapping BTC markets (same window/target/dir) collapse to same key", () => {
    const mgr = new CorrelationRiskManager();
    const closeMs = Date.now() + 60_000;
    const closeIso = new Date(closeMs).toISOString();

    const a = mgr.groupKey(
      healthyMarket({ marketId: "A", closeTime: closeIso }),
      healthySettlement({ marketId: "A", targetPrice: 68_000, closeTime: closeIso }),
      "YES",
      config,
    );
    const b = mgr.groupKey(
      healthyMarket({ marketId: "B", closeTime: closeIso }),
      healthySettlement({ marketId: "B", targetPrice: 68_005, closeTime: closeIso }),
      "YES",
      config,
    );
    expect(mgr.keyString(a)).toBe(mgr.keyString(b));
  });

  it("opposite direction is a different key", () => {
    const mgr = new CorrelationRiskManager();
    const closeIso = new Date(Date.now() + 60_000).toISOString();
    const yes = mgr.groupKey(
      healthyMarket({ closeTime: closeIso }),
      healthySettlement({ closeTime: closeIso }),
      "YES",
      config,
    );
    const no = mgr.groupKey(
      healthyMarket({ closeTime: closeIso }),
      healthySettlement({ closeTime: closeIso }),
      "NO",
      config,
    );
    expect(mgr.keyString(yes)).not.toBe(mgr.keyString(no));
  });

  it("wouldExceed becomes true once accumulated past the cap", () => {
    const mgr = new CorrelationRiskManager();
    const closeIso = new Date(Date.now() + 60_000).toISOString();
    const k = mgr.groupKey(
      healthyMarket({ closeTime: closeIso }),
      healthySettlement({ closeTime: closeIso }),
      "YES",
      config,
    );
    const cap = config.correlation.maxCorrelatedExposureUsd;
    expect(mgr.wouldExceed(k, 1, config)).toBe(false);
    mgr.addExposure(k, cap);
    expect(mgr.wouldExceed(k, 1, config)).toBe(true);
  });
});

describe("risk_manager block rules", () => {
  it("provider unknown blocks the trade", () => {
    const d = evaluateRisk(
      baseRiskInput({
        market: healthyMarket({ provider: "unknown" }),
        settlement: healthySettlement({ provider: "unknown" }),
      }) as any,
    );
    expect(d.allowed).toBe(false);
    expect(d.blockedBy).toContain("PROVIDER_UNKNOWN");
  });

  it("settlement index missing (confidence 0) blocks", () => {
    const d = evaluateRisk(
      baseRiskInput({
        settlementIndex: healthyIndex({ confidence: 0, indexPrice: null }),
      }) as any,
    );
    expect(d.allowed).toBe(false);
    expect(d.blockedBy).toContain("SETTLEMENT_INDEX_UNAVAILABLE");
  });

  it("basis unstable blocks", () => {
    const d = evaluateRisk(
      baseRiskInput({ basis: healthyBasis({ isStable: false }) }) as any,
    );
    expect(d.allowed).toBe(false);
    expect(d.blockedBy).toContain("BASIS_UNSTABLE");
  });

  it("latency p95 too high blocks", () => {
    const d = evaluateRisk(
      baseRiskInput({
        latency: healthyLatency({
          withinBudget: false,
          reasonCodes: ["LATENCY_P95_OVER_ABSOLUTE"],
        }),
      }) as any,
    );
    expect(d.allowed).toBe(false);
    expect(d.blockedBy).toContain("LATENCY_BUDGET_EXCEEDED");
  });

  it("a blocked decision always lists at least one block code", () => {
    const d = evaluateRisk(
      baseRiskInput({ fairValue: healthyFairValue({ edgeYesNet: null, edgeNoNet: null }) }) as any,
    );
    expect(d.allowed).toBe(false);
    expect(d.blockedBy.length).toBeGreaterThan(0);
  });
});
