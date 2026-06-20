import http from "node:http";
import { promises as fs } from "node:fs";
import { config } from "./config.js";
import { JupiterClient, isOpenForTrading } from "./jupiter.js";
import { Store } from "./state.js";
import {
  recentBtcMarketIds,
  walletsInMarkets,
  bigTradeWallets,
  leaderboardSmartWallets,
} from "./discovery.js";
import { filterByPnl, mapLimit, type Candidate } from "./pnl-filter.js";
import { judge } from "./quality.js";
import { maybeCopyTrade, markToMarket, terminalValuePerContract } from "./paper-executor.js";
import type { PaperPosition } from "./types.js";
import {
  Notifier,
  renderLeaderboard,
  newSmartWalletEmbed,
  paperFillEmbed,
  paperSummaryEmbed,
  topWalletsEmbed,
  type PaperSummary,
} from "./notify.js";
import { microToUsd } from "./money.js";
import { logTrades, logWalletSnapshots, newTradesSince, logCopyFill, logBlockedFill } from "./collector.js";
import { simulateFill, askLadder, computeFee } from "./fills.js";
import { diffPositions, snapshotFrom, classifyMarket, type WatchPosition, type PosKey } from "./position-watch.js";
import { HeliusListener } from "./helius-listener.js";

const jup = new JupiterClient({
  apiBase: config.apiBase,
  apiKey: config.apiKey,
  minRequestGapMs: config.minRequestGapMs,
});
const notifier = new Notifier(config.discordWebhookUrl);

async function runDiscoveryAndFilter(store: Store): Promise<void> {
  console.log("[scan] discovery starting…");
  const fresh = await jup.getTrades().catch(() => []);
  store.accumulateTrades(fresh);
  const trades = store.recentTrades();

  // BTC scanner: wallets active in the 3 most-recently-traded BTC up/down markets
  // ~20 covers the active 5-min AND 15-min windows across BTC/ETH/SOL/XRP
  // (the title regex matches any "Up or Down" duration).
  const btcIds = new Set(recentBtcMarketIds(trades, 20));
  const btcWallets = walletsInMarkets(trades, btcIds);

  // Trending scanner: wallets with big trades (size >= MIN_TRADE_USD) in the feed
  const trendingWallets = bigTradeWallets(trades, config.minTradeUsd);

  const candidates: Candidate[] = [
    ...btcWallets.map((w) => ({ ownerPubkey: w, source: "btc" as const })),
    ...trendingWallets.map((w) => ({ ownerPubkey: w, source: "trending" as const })),
  ];
  const uniq = new Map<string, Candidate>();
  for (const c of candidates) if (!uniq.has(c.ownerPubkey)) uniq.set(c.ownerPubkey, c);
  for (const c of uniq.values()) store.addCandidate(c.ownerPubkey, c.source);

  console.log(`[scan] ${uniq.size} candidates (btc:${btcWallets.length} trending:${trendingWallets.length})`);

  const smart = await filterByPnl([...uniq.values()], jup, config.pnlThresholdUsd, config.pnlConcurrency);

  // Leaderboard source: top weekly P&L wallets, pre-scored (no extra profile call)
  const lb = await jup.getLeaderboard("pnl", "weekly", 100).catch(() => []);
  const lbWallets = leaderboardSmartWallets(lb, config.pnlThresholdUsd);
  console.log(`[scan] leaderboard source: ${lbWallets.length} wallets ≥ $${config.pnlThresholdUsd}`);

  let newlyFound = 0;
  for (const w of [...smart, ...lbWallets]) {
    if (store.promote(w)) {
      newlyFound++;
      // Instant ping only for organic real-time finds; leaderboard-sourced wallets
      // are covered by the hourly ranked Top-Wallets embed (avoids post spam).
      if (w.source !== "leaderboard") await notifier.send([newSmartWalletEmbed(w)]);
    }
  }
  console.log(`[scan] ${newlyFound} newly promoted; ${Object.keys(store.state.smartWallets).length} tracked total`);

  // Quality gate: enrich every tracked wallet with resolved /profiles stats and judge.
  await rescoreWallets(store);
  const wallets = Object.values(store.state.smartWallets);
  const verifiedCount = wallets.filter((w) => w.verified).length;
  // Funnel histogram: WHY the rest were rejected (so "0 verified" is never a
  // silent mystery — distinguishes a strict gate from a broken /profiles call).
  const reason = (w: typeof wallets[number]): string => {
    if (w.verified) return "verified";
    const v = w.verdict ?? "";
    if (v.includes("no resolved")) return "no-history";
    if (v.includes("net loser")) return "net-loser";
    if (v.includes("small sample")) return "small-sample";
    if (v.includes("weak edge")) return "weak-edge";
    return "unscored"; // never judged (e.g. /profiles failed) — the danger case
  };
  const hist: Record<string, number> = {};
  for (const w of wallets) hist[reason(w)] = (hist[reason(w)] ?? 0) + 1;
  const histStr = Object.entries(hist).map(([k, n]) => `${k}:${n}`).join(" ");
  console.log(`[judge] ${verifiedCount} verified copy-eligible of ${wallets.length} tracked — ${histStr}`);
  const api = jup.drainStats();
  console.log(`[api] ok:${api.ok} 4xx:${api.http4xx} 5xx/429:${api.http5xx} net:${api.network}`);
  // Dataset capture: per-cycle stats snapshot for every tracked wallet.
  await logWalletSnapshots(wallets, Date.now());
  console.log(renderLeaderboard(wallets));

  // Post the hourly ranked Top-Wallets leaderboard to Discord every cycle.
  await notifier.send([topWalletsEmbed(Object.values(store.state.smartWallets))]);
  await writeJsonOutputs(store);
}

/**
 * Refresh every tracked wallet with resolved /profiles stats (updates each hour
 * after the BTC up/down markets settle) and re-apply the quality gate.
 */
async function rescoreWallets(store: Store): Promise<void> {
  const wallets = Object.values(store.state.smartWallets);
  await mapLimit(wallets, config.pnlConcurrency, async (w) => {
    try {
      const stats = await jup.getProfile(w.ownerPubkey);
      const j = judge(stats, {
        minPredictions: config.minPredictions,
        minWinRatePct: config.minWinRatePct,
        requirePositiveAllTime: config.requirePositiveAllTime,
      });
      const cur = store.state.smartWallets[w.ownerPubkey];
      if (!cur) return;
      cur.allTimePnlUsd = stats.allTimePnlUsd;
      cur.predictions = j.predictions;
      cur.winRatePct = j.winRatePct;
      cur.verified = j.verified;
      cur.verdict = j.verdict;
      cur.lastSeen = Date.now();
    } catch {
      /* leave prior judgement intact on transient error */
    }
  });
}

async function runCopyPoll(store: Store): Promise<void> {
  const trades = await jup.getTrades().catch(() => []);
  store.accumulateTrades(trades);

  // Dataset capture (always on): append every newly-seen raw trade. This is the
  // durable asset for later offline wallet analysis.
  const { rows, hwm } = newTradesSince(trades, store.state.lastLoggedTradeId);
  if (rows.length > 0) {
    await logTrades(rows);
    store.state.lastLoggedTradeId = hwm;
  }

  // Pure discovery mode: collect data but don't open positions.
  if (!config.copyEnabled) return;

  for (const t of trades) {
    const out = await maybeCopyTrade(t, store, {
      getOrderbook: (id) => jup.getOrderbook(id),
      // Real status check: open + unresolved + within trading window. Conservative
      // on lookup failure (treat as closed) so we never copy into a decided market.
      isMarketOpen: (id) => jup.isMarketOpen(id).catch(() => false),
    }, {
      fixedUsdPerTrade: config.fixedUsdPerTrade,
      maxOpenPositions: config.maxOpenPositions,
      dailySpendCapUsd: config.dailySpendCapUsd,
      maxEntryPriceUsd: config.maxEntryPriceUsd,
      minEntryPriceUsd: config.minEntryPriceUsd,
    });
    if (out.status === "filled") {
      console.log(`[paper] FILL ${out.position.marketTitle} ${out.position.side} ${out.position.filledContracts.toFixed(2)}c @$${out.position.avgFillPriceUsd.toFixed(3)} net ${out.position.netCostUsd.toFixed(2)}`);
      await notifier.send([paperFillEmbed(out.position)]);
    } else if (LOGGED_SKIPS.has(out.reason)) {
      // Observability: log meaningful skips (a verified wallet's trade we declined).
      console.log(`[skip] ${out.reason} — ${t.marketTitle} ${t.side} by ${t.ownerPubkey.slice(0, 6)}…`);
    }
  }
}

// Skip reasons worth logging (a verified wallet traded but we declined).
const LOGGED_SKIPS = new Set(["price-too-high", "price-too-low", "no-liquidity", "market-closed", "max-open-positions", "daily-cap"]);

// Last seen open-positions snapshot per watched leader (in-memory; first poll is
// baseline-only so we never treat pre-existing positions as fresh entries).
const leaderSnaps = new Map<string, Map<PosKey, WatchPosition>>();
// SIM-V2: count consecutive polls a position is missing before trusting an exit
const exitMisses = new Map<string, number>();

/**
 * Capture fix: poll each watched leader's open positions, diff vs last snapshot,
 * and paper-mirror their entries (buy) and exits (sell), recording leader-price
 * vs our-fill-price (the lag cost) for each fill.
 */
const DYNAMIC_WATCHLIST = (process.env.DYNAMIC_WATCHLIST ?? "true") !== "false";
// Copy targets are driven by the scanner's verdict, not a stale .env list.
// Only wallets the rescorer marked `verified` are copy-eligible. Safety: if the
// scanner hasn't judged anything yet (cold boot, /profiles down), fall back to
// the static COPY_WATCHLIST so we never silently copy nothing.
const MIN_COPY_PREDS = Number(process.env.MIN_COPY_PREDS ?? 50);
// Reco #1 (sport orientation): among verified wallets, prefer those ACTIVE ON
// SPORT, where the copy edge survives lag. Ground truth from our realized
// copies: sport 60% win / +$71; "other" 46% / -$67; crypto 5m is blocked
// (-$361 counterfactual). Sport activity is measured from recently observed
// trades; a safe fallback chain guarantees we never copy nothing.
const SPORT_SHARE_MIN = Number(process.env.SPORT_SHARE_MIN ?? 0.4);
const SPORT_MIN_OBS = Number(process.env.SPORT_MIN_OBS ?? 3);
function sportActivity(store: Store, pubkey: string): { sport: number; total: number; share: number } {
  let sport = 0, total = 0;
  for (const t of store.recentTrades()) {
    if (t.ownerPubkey !== pubkey) continue;
    total++;
    if (classifyMarket(t.marketTitle || t.eventTitle) === "sport") sport++;
  }
  return { sport, total, share: total > 0 ? sport / total : 0 };
}
function copyTargets(store: Store): string[] {
  if (!DYNAMIC_WATCHLIST) return config.copyWatchlist;
  // Dynamic + quality floor: scorer-verified wallets with a minimum resolved
  // sample (default 50) so a lucky small-sample wallet never gets exposure.
  const verified = Object.values(store.state.smartWallets)
    .filter((w) => w.verified && (w.predictions ?? 0) >= MIN_COPY_PREDS);
  // Sport-oriented subset: enough observed sport trades AND a sport-dominant mix.
  const sportFocused = verified
    .filter((w) => {
      const a = sportActivity(store, w.ownerPubkey);
      return a.sport >= SPORT_MIN_OBS && a.share >= SPORT_SHARE_MIN;
    })
    .map((w) => w.ownerPubkey);
  if (sportFocused.length > 0) return sportFocused;
  // Fallbacks: plain verified set, then the curated watchlist — never break.
  const verifiedIds = verified.map((w) => w.ownerPubkey);
  return verifiedIds.length > 0 ? verifiedIds : config.copyWatchlist;
}

async function runWatchCopy(store: Store, wallets?: string[]): Promise<void> {
  // Gate every path (poll AND helius event) on the verified set. An explicit
  // [wallet] from the helius trigger is still filtered — a non-verified leader
  // firing an event must not bypass the verdict gate.
  const verifiedSet = new Set(copyTargets(store));
  const list = (wallets ?? [...verifiedSet]).filter((w) => verifiedSet.has(w));
  for (const wallet of list) {
    let raw: any[];
    try { raw = await jup.getPositionsRaw(wallet); } catch { continue; }
    const curr = snapshotFrom(raw);
    const prev = leaderSnaps.get(wallet);
    // API-glitch guard: a sudden empty (or mostly-empty) snapshot after a
    // populated one is almost always a degraded API response, not the leader
    // liquidating everything at once. Treating it as real caused a mass
    // fake-close, then a mass re-buy when the API recovered (2026-06-07).
    if (prev && prev.size >= 2 && curr.size === 0) {
      console.log(`[copy] glitch-guard ${wallet.slice(0, 6)} — snapshot vide après ${prev.size} positions, ignoré`);
      continue; // keep prev snapshot; retry next poll
    }
    // SIM-V2: a position vanishing for ONE poll is often a degraded API
    // response (partial snapshot), not a real exit (6% of calls 5xx/429).
    // Require 2 consecutive misses before the diff may see an exit. Costs
    // nothing in paper accuracy: the exit price comes from the carried
    // snapshot either way.
    if (prev) {
      for (const [k, pPos] of prev) {
        if (curr.has(k)) { exitMisses.delete(k); continue; }
        const misses = (exitMisses.get(k) ?? 0) + 1;
        if (misses < 2) { exitMisses.set(k, misses); curr.set(k, pPos); } // carry once
        else exitMisses.delete(k); // second miss -> let the exit event fire
      }
    }
    leaderSnaps.set(wallet, curr);
    if (!prev) continue; // baseline poll

    for (const e of diffPositions(prev, curr)) {
      const side: "yes" | "no" = e.pos.isYes ? "yes" : "no";
      const who = wallet.slice(0, 6);
      const what = e.pos.title.slice(0, 32);
      if (e.type === "entry" || e.type === "increase") {
        // Per-wallet market filter (e.g. skip 8jqF's intraday crypto casino).
        const skipRe = config.copySkip[wallet];
        if (skipRe && skipRe.test(e.pos.title)) {
          console.log(`[copy] skip filtered-market ${who} — ${what}`);
          continue;
        }
        const stake = config.copySize[wallet] ?? config.fixedUsdPerTrade;
        store.rolloverDay();
        if (store.openPositionCount() >= config.maxOpenPositions) continue;
        if (store.state.spentTodayUsd + stake > config.dailySpendCapUsd) continue;
        // Never copy into a closed/resolved market (stale books fill at $0.001).
        let mkt: any = null;
        try { mkt = await jup.getMarket(e.pos.marketId); } catch { /* treat as closed */ }
        if (!mkt || !isOpenForTrading(mkt)) { console.log(`[copy] skip market-closed ${who} ${what}`); continue; }
        let book;
        try { book = await jup.getOrderbook(e.pos.marketId); } catch { continue; }
        const fill = simulateFill(stake, askLadder(book, side));
        if (fill.filledContracts <= 0) { console.log(`[copy] skip no-liquidity ${who} ${what}`); continue; }
        // Price-band guard (same as the paper executor): extremes = no edge.
        if (fill.avgFillPriceUsd >= config.maxEntryPriceUsd) { console.log(`[copy] skip price-too-high ${who} ${what} @$${fill.avgFillPriceUsd.toFixed(3)}`); continue; }
        if (fill.avgFillPriceUsd <= config.minEntryPriceUsd) { console.log(`[copy] skip price-too-low ${who} ${what} @$${fill.avgFillPriceUsd.toFixed(3)}`); continue; }
        // Anti price-chasing: if the price already ran away from the leader's
        // entry, copying just buys their position at a worse expectancy.
        if (fill.avgFillPriceUsd - e.pos.avgPriceUsd > config.maxCopyLagUsd) {
          console.log(`[copy] skip price-chase ${who} ${what} — ask $${fill.avgFillPriceUsd.toFixed(3)} vs leader $${e.pos.avgPriceUsd.toFixed(3)} (lag ${((fill.avgFillPriceUsd - e.pos.avgPriceUsd) * 100).toFixed(1)}c > ${(config.maxCopyLagUsd * 100).toFixed(0)}c cap)`);
          continue;
        }
        // BLOCKING FILTERS — the bot must never execute what cleanpnl proved
        // toxic (live -$112, tossup -$72, qualif -$40, crypto -$13). Tags
        // mirror fill-judge exactly; blocked entries are logged for the
        // counterfactual resolver, NOT opened.
        const lagB = fill.avgFillPriceUsd - e.pos.avgPriceUsd;
        const btags: string[] = [];
        if (fill.avgFillPriceUsd >= 0.40 && fill.avgFillPriceUsd <= 0.60) btags.push("tossup");
        if (/qualif/i.test(e.pos.title)) btags.push("qualif");
        if (/up or down|all.?time high|\babove\b|bitcoin|ethereum|\bsolana\b|\bbtc\b|\beth\b/i.test(e.pos.title)) btags.push("crypto");
        if (lagB >= 0.03) btags.push("live"); // lag proxy: leader filled pre-move
        if (!btags.includes("live") && config.blockFilters.has("live")) {
          try {
            const evt = mkt?.eventId ? await jup.getEvent(mkt.eventId) : null;
            const beganAt = evt?.beginAt ? parseInt(evt.beginAt) : null;
            if (evt?.isLive === true || (beganAt && beganAt <= Date.now() / 1000)) btags.push("live");
          } catch { /* API miss: fail open, the lag proxy still covers the worst */ }
        }
        const blockedBy = btags.filter((t) => config.blockFilters.has(t));
        if (blockedBy.length) {
          await logBlockedFill({ wallet, action: e.type, marketId: e.pos.marketId,
            marketType: e.pos.marketType, side, leaderPriceUsd: e.pos.avgPriceUsd,
            ourPriceUsd: fill.avgFillPriceUsd, lagDeltaUsd: lagB,
            contracts: fill.filledContracts, costUsd: fill.netCostUsd,
            blockedBy, title: e.pos.title.slice(0, 60) });
          console.log(`[block] 🚫 ${blockedBy.join(",")} ${who} ${side} @$${fill.avgFillPriceUsd.toFixed(3)} — ${what}`);
          continue;
        }
        store.addPosition({
          marketId: e.pos.marketId, marketTitle: what, side,
          filledContracts: fill.filledContracts, requestedUsd: stake,
          avgFillPriceUsd: fill.avgFillPriceUsd, grossCostUsd: fill.grossCostUsd, feeUsd: fill.feeUsd,
          netCostUsd: fill.netCostUsd, partial: fill.partial, openedFromWallet: wallet, openedAt: Date.now(),
        });
        const lag = fill.avgFillPriceUsd - e.pos.avgPriceUsd; // we pay more than leader => +ve => edge lost
        await logCopyFill({ wallet, action: e.type, marketId: e.pos.marketId, marketType: e.pos.marketType,
          side, leaderPriceUsd: e.pos.avgPriceUsd, ourPriceUsd: fill.avgFillPriceUsd, lagDeltaUsd: lag,
          contracts: fill.filledContracts, costUsd: fill.netCostUsd, title: what });
        console.log(`[copy] FILL ${who} ${side} ${e.pos.marketType} @$${fill.avgFillPriceUsd.toFixed(3)} (leader $${e.pos.avgPriceUsd.toFixed(3)}, lag ${(lag * 100).toFixed(1)}c) — ${what}`);
        await notifier.send([paperFillEmbed(store.state.paperPositions[store.state.paperPositions.length - 1])]);
        // Smart-money confluence: independent leaders agreeing on the same side
        // of the same market is the strongest signal we have.
        const confluence = new Set(store.state.paperPositions
          .filter((p) => p.marketId === e.pos.marketId && p.side === side)
          .map((p) => p.openedFromWallet));
        if (confluence.size >= 2) {
          console.log(`[confluence] ⚡ ${confluence.size} leaders sur ${side} — ${what} (${[...confluence].map((w) => w.slice(0, 6)).join(", ")})`);
          await notifier.send([{ title: `⚡ CONFLUENCE x${confluence.size} — ${what}`, color: 0xf1c40f,
            description: `${confluence.size} leaders indépendants sur **${side.toUpperCase()}**:\n${[...confluence].map((w) => `\`${w}\``).join("\n")}` } as any]);
        }
      } else {
        // SIM-V2 exit/decrease: close ALL matching lots (not just the first),
        // pay the exit fee (selling is a trade too), and mirror a partial
        // leader trim proportionally instead of dumping a whole lot.
        const lots = store.state.paperPositions.filter(
          (p) => p.openedFromWallet === wallet && p.marketId === e.pos.marketId && p.side === side);
        if (!lots.length) continue;
        const ratio = e.type === "exit" ? 1
          : Math.min(1, Math.max(0, (e.prevContracts - e.currContracts) / Math.max(e.prevContracts, 1e-9)));
        if (ratio <= 0) continue;
        const closedNow: PaperPosition[] = [];
        for (const lot of lots) {
          const sellQty = lot.filledContracts * ratio;
          if (sellQty <= 0) continue;
          const exitFee = computeFee(e.priceUsd, sellQty);
          const proceeds = sellQty * e.priceUsd - exitFee;
          const costShare = lot.netCostUsd * ratio;
          const realized = proceeds - costShare;
          const m: PaperPosition = { ...lot,
            filledContracts: sellQty, requestedUsd: lot.requestedUsd * ratio,
            grossCostUsd: lot.grossCostUsd * ratio, feeUsd: lot.feeUsd * ratio, netCostUsd: costShare,
            markPriceUsd: e.priceUsd, valueUsd: proceeds, unrealizedPnlUsd: realized,
            resolved: true, closedAt: Date.now(), realizedPnlUsd: realized,
            outcome: realized >= 0 ? "win" : "loss" };
          (m as any).exitFeeUsd = exitFee; (m as any).simv = 2;
          closedNow.push(m);
          if (ratio < 1 - 1e-9) { // shrink the surviving lot
            lot.filledContracts -= sellQty; lot.requestedUsd -= m.requestedUsd;
            lot.grossCostUsd -= m.grossCostUsd; lot.feeUsd -= m.feeUsd; lot.netCostUsd -= costShare;
          }
        }
        if (ratio >= 1 - 1e-9) {
          store.state.paperPositions = store.state.paperPositions.filter(
            (p) => !(p.openedFromWallet === wallet && p.marketId === e.pos.marketId && p.side === side));
        }
        let tot = 0;
        for (const m of closedNow) {
          store.state.closedPositions.push(m);
          store.state.realizedPnlUsd += m.realizedPnlUsd ?? 0;
          tot += m.realizedPnlUsd ?? 0;
        }
        await logCopyFill({ wallet, action: "exit", marketId: e.pos.marketId, marketType: e.pos.marketType,
          side, leaderSellPriceUsd: e.pos.sellPriceUsd, ourSellPriceUsd: e.priceUsd, realizedPnlUsd: tot,
          lots: closedNow.length, ratio: +ratio.toFixed(3), simv: 2, title: what });
        console.log(`[copy] CLOSE ${who} ${side} @$${e.priceUsd.toFixed(3)} realized $${tot.toFixed(2)} (${closedNow.length} lot${closedNow.length > 1 ? "s" : ""}${ratio < 1 - 1e-9 ? `, trim ${(ratio * 100).toFixed(0)}%` : ""}) — ${what}`);
      }
    }
  }
  await store.save();
}

async function runMarkToMarket(store: Store): Promise<PaperSummary> {
  let totalNet = 0;
  let totalValue = 0;
  const stillOpen: PaperPosition[] = [];
  const newlyClosed: PaperPosition[] = [];

  for (const p of store.state.paperPositions) {
    // One /markets call gives us BOTH resolution status and the correct sell
    // price (pricing.sell*), so we no longer mark to the wrong side of the book.
    let sell = p.markPriceUsd ?? p.avgFillPriceUsd; // fallback: last known mark, not entry
    let terminal: number | null = null;
    try {
      const market = await jup.getMarket(p.marketId);
      terminal = terminalValuePerContract(p, market);
      if (terminal === null && market.pricing) {
        const px = p.side === "yes" ? market.pricing.sellYesPriceUsd : market.pricing.sellNoPriceUsd;
        if (px > 0) sell = microToUsd(px);
      }
    } catch { /* keep entry price; leave open */ }

    if (terminal !== null) {
      // Resolved: realize and close.
      const m = markToMarket(p, terminal);
      m.resolved = true;
      m.closedAt = Date.now();
      m.realizedPnlUsd = m.unrealizedPnlUsd;
      m.outcome = terminal >= 1 ? "win" : terminal <= 0 ? "loss" : "refund";
      newlyClosed.push(m);
      console.log(`[close] ${m.outcome} ${m.marketTitle} ${m.side} — realized ${(m.realizedPnlUsd ?? 0).toFixed(2)}`);
    } else {
      const m = markToMarket(p, sell);
      stillOpen.push(m);
      totalNet += m.netCostUsd;
      totalValue += m.valueUsd ?? 0;
    }
  }

  store.settle(stillOpen, newlyClosed);
  // Clean P&L: strip cleanpnl-proven toxic patterns (tossup/qualif/crypto) from
  // the realized total so the webhook shows the FILTERED strategy's true edge
  // alongside the raw historical number. The live 'live'-lag tag is not
  // retroactively computable (leader price not stored), so clean approximates
  // forward perf from the three title/price-derivable toxic buckets.
  const TOXIC_CRYPTO = /up or down|all.?time high|\babove\b|bitcoin|ethereum|\bsolana\b|\bbtc\b|\beth\b/i;
  let realizedClean = 0, closedCleanCount = 0;
  for (const m of store.state.closedPositions) {
    const p = m.avgFillPriceUsd ?? 0;
    const title = m.marketTitle ?? "";
    const toxic = (p >= 0.40 && p <= 0.60) || /qualif/i.test(title) || TOXIC_CRYPTO.test(title);
    if (!toxic) { realizedClean += m.realizedPnlUsd ?? 0; closedCleanCount++; }
  }
  return {
    openPositions: stillOpen.length,
    trackedWallets: Object.keys(store.state.smartWallets).length,
    totalNetCost: totalNet,
    totalValue,
    unrealizedPnl: totalValue - totalNet,
    realizedPnl: store.state.realizedPnlUsd,
    closedCount: store.state.closedPositions.length,
    realizedClean,
    closedCleanCount,
  };
}

// Serialize every loop that mutates paperPositions. Without this, runMarkToMarket
// snapshots the array, awaits one /markets call per position, then settle()
// REPLACES the array — wiping any position runWatchCopy added meanwhile. It also
// let snapTimer + summaryTimer run runMarkToMarket concurrently, double/triple
// realizing the same resolved position (Orioles was closed 3x overnight).
let mutateChain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = mutateChain.then(fn);
  mutateChain = next.catch(() => {});
  return next;
}

async function writeJsonOutputs(store: Store): Promise<void> {
  await fs.mkdir("state", { recursive: true });
  await fs.writeFile("state/smart-wallets.json", JSON.stringify(Object.values(store.state.smartWallets), null, 2));
  await fs.writeFile("state/paper-positions.json", JSON.stringify(store.state.paperPositions, null, 2));
  await fs.writeFile("state/closed-positions.json", JSON.stringify(store.state.closedPositions, null, 2));
}

async function main(): Promise<void> {
  if (!config.apiKey) {
    console.error("Missing JUP_API_KEY — copy .env.example to .env and fill it in.");
    process.exit(1);
  }
  const once = process.argv.includes("--once");
  const store = await Store.load(config.stateFile);

  if (once) {
    await runDiscoveryAndFilter(store);
    await store.save();
    console.log("[once] done.");
    return;
  }

  console.log("🚀 Jupiter Smart-Money Scanner — PAPER mode. Ctrl+C to stop.");
  await runDiscoveryAndFilter(store);

  const scanTimer = setInterval(() => runDiscoveryAndFilter(store).catch(console.error), config.scanIntervalMin * 60_000);
  const pollTimer = setInterval(() => serialized(() => runCopyPoll(store)).catch(console.error), config.copyPollSec * 1000);
  // Leader position-diff copying (the capture fix): paper-mirror the watchlist.
  let watchTimer: NodeJS.Timeout | undefined;
  let helius: HeliusListener | undefined;
  const copyList = copyTargets(store);
  if (config.watchEnabled && copyList.length > 0) {
    // With Helius push the poll is just a slow safety net (saves Jupiter RPS).
    const pollSec = config.heliusWsUrl ? Math.max(config.watchPollSec, 60) : config.watchPollSec;
    console.log("=== SIM-V2 actif: exit fees + all-lots close + trims proportionnels + confirmation exit 2-polls ===");
    console.log(`👁️  watch-copy actif sur ${copyList.length} wallets verified (poll ${pollSec}s${config.heliusWsUrl ? " + helius ws" : ""}): ${copyList.map((w) => w.slice(0, 6)).join(", ")}`);
    watchTimer = setInterval(() => serialized(() => runWatchCopy(store)).catch(console.error), pollSec * 1000);
    if (config.heliusWsUrl) {
      // Debounce per wallet — leading edge + cooldown. A reset-on-every-event
      // debounce never fires during sustained bursts (8jqF scalping 5-min
      // binaries emits events continuously); and firing per event would waste
      // API budget. Instead: schedule once 1.5s after the first event (lets the
      // positions API index the trade), then at most one poll per cooldown.
      const POLL_DELAY_MS = 1_500, COOLDOWN_MS = 10_000;
      const pending = new Map<string, NodeJS.Timeout>();
      const lastPoll = new Map<string, number>();
      const triggerWallet = (wallet: string) => {
        if (pending.has(wallet)) return; // a poll is already scheduled
        const sinceLast = Date.now() - (lastPoll.get(wallet) ?? 0);
        const wait = Math.max(POLL_DELAY_MS, COOLDOWN_MS - sinceLast);
        pending.set(wallet, setTimeout(() => {
          pending.delete(wallet);
          lastPoll.set(wallet, Date.now());
          serialized(() => runWatchCopy(store, [wallet])).catch(console.error);
        }, wait));
      };
      helius = new HeliusListener(config.heliusWsUrl, copyList, triggerWallet,
        () => serialized(() => runWatchCopy(store)).catch(console.error));
      helius.start();
      // Helius webhook receiver — free-plan redundancy for the websocket. A raw
      // webhook on the same wallets POSTs here; we extract which watched wallet
      // is involved and ring the same bell (debounced, so WS+webhook dedupe).
      const hookSecret = process.env.HOOK_SECRET;
      if (hookSecret) {
        const watchSet = new Set(config.copyWatchlist);
        http.createServer((req, res) => {
          if (req.method !== "POST" || req.url !== `/hook/${hookSecret}`) { res.writeHead(404); res.end(); return; }
          let body = "";
          req.on("data", (c) => { body += c; if (body.length > 4_000_000) req.destroy(); });
          req.on("end", () => {
            res.writeHead(200); res.end("ok");
            try {
              const txs = JSON.parse(body);
              const hit = new Set<string>();
              for (const tx of Array.isArray(txs) ? txs : [txs]) {
                const keys = tx?.transaction?.message?.accountKeys ?? tx?.accountKeys ?? [];
                for (const k of keys) {
                  const addr = typeof k === "string" ? k : k?.pubkey;
                  if (addr && watchSet.has(addr)) hit.add(addr);
                }
              }
              for (const w of hit) { console.log(`[webhook] activity ${w.slice(0, 6)}…`); triggerWallet(w); }
            } catch {}
          });
        }).listen(8787, () => console.log("[webhook] receiver on :8787"));
      }
    }
  }
  const snapTimer = setInterval(async () => {
    const summary = await serialized(() => runMarkToMarket(store)).catch(() => null);
    await store.save();
    await writeJsonOutputs(store);
    if (summary) console.log(`[mtm] open:${summary.openPositions} uPnL:$${summary.unrealizedPnl.toFixed(2)} | closed:${summary.closedCount ?? 0} rPnL brut:$${(summary.realizedPnl ?? 0).toFixed(2)} | clean:$${(summary.realizedClean ?? 0).toFixed(2)} (${summary.closedCleanCount ?? 0})`);
  }, config.snapshotSec * 1000);

  // hourly summary embed
  const summaryTimer = setInterval(async () => {
    const summary = await serialized(() => runMarkToMarket(store)).catch(() => null);
    if (summary) await notifier.send([paperSummaryEmbed(summary)]);
  }, 60 * 60_000);

  const shutdown = async () => {
    clearInterval(scanTimer); clearInterval(pollTimer); clearInterval(snapTimer); clearInterval(summaryTimer);
    if (watchTimer) clearInterval(watchTimer);
    if (helius) helius.stop();
    await store.save();
    console.log("\n💾 state saved. bye.");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
