import "dotenv/config";

function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function str(name: string, def: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? def : v;
}

export const config = {
  apiKey: str("JUP_API_KEY", ""),
  apiBase: str("JUP_API_BASE", "https://api.jup.ag/prediction/v1"),
  provider: str("PROVIDER", "polymarket"),
  fixedUsdPerTrade: num("FIXED_USD_PER_TRADE", 10),
  pnlThresholdUsd: num("PNL_THRESHOLD_USD", 300),
  minTradeUsd: num("MIN_TRADE_USD", 500),
  // quality gate (judged on resolved data)
  minPredictions: num("MIN_PREDICTIONS", 20),
  minWinRatePct: num("MIN_WIN_RATE_PCT", 54),
  requirePositiveAllTime: str("REQUIRE_POSITIVE_ALLTIME", "true") === "true",
  scanIntervalMin: num("SCAN_INTERVAL_MIN", 60),
  copyPollSec: num("COPY_POLL_SEC", 12),
  snapshotSec: num("SNAPSHOT_SEC", 30),
  pnlConcurrency: num("PNL_CONCURRENCY", 5),
  maxOpenPositions: num("MAX_OPEN_POSITIONS", 50),
  dailySpendCapUsd: num("DAILY_SPEND_CAP_USD", 500),
  maxEntryPriceUsd: num("MAX_ENTRY_PRICE_USD", 0.95),
  minEntryPriceUsd: num("MIN_ENTRY_PRICE_USD", 0.02),
  discordWebhookUrl: str("DISCORD_WEBHOOK_URL", ""),
  stateFile: str("STATE_FILE", "state/state.json"),
  // Floor spacing between API requests (~6.6 req/s at 150ms) to stay under the
  // shared rate-limit bucket; the client also adapts to x-ratelimit-* headers.
  minRequestGapMs: num("MIN_REQUEST_GAP_MS", 150),
  // false => pure discovery/data-collection mode: keep finding wallets and
  // logging the dataset, but don't open paper positions.
  copyEnabled: str("COPY_ENABLED", "true") === "true",
  // Leader position-diff copying: paper-copy these wallets by polling their
  // open positions and mirroring entries/exits. The real capture fix.
  watchEnabled: str("WATCH_ENABLED", "true") === "true",
  watchPollSec: num("WATCH_POLL_SEC", 8),
  // Anti price-chasing: skip a copy when our fill would be this much worse than
  // the leader's avg price (price already ran away — e.g. averaging up during a
  // live UFC fight cost us +27.6c overnight). Lag is fill - leaderAvg in USD.
  maxCopyLagUsd: num("MAX_COPY_LAG_USD", 0.05),
  // Toxic patterns the bot must NEVER execute (cleanpnl-proven): blocking, not
  // shadow. Toggle via BLOCK_FILTERS="live,tossup,qualif,crypto" ("" = off).
  blockFilters: new Set(
    (process.env.BLOCK_FILTERS ?? "live,tossup,qualif,crypto")
      .split(",").map((s) => s.trim()).filter(Boolean)),
  // Helius websocket (push detection of leader trades, ~1s). When set, the
  // positions poll becomes a slow fallback (helius drives the fast path).
  heliusWsUrl: str("HELIUS_WS_URL", ""),
  // Per-wallet copy filters: "wallet:regex,wallet:regex" — skip copying when
  // the event title matches (e.g. 8jqF's intraday crypto thresholds, where he
  // demonstrably bleeds; his long-horizon longshots remain copied).
  copySkip: Object.fromEntries(
    str("COPY_SKIP", "").split(",").filter(Boolean).map((pair) => {
      const i = pair.indexOf(":");
      return [pair.slice(0, i), new RegExp(pair.slice(i + 1), "i")] as const;
    })
  ) as Record<string, RegExp>,
  // Per-wallet stake overrides: "wallet:usd,wallet:usd" (default fixedUsdPerTrade).
  copySize: Object.fromEntries(
    str("COPY_SIZE", "").split(",").filter(Boolean).map((pair) => {
      const i = pair.indexOf(":");
      return [pair.slice(0, i), Number(pair.slice(i + 1))] as const;
    })
  ) as Record<string, number>,
  copyWatchlist: str(
    "COPY_WATCHLIST",
    "1koh3PBEAb2WDk8ED4yV4GayLuEgBozxVpcJaQBvGv1,Ahef449LHqxKeQzhcJQAQ9F8m9hnwTZSVnomVLDh3bc2"
  ).split(",").map((s) => s.trim()).filter(Boolean),
};

export type Config = typeof config;
