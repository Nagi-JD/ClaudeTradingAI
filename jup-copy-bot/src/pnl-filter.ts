import type { SmartWallet } from "./types.js";

export interface PnlSource {
  getWeeklyPnlUsd(ownerPubkey: string): Promise<number>;
}

/** Run an async mapper over items with bounded concurrency. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface Candidate {
  ownerPubkey: string;
  source: SmartWallet["source"];
}

/**
 * Keep candidates whose 7-day realized P&L >= threshold; build SmartWallet records.
 * Failures (unknown profile) are treated as below-threshold and dropped.
 */
export async function filterByPnl(
  candidates: Candidate[],
  source: PnlSource,
  thresholdUsd: number,
  concurrency: number,
  now = Date.now()
): Promise<SmartWallet[]> {
  const scored = await mapLimit(candidates, concurrency, async (c) => {
    let pnl = 0;
    try {
      pnl = await source.getWeeklyPnlUsd(c.ownerPubkey);
    } catch {
      pnl = -Infinity;
    }
    return { c, pnl };
  });
  return scored
    .filter((s) => s.pnl >= thresholdUsd)
    .map((s) => ({
      ownerPubkey: s.c.ownerPubkey,
      pnl7dUsd: s.pnl,
      totalVolumeUsd: 0,
      winRatePct: 0,
      source: s.c.source,
      discoveredAt: now,
      lastSeen: now,
    }));
}
