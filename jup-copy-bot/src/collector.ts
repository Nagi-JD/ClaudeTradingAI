import { promises as fs } from "node:fs";
import path from "node:path";
import type { Trade, SmartWallet } from "./types.js";

// Append-only dataset for later offline analysis (which wallets are copyable).
// The raw trade feed is ephemeral on the API side, so capturing it is the
// durable asset — strategy is replaceable, the dataset is not.
const DATA_DIR = "data";

/**
 * Pure de-dup: keep only trades newer than the high-water mark and return the
 * advanced mark. Trade ids are monotonic, so a single watermark is enough.
 */
export function newTradesSince(
  trades: Trade[],
  lastId: number
): { rows: Trade[]; hwm: number } {
  const rows = trades.filter((t) => t.id > lastId);
  const hwm = trades.reduce((m, t) => Math.max(m, t.id), lastId);
  return { rows, hwm };
}

async function appendJsonl(file: string, rows: unknown[]): Promise<void> {
  if (rows.length === 0) return;
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.appendFile(path.join(DATA_DIR, file), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

/** Append newly-seen trades (every owner, every market — buys and sells). */
export async function logTrades(trades: Trade[]): Promise<void> {
  await appendJsonl(
    "trades.jsonl",
    trades.map((t) => ({
      ts: t.timestamp,
      id: t.id,
      owner: t.ownerPubkey,
      marketId: t.marketId,
      eventId: t.eventId,
      eventTitle: t.eventTitle,
      marketTitle: t.marketTitle,
      action: t.action,
      side: t.side,
      priceUsd: t.priceUsd, // leader's entry price (micro-USD) — for lag/edge analysis
      amountUsd: t.amountUsd,
    }))
  );
}

/**
 * Append a copy fill/close record — the lag dataset: leader price vs our price.
 * This is what answers "does the edge survive our latency after fees?".
 */
export async function logCopyFill(rec: Record<string, unknown>): Promise<void> {
  await appendJsonl("copy-fills.jsonl", [{ ts: Math.floor(Date.now() / 1000), ...rec }]);
}

/** Entries the blocking filters refused — kept for counterfactual resolution. */
export async function logBlockedFill(rec: Record<string, unknown>): Promise<void> {
  await appendJsonl("blocked-fills.jsonl", [{ ts: Math.floor(Date.now() / 1000), ...rec }]);
}

/** Append a per-cycle stats snapshot for every tracked wallet (time series). */
export async function logWalletSnapshots(wallets: SmartWallet[], cycleTs: number): Promise<void> {
  await appendJsonl(
    "wallet-snapshots.jsonl",
    wallets.map((w) => ({
      ts: cycleTs,
      pubkey: w.ownerPubkey,
      source: w.source,
      predictions: w.predictions ?? null,
      winRatePct: w.winRatePct ?? null,
      allTimePnlUsd: w.allTimePnlUsd ?? null,
      pnl7dUsd: w.pnl7dUsd,
      verified: w.verified ?? false,
      verdict: w.verdict ?? null,
      discoveredAt: w.discoveredAt,
      lastSeen: w.lastSeen,
    }))
  );
}
