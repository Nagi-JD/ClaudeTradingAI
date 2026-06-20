import { describe, it, expect } from "vitest";
import { recentBtcMarketIds, bigTradeWallets, walletsInMarkets, leaderboardSmartWallets } from "../src/discovery.js";
import { filterByPnl } from "../src/pnl-filter.js";
import { Store, emptyState } from "../src/state.js";
import { maybeCopyTrade, markToMarket } from "../src/paper-executor.js";
import type { Trade, Orderbook, PaperPosition } from "../src/types.js";

import { tmpdir } from "node:os";
import { join } from "node:path";
const TMP = join(tmpdir(), `jcb-test-${Date.now()}.json`);

const trade = (over: Partial<Trade>): Trade => ({
  id: 1, ownerPubkey: "A", marketId: "m1", action: "buy", side: "yes",
  amountUsd: "10000000", priceUsd: "250000", timestamp: 1, eventTitle: "", marketTitle: "", eventId: "e1", ...over,
});

describe("discovery", () => {
  it("picks the most-recently-traded coin up/down markets (BTC/ETH/SOL/XRP) from the feed", () => {
    const trades: Trade[] = [
      trade({ id: 1, marketId: "btc-1", eventTitle: "Bitcoin Up or Down - 3:15PM", marketTitle: "Up", timestamp: 100 }),
      trade({ id: 2, marketId: "btc-2", eventTitle: "Bitcoin Up or Down - 3:30PM", marketTitle: "Down", timestamp: 300 }),
      trade({ id: 3, marketId: "sol-1", eventTitle: "Solana Up or Down", marketTitle: "Up", timestamp: 400 }),
      trade({ id: 4, marketId: "btc-3", eventTitle: "Bitcoin Up or Down - 3:45PM", marketTitle: "Up", timestamp: 500 }),
      trade({ id: 5, marketId: "doge-1", eventTitle: "Dogecoin Up or Down", marketTitle: "Up", timestamp: 600 }),
    ];
    // doge excluded (not a tracked major), sol included, ordered by ts desc
    expect(recentBtcMarketIds(trades, 3)).toEqual(["btc-3", "sol-1", "btc-2"]);
  });

  it("walletsInMarkets + bigTradeWallets filter correctly", () => {
    const trades: Trade[] = [
      trade({ id: 1, ownerPubkey: "A", marketId: "m1", amountUsd: "600000000" }),
      trade({ id: 2, ownerPubkey: "B", marketId: "mX", amountUsd: "100000000" }),
    ];
    expect(walletsInMarkets(trades, new Set(["m1"]))).toEqual(["A"]);
    expect(bigTradeWallets(trades, 500)).toEqual(["A"]); // 600 >= 500, 100 < 500
  });

  it("maps leaderboard entries to smart wallets above threshold", () => {
    const entries = [
      { ownerPubkey: "A", realizedPnlUsd: "6262628933", totalVolumeUsd: "30699379087", predictionsCount: 17, winRatePct: "70.5" },
      { ownerPubkey: "B", realizedPnlUsd: "100000000", totalVolumeUsd: "5000000", predictionsCount: 3, winRatePct: "33.3" },
    ];
    const out = leaderboardSmartWallets(entries, 300);
    expect(out.map((w) => w.ownerPubkey)).toEqual(["A"]); // 6262 >= 300, 100 < 300
    expect(out[0].pnl7dUsd).toBeCloseTo(6262.63, 2);
    expect(out[0].winRatePct).toBe(70.5);
    expect(out[0].source).toBe("leaderboard");
  });
});

describe("pnl filter", () => {
  it("keeps wallets >= threshold", async () => {
    const src = { getWeeklyPnlUsd: async (w: string) => (w === "A" ? 350 : 100) };
    const out = await filterByPnl(
      [{ ownerPubkey: "A", source: "btc" }, { ownerPubkey: "B", source: "trending" }],
      src, 300, 5
    );
    expect(out.map((w) => w.ownerPubkey)).toEqual(["A"]);
    expect(out[0].pnl7dUsd).toBe(350);
  });
});

describe("state store", () => {
  it("dedupes and promotes; save/load roundtrip", async () => {
    const s = new Store(TMP, emptyState());
    s.addCandidate("A", "btc");
    expect(s.promote({ ownerPubkey: "A", pnl7dUsd: 400, totalVolumeUsd: 0, winRatePct: 0, source: "btc", discoveredAt: 1, lastSeen: 1, verified: true })).toBe(true);
    expect(s.isTracked("A")).toBe(true);
    s.markSeen(7);
    expect(s.hasSeen(7)).toBe(true);
    await s.save();
    const s2 = await Store.load(TMP);
    expect(s2.isTracked("A")).toBe(true);
    expect(s2.hasSeen(7)).toBe(true);
  });
});

describe("paper executor", () => {
  const book: Orderbook = { yes: [[0.25, 1000]], no: [[0.75, 1000]], yes_dollars: [], no_dollars: [] };
  const deps = { getOrderbook: async () => book, isMarketOpen: async () => true };
  const limits = { fixedUsdPerTrade: 10, maxOpenPositions: 50, dailySpendCapUsd: 500, maxEntryPriceUsd: 0.95, minEntryPriceUsd: 0.02 };
  const mkTrade = (over: Partial<Trade>): Trade => ({
    id: 1, ownerPubkey: "A", marketId: "m1", action: "buy", side: "yes",
    amountUsd: "10000000", priceUsd: "250000", timestamp: 1, eventTitle: "", marketTitle: "BTC up?", eventId: "e1", ...over,
  });

  it("copies a tracked wallet buy with realistic fill+fee", async () => {
    const s = new Store(TMP + ".x", emptyState());
    s.promote({ ownerPubkey: "A", pnl7dUsd: 400, totalVolumeUsd: 0, winRatePct: 0, source: "btc", discoveredAt: 1, lastSeen: 1, verified: true });
    const r = await maybeCopyTrade(mkTrade({}), s, deps, limits);
    expect(r.status).toBe("filled");
    if (r.status === "filled") {
      expect(r.position.filledContracts).toBeCloseTo(40, 4);
      expect(r.position.feeUsd).toBeGreaterThan(0);
      expect(r.position.netCostUsd).toBeCloseTo(10 + r.position.feeUsd, 6);
    }
    // dedupe: second time skipped
    const r2 = await maybeCopyTrade(mkTrade({}), s, deps, limits);
    expect(r2.status).toBe("skipped");
  });

  it("skips untracked wallet, sells, and closed markets", async () => {
    const s = new Store(TMP + ".y", emptyState());
    s.promote({ ownerPubkey: "A", pnl7dUsd: 400, totalVolumeUsd: 0, winRatePct: 0, source: "btc", discoveredAt: 1, lastSeen: 1, verified: true });
    expect((await maybeCopyTrade(mkTrade({ id: 11, ownerPubkey: "Z" }), s, deps, limits)).status).toBe("skipped");
    expect((await maybeCopyTrade(mkTrade({ id: 12, action: "sell" }), s, deps, limits)).status).toBe("skipped");
    const closedDeps = { ...deps, isMarketOpen: async () => false };
    expect((await maybeCopyTrade(mkTrade({ id: 13 }), s, closedDeps, limits)).status).toBe("skipped");
  });

  it("skips fills priced at the extremes (no edge)", async () => {
    const s = new Store(TMP + ".p", emptyState());
    s.promote({ ownerPubkey: "A", pnl7dUsd: 400, totalVolumeUsd: 0, winRatePct: 0, source: "btc", discoveredAt: 1, lastSeen: 1, verified: true });
    // best NO bid $0.01 -> YES ask $0.99 -> capped upside, should skip
    const highBook: Orderbook = { yes: [[0.95, 1000]], no: [[0.01, 1000]], yes_dollars: [], no_dollars: [] };
    const highDeps = { getOrderbook: async () => highBook, isMarketOpen: async () => true };
    const r1 = await maybeCopyTrade(mkTrade({ id: 31 }), s, highDeps, limits);
    expect(r1.status).toBe("skipped");
    if (r1.status === "skipped") expect(r1.reason).toBe("price-too-high");
    // book at $0.01 -> dust, should skip
    const lowBook: Orderbook = { yes: [[0.01, 100000]], no: [[0.99, 1000]], yes_dollars: [], no_dollars: [] };
    const lowDeps = { getOrderbook: async () => lowBook, isMarketOpen: async () => true };
    const r2 = await maybeCopyTrade(mkTrade({ id: 32 }), s, lowDeps, limits);
    expect(r2.status).toBe("skipped");
    if (r2.status === "skipped") expect(r2.reason).toBe("price-too-low");
  });

  it("enforces daily spend cap", async () => {
    const s = new Store(TMP + ".z", emptyState());
    s.promote({ ownerPubkey: "A", pnl7dUsd: 400, totalVolumeUsd: 0, winRatePct: 0, source: "btc", discoveredAt: 1, lastSeen: 1, verified: true });
    const tight = { ...limits, dailySpendCapUsd: 5 };
    const r = await maybeCopyTrade(mkTrade({ id: 21 }), s, deps, tight);
    expect(r.status).toBe("skipped");
  });

  it("marks position to market", () => {
    const p: PaperPosition = {
      marketId: "m1", marketTitle: "x", side: "yes", filledContracts: 40, requestedUsd: 10,
      avgFillPriceUsd: 0.25, grossCostUsd: 10, feeUsd: 0.33, netCostUsd: 10.33, partial: false,
      openedFromWallet: "A", openedAt: 1,
    };
    const m = markToMarket(p, 0.4);
    expect(m.valueUsd).toBeCloseTo(16, 6);
    expect(m.unrealizedPnlUsd).toBeCloseTo(16 - 10.33, 6);
  });
});
