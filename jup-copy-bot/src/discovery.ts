import type { Trade, LeaderboardEntry, SmartWallet } from "./types.js";
import { microToUsd } from "./money.js";

/**
 * Turn weekly leaderboard entries into SmartWallet records for those at/above
 * the P&L threshold. These come pre-scored (pnl, volume, win rate) so they need
 * no extra /profiles call.
 */
export function leaderboardSmartWallets(
  entries: LeaderboardEntry[],
  thresholdUsd: number,
  now = Date.now()
): SmartWallet[] {
  const out: SmartWallet[] = [];
  for (const e of entries) {
    const pnl = microToUsd(e.realizedPnlUsd);
    if (pnl < thresholdUsd) continue;
    out.push({
      ownerPubkey: e.ownerPubkey,
      pnl7dUsd: pnl,
      totalVolumeUsd: microToUsd(e.totalVolumeUsd),
      winRatePct: Number(e.winRatePct) || 0,
      source: "leaderboard",
      discoveredAt: now,
      lastSeen: now,
    });
  }
  return out;
}

// 5-min up/down binaries across the majors — discovery honeypots: the most
// active wallets surface here first. (We DISCOVER through them; copying these
// markets is a separate decision.)
const COIN_RE = /\b(bitcoin|btc|ethereum|eth|solana|sol|xrp|ripple)\b/i;
const UPDOWN_RE = /\b(up|down)\b/i;

function isCoinUpDown(t: Trade): boolean {
  const text = `${t.eventTitle} ${t.marketTitle}`;
  return COIN_RE.test(text) && UPDOWN_RE.test(text);
}

/**
 * The N most-recently-traded coin up/down markets seen in the (accumulated)
 * feed. Returns marketIds ordered by latest trade timestamp desc.
 */
export function recentBtcMarketIds(trades: Trade[], n = 3): string[] {
  const latest = new Map<string, number>();
  for (const t of trades) {
    if (!isCoinUpDown(t)) continue;
    const prev = latest.get(t.marketId) ?? 0;
    if (t.timestamp >= prev) latest.set(t.marketId, t.timestamp);
  }
  return [...latest.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([id]) => id);
}

/** Wallets that traded in the given set of market IDs (from the trades feed). */
export function walletsInMarkets(trades: Trade[], marketIds: Set<string>): string[] {
  const set = new Set<string>();
  for (const t of trades) {
    if (marketIds.has(t.marketId)) set.add(t.ownerPubkey);
  }
  return [...set];
}

/** Wallets whose trade notional (amountUsd is the USD size, micro-USD) >= minUsd. */
export function bigTradeWallets(trades: Trade[], minUsd: number): string[] {
  const set = new Set<string>();
  for (const t of trades) {
    if (microToUsd(t.amountUsd) >= minUsd) set.add(t.ownerPubkey);
  }
  return [...set];
}
