import { microToUsd } from "./money.js";

// A leader wallet's open position as exposed by GET /positions?ownerPubkey=.
// USD fields are micro-USD; contracts is a plain integer.
export interface WatchPosition {
  owner: string;
  marketId: string;
  isYes: boolean;
  contracts: number;
  avgPriceUsd: number; // leader's average entry price
  markPriceUsd: number; // current mark (what we'd pay to enter the same side)
  sellPriceUsd: number; // current bid (what we'd get exiting)
  title: string;
  marketType: "5m" | "sport" | "evt";
}

export function classifyMarket(title: string): "5m" | "sport" | "evt" {
  const e = (title || "").toLowerCase();
  if (/up or down|updown/.test(e)) return "5m";
  if (/ vs |bo3|cup| match|series|qualif/.test(e)) return "sport";
  return "evt";
}

export function normalizePosition(r: any): WatchPosition {
  const title = r?.eventMetadata?.title || r?.marketMetadata?.title || r?.marketTitle || r?.marketId || "";
  return {
    owner: r.ownerPubkey || r.owner,
    marketId: r.marketId,
    isYes: !!r.isYes,
    contracts: Number(r.contracts) || 0,
    avgPriceUsd: microToUsd(r.avgPriceUsd ?? 0),
    markPriceUsd: microToUsd(r.markPriceUsd ?? 0),
    sellPriceUsd: microToUsd(r.sellPriceUsd ?? 0),
    title,
    marketType: classifyMarket(title),
  };
}

export type PosKey = string;
export const posKey = (p: { owner: string; marketId: string; isYes: boolean }): PosKey =>
  p.owner + "|" + p.marketId + "|" + (p.isYes ? "Y" : "N");

export interface CopyEvent {
  type: "entry" | "increase" | "exit" | "decrease";
  pos: WatchPosition;
  prevContracts: number;
  currContracts: number;
  priceUsd: number; // entry: mark price (we buy); exit: sell price (we sell)
}

/**
 * Diff two position snapshots of a leader to detect what they just did.
 * New key => entry; more contracts => increase; gone => exit; fewer => decrease.
 */
export function diffPositions(
  prev: Map<PosKey, WatchPosition>,
  curr: Map<PosKey, WatchPosition>
): CopyEvent[] {
  const ev: CopyEvent[] = [];
  for (const [k, c] of curr) {
    const p = prev.get(k);
    if (!p) ev.push({ type: "entry", pos: c, prevContracts: 0, currContracts: c.contracts, priceUsd: c.markPriceUsd });
    else if (c.contracts > p.contracts + 1e-9)
      ev.push({ type: "increase", pos: c, prevContracts: p.contracts, currContracts: c.contracts, priceUsd: c.markPriceUsd });
  }
  for (const [k, p] of prev) {
    const c = curr.get(k);
    if (!c) ev.push({ type: "exit", pos: p, prevContracts: p.contracts, currContracts: 0, priceUsd: p.sellPriceUsd });
    else if (c.contracts < p.contracts - 1e-9)
      ev.push({ type: "decrease", pos: c, prevContracts: p.contracts, currContracts: c.contracts, priceUsd: c.sellPriceUsd });
  }
  return ev;
}

/** Build a keyed snapshot from a raw /positions payload. */
export function snapshotFrom(raw: any[]): Map<PosKey, WatchPosition> {
  const m = new Map<PosKey, WatchPosition>();
  for (const r of raw) {
    const p = normalizePosition(r);
    if (p.marketId && p.contracts > 0) m.set(posKey(p), p);
  }
  return m;
}
