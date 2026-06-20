// Shared domain + API types for the Jupiter Prediction copy-trade bot.

export interface Trade {
  id: number;
  ownerPubkey: string;
  marketId: string;
  timestamp: number;
  action: "buy" | "sell";
  side: "yes" | "no";
  eventTitle: string;
  marketTitle: string;
  amountUsd: string; // micro-USD as string
  priceUsd: string; // micro-USD as string
  eventId: string;
}

export interface Orderbook {
  // Normalized by JupiterClient.getOrderbook to USD prices. Raw API delivers
  // yes/no in integer cents (1 === $0.01); we convert on the way in.
  yes: [number, number][];
  no: [number, number][];
  // Authoritative dollar ladders straight from the API (price as a string).
  yes_dollars: [number | string, number][];
  no_dollars: [number | string, number][];
}

export interface Market {
  marketId: string;
  status: "open" | "closed" | "cancelled" | string;
  result: "" | "pending" | "yes" | "no" | null;
  openTime?: number; // unix seconds
  closeTime?: number; // unix seconds — trading ends at/after this
  pricing?: {
    buyYesPriceUsd: number; // micro-USD
    sellYesPriceUsd: number; // micro-USD — what we'd realize selling a YES contract
    buyNoPriceUsd: number;
    sellNoPriceUsd: number;
  };
}

export interface ProfilePnlPoint {
  timestamp: number;
  realizedPnlUsd: string;
}

export interface LeaderboardEntry {
  ownerPubkey: string;
  realizedPnlUsd: string;
  totalVolumeUsd: string;
  predictionsCount: number;
  winRatePct: string;
}

// ---- Domain ----

export interface SmartWallet {
  ownerPubkey: string;
  pnl7dUsd: number;
  totalVolumeUsd: number;
  winRatePct: number;
  source: "btc" | "trending" | "leaderboard";
  discoveredAt: number;
  lastSeen: number;
  // quality enrichment (post-resolution stats from /profiles)
  allTimePnlUsd?: number;
  predictions?: number;
  verified?: boolean; // passed the quality gate -> copy-eligible
  verdict?: string; // human-readable judgement
}

export interface ProfileStats {
  allTimePnlUsd: number;
  volumeUsd: number;
  correct: number;
  wrong: number;
}

export interface PaperPosition {
  marketId: string;
  marketTitle: string;
  side: "yes" | "no";
  filledContracts: number;
  requestedUsd: number;
  avgFillPriceUsd: number;
  grossCostUsd: number;
  feeUsd: number;
  netCostUsd: number;
  partial: boolean;
  openedFromWallet: string;
  openedAt: number;
  // mark-to-market
  markPriceUsd?: number;
  valueUsd?: number;
  unrealizedPnlUsd?: number;
  // set once the market resolves and the position is realized + closed
  resolved?: boolean;
  closedAt?: number;
  realizedPnlUsd?: number;
  outcome?: "win" | "loss" | "refund";
}

export interface BotState {
  candidates: Record<string, { source: SmartWallet["source"]; firstSeen: number }>;
  smartWallets: Record<string, SmartWallet>;
  seenTrades: number[];
  paperPositions: PaperPosition[];
  closedPositions: PaperPosition[]; // realized at resolution
  realizedPnlUsd: number; // running total of realized P&L
  lastLoggedTradeId: number; // high-water mark for append-only trade capture
  spentTodayUsd: number;
  spentDay: string; // YYYY-MM-DD bucket
}
