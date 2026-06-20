import { describe, it, expect } from "vitest";
import { newTradesSince } from "../src/collector.js";
import type { Trade } from "../src/types.js";

const t = (id: number): Trade => ({
  id,
  ownerPubkey: "W" + id,
  marketId: "M",
  timestamp: id,
  action: "buy",
  side: "yes",
  eventTitle: "e",
  marketTitle: "m",
  amountUsd: "0",
  priceUsd: "0",
  eventId: "E",
});

describe("newTradesSince (append-only de-dup by high-water mark)", () => {
  it("returns only trades with id beyond the mark, and advances the mark", () => {
    const { rows, hwm } = newTradesSince([t(3), t(5), t(4)], 3);
    expect(rows.map((r) => r.id).sort()).toEqual([4, 5]);
    expect(hwm).toBe(5);
  });

  it("first run (mark 0) keeps everything", () => {
    const { rows, hwm } = newTradesSince([t(10), t(11)], 0);
    expect(rows).toHaveLength(2);
    expect(hwm).toBe(11);
  });

  it("nothing new => empty rows, mark unchanged", () => {
    const { rows, hwm } = newTradesSince([t(2), t(1)], 5);
    expect(rows).toHaveLength(0);
    expect(hwm).toBe(5);
  });

  it("empty feed => no rows, mark preserved", () => {
    expect(newTradesSince([], 7)).toEqual({ rows: [], hwm: 7 });
  });
});
