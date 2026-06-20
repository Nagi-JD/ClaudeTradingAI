import { describe, it, expect } from "vitest";
import { microToUsd, usdToMicro, roundUpCent, usdToContracts } from "../src/money.js";

describe("money", () => {
  it("converts micro-USD", () => {
    expect(microToUsd(1_000_000)).toBe(1);
    expect(microToUsd("2500000")).toBe(2.5);
    expect(usdToMicro(1.32)).toBe(1_320_000);
  });

  it("rounds fees up to the cent", () => {
    expect(roundUpCent(1.201)).toBe(1.21);
    expect(roundUpCent(1.2)).toBe(1.2);
    expect(roundUpCent(0.0007)).toBe(0.01);
    expect(roundUpCent(1.3125)).toBe(1.32);
  });

  it("converts usd budget to contracts", () => {
    expect(usdToContracts(10, 0.25)).toBe(40);
    expect(usdToContracts(10, 0)).toBe(0);
  });
});
