import { describe, it, expect, vi } from "vitest";
import { JupiterClient } from "../src/jupiter.js";

function mockFetch(handler: (url: string) => unknown) {
  return vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => handler(url),
  })) as unknown as typeof fetch;
}

describe("JupiterClient", () => {
  it("attaches x-api-key and parses trades", async () => {
    const f = mockFetch(() => ({ data: [{ id: 1, ownerPubkey: "W", marketId: "M", action: "buy", side: "yes" }] }));
    const c = new JupiterClient({ apiBase: "https://x/v1", apiKey: "KEY", fetchImpl: f });
    const trades = await c.getTrades();
    expect(trades).toHaveLength(1);
    const call = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((call[1] as RequestInit).headers).toMatchObject({ "x-api-key": "KEY" });
  });

  it("builds query params for leaderboard", async () => {
    const f = mockFetch(() => ({ data: [] }));
    const c = new JupiterClient({ apiBase: "https://x/v1", apiKey: "K", fetchImpl: f });
    await c.getLeaderboard("pnl", "weekly", 50);
    const url = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain("metric=pnl");
    expect(url).toContain("period=weekly");
    expect(url).toContain("limit=50");
  });

  it("computes weekly pnl as the delta over the cumulative history (micro-USD)", async () => {
    // cumulative curve: $1.00 -> $3.50 within the window => weekly delta $2.50
    const f = mockFetch(() => ({ history: [{ timestamp: 1, realizedPnlUsd: "1000000" }, { timestamp: 2, realizedPnlUsd: "3500000" }] }));
    const c = new JupiterClient({ apiBase: "https://x/v1", apiKey: "K", fetchImpl: f });
    expect(await c.getWeeklyPnlUsd("W")).toBeCloseTo(2.5);
  });

  it("retries on 429 then succeeds", async () => {
    let n = 0;
    const f = vi.fn(async () => {
      n++;
      if (n <= 2) return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 9 }] }) };
    }) as unknown as typeof fetch;
    const c = new JupiterClient({ apiBase: "https://x/v1", apiKey: "K", fetchImpl: f });
    const trades = await c.getTrades();
    expect(trades).toHaveLength(1);
    expect(n).toBe(3);
  });

  it("retries once on 5xx then succeeds", async () => {
    let n = 0;
    const f = vi.fn(async () => {
      n++;
      if (n === 1) return { ok: false, status: 502, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }) as unknown as typeof fetch;
    const c = new JupiterClient({ apiBase: "https://x/v1", apiKey: "K", fetchImpl: f });
    expect(await c.getTrades()).toEqual([]);
    expect(n).toBe(2);
  });
});
