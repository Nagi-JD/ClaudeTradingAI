import { describe, it, expect } from "vitest";
import { priceBinaryMarket } from "../src/pricing/binary_pricer";
import { getConfig, volWithMove } from "./helpers";

// Implementation: z = (spot - target) / expectedMove, fairYesBase = Phi(z).
// We pick expectedMoveUsd = 1000 so each $1000 of (spot-target) == 1 sigma.
const config = getConfig();
const MOVE = 1000;
const SPOT = 68_000;

function price(target: number) {
  return priceBinaryMarket({
    settlementIndexPrice: SPOT,
    targetPrice: target,
    secondsLeft: 90,
    volSnapshot: volWithMove(MOVE),
    config,
  });
}

describe("binary_pricer sign-convention invariants", () => {
  it("target == spot -> ~0.50", () => {
    const r = price(SPOT);
    expect(r.fairYesBase).not.toBeNull();
    expect(r.fairYesBase as number).toBeCloseTo(0.5, 2);
  });

  it("target +1 sigma ABOVE spot -> YES ~0.16", () => {
    // target above spot by 1 sigma => z = -1 => Phi(-1) ~ 0.159
    const r = price(SPOT + MOVE);
    expect(r.fairYesBase as number).toBeGreaterThan(0.16 - 0.02);
    expect(r.fairYesBase as number).toBeLessThan(0.16 + 0.02);
  });

  it("target +2 sigma above spot -> YES ~0.02", () => {
    const r = price(SPOT + 2 * MOVE);
    expect(r.fairYesBase as number).toBeGreaterThan(0.02 - 0.01);
    expect(r.fairYesBase as number).toBeLessThan(0.02 + 0.01);
  });

  it("target -1 sigma below spot -> YES ~0.84", () => {
    const r = price(SPOT - MOVE);
    expect(r.fairYesBase as number).toBeGreaterThan(0.84 - 0.02);
    expect(r.fairYesBase as number).toBeLessThan(0.84 + 0.02);
  });

  it("target -2 sigma below spot -> YES ~0.98", () => {
    const r = price(SPOT - 2 * MOVE);
    expect(r.fairYesBase as number).toBeGreaterThan(0.98 - 0.01);
    expect(r.fairYesBase as number).toBeLessThanOrEqual(0.99);
  });

  it("fairNoBase complements fairYesBase", () => {
    const r = price(SPOT);
    expect((r.fairYesBase as number) + (r.fairNoBase as number)).toBeCloseTo(1, 2);
  });
});

describe("binary_pricer gating", () => {
  it("missing target -> nulls + reason", () => {
    const r = priceBinaryMarket({
      settlementIndexPrice: SPOT,
      targetPrice: null,
      secondsLeft: 90,
      volSnapshot: volWithMove(MOVE),
      config,
    });
    expect(r.fairYesBase).toBeNull();
    expect(r.reasonCodes).toContain("BINARY_TARGET_MISSING");
  });

  it("missing index price -> nulls + reason", () => {
    const r = priceBinaryMarket({
      settlementIndexPrice: null,
      targetPrice: SPOT,
      secondsLeft: 90,
      volSnapshot: volWithMove(MOVE),
      config,
    });
    expect(r.fairYesBase).toBeNull();
    expect(r.reasonCodes).toContain("BINARY_INDEX_PRICE_MISSING");
  });

  it("secondsLeft <= 0 -> nulls", () => {
    const r = priceBinaryMarket({
      settlementIndexPrice: SPOT,
      targetPrice: SPOT,
      secondsLeft: 0,
      volSnapshot: volWithMove(MOVE),
      config,
    });
    expect(r.fairYesBase).toBeNull();
    expect(r.reasonCodes).toContain("BINARY_NO_TIME_LEFT");
  });

  it("low vol confidence -> nulls", () => {
    const vs = volWithMove(MOVE);
    vs.volConfidence = 0;
    const r = priceBinaryMarket({
      settlementIndexPrice: SPOT,
      targetPrice: SPOT,
      secondsLeft: 90,
      volSnapshot: vs,
      config,
    });
    expect(r.fairYesBase).toBeNull();
    expect(r.reasonCodes).toContain("BINARY_VOL_LOW_CONFIDENCE");
  });
});
