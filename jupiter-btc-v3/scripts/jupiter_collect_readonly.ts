// scripts/jupiter_collect_readonly.ts
//
// READ-ONLY research collector. Loads config, constructs the (fail-safe) Jupiter
// client, runs the strategy once, and logs every decision to disk so the run can
// be replayed and calibrated later. It NEVER places an order — the client's
// createOrder is a hard wall and the strategy only ever builds paper trades in
// dry-run. This script just orchestrates and summarizes.
//
// Run:  npx tsx scripts/jupiter_collect_readonly.ts
//       (or)  npm run jupiter:collect

import { loadConfig } from "../src/config/load_config";
import { JupiterPredictionClient } from "../src/jupiter_prediction/client";
import { JupiterBtcStrategy } from "../src/strategy/jupiter_btc_strategy";
import { SnapshotLogger } from "../src/logging/snapshot_logger";
import { DecisionLogger } from "../src/logging/decision_logger";
import {
  startProxyPollers,
  getLatestConsensus,
} from "../src/pricing/proxy_index";
import { fetchChainlinkBtcUsd } from "../src/pricing/chainlink_feed";
import { mkdirSync, appendFileSync } from "node:fs";
import type { StrategyDecision } from "../src/jupiter_prediction/models";

// ───────────────────────────────────────────────────────── tiny ANSI utils ──
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};
function paint(s: string, ...codes: string[]): string {
  return `${codes.join("")}${s}${C.reset}`;
}

/** Startup banner — every script prints this. */
function printBanner(title: string, flags: {
  readOnly: boolean;
  dryRun: boolean;
  enableLiveTrading: boolean;
  liveTradingPermitted: boolean;
}): void {
  const line = "─".repeat(64);
  console.log(paint(line, C.gray));
  console.log(paint(`  ${title}`, C.bold, C.cyan));
  console.log(
    `  READ_ONLY=${flags.readOnly}  DRY_RUN=${flags.dryRun}  ENABLE_LIVE_TRADING=${flags.enableLiveTrading}`,
  );
  if (flags.liveTradingPermitted) {
    // Should never happen in this build, but be explicit if it ever does.
    console.log(paint("  LIVE TRADING: PERMITTED BY FLAGS — but orders are NEVER sent by this build.", C.red, C.bold));
  } else {
    console.log(paint("  LIVE TRADING: DISABLED", C.green, C.bold));
  }
  console.log(paint(line, C.gray));
}

function pad(s: string, w: number): string {
  const str = String(s);
  return str.length >= w ? str : str + " ".repeat(w - str.length);
}

function signalColor(signal: string): string {
  if (signal === "YES_EDGE" || signal === "NO_EDGE") return C.green;
  if (signal === "NO_TRADE" || signal === "BASELINE_ONLY") return C.gray;
  return C.yellow; // any blocking signal
}

async function main(): Promise<void> {
  let loaded;
  try {
    loaded = loadConfig();
  } catch (err) {
    console.error(paint("FATAL: failed to load config.", C.red, C.bold), err);
    process.exitCode = 1;
    return;
  }

  printBanner("Jupiter BTC V3 — READ-ONLY Collector", loaded.flags);
  console.log(paint(`  config: ${loaded.configPath}`, C.dim));

  if (!loaded.env.jupiterApiKey) {
    console.log(
      paint(
        "  WARNING: JUPITER_API_KEY is missing. The client will return ok:false for\n" +
          "  every request, so no live markets will be discovered. The full pipeline is\n" +
          "  still exercised end-to-end (offline) to demonstrate the wiring.",
        C.yellow,
      ),
    );
  }
  console.log("");

  const client = new JupiterPredictionClient({
    baseUrl: loaded.config.jupiter.baseUrl,
    apiKey: loaded.env.jupiterApiKey,
    timeoutMs: loaded.config.jupiter.requestTimeoutMs,
    maxRetries: loaded.config.jupiter.maxRetries,
    liveTradingPermitted: loaded.flags.liveTradingPermitted,
  });

  // Proxy research mode: start the free Pyth (primary proxy index) + Binance
  // (basis cross-check) pollers BEFORE the loop so vol RV windows warm up.
  if (loaded.flags.allowProxyIndex) {
    startProxyPollers();
    console.log(
      paint(
        "  PROXY INDEX: ON — multi-source USD consensus (Pyth/Coinbase/Kraken median; Binance=USDT monitor).",
        C.yellow,
        C.bold,
      ),
    );
    // PASSIVE calibration meter: log the on-chain Chainlink Data Feed next to the
    // consensus on an interval — NO analysis, just accumulate samples (with age,
    // so a later bias calc can filter to calm+fresh). Started now so samples pile
    // up during warm+collect; the bias/cushion-shrink pipeline is built LATER and
    // ONLY if the 15-min read shows an edge worth chasing into the 5-min.
    try {
      mkdirSync("data/jupiter_calibration", { recursive: true });
      const calMs = Math.max(10000, Number(process.env.CHAINLINK_LOG_MS ?? 20000));
      const calTimer = setInterval(() => {
        void (async () => {
          try {
            const cl = await fetchChainlinkBtcUsd();
            const c = getLatestConsensus();
            if (!cl || !c) return;
            appendFileSync(
              "data/jupiter_calibration/chainlink.jsonl",
              JSON.stringify({
                tMs: Date.now(),
                consensusMedian: c.median,
                dispersionBps: c.dispersionBps,
                nSources: c.nSources,
                chainlinkPrice: cl.price,
                chainlinkUpdatedAtMs: cl.updatedAtMs,
                chainlinkAgeMs: cl.ageMs,
                driftBps: ((c.median - cl.price) / cl.price) * 10000,
              }) + "\n",
            );
          } catch { /* never let calibration logging affect the run */ }
        })();
      }, calMs);
      if (typeof (calTimer as { unref?: () => void }).unref === "function") (calTimer as { unref: () => void }).unref();
      console.log(paint(`  CHAINLINK CALIBRATION METER: ON — logging feed↔consensus every ${calMs}ms (passive, no analysis).`, C.dim));
    } catch { /* ignore */ }
    console.log(
      paint(
        "  NOTE: proxy is NOT settlement-grade. Verdicts stay low-confidence; this measures edge/basis only.",
        C.dim,
      ),
    );
    console.log("");
  }

  const strategy = new JupiterBtcStrategy({ loaded, client });

  // Loggers. Decisions go to data/jupiter_decisions (replay reads any .jsonl
  // there). Market snapshots + a mirror of decisions go to data/jupiter_snapshots.
  const decisionLogger = new DecisionLogger("data/jupiter_decisions");
  const snapshotLogger = new SnapshotLogger("data/jupiter_snapshots");

  // ── one cycle: discover → evaluate → persist → return decisions ─────────
  async function runCycle(): Promise<StrategyDecision[]> {
    let decisions: StrategyDecision[] = [];
    try {
      decisions = await strategy.runOnce();
    } catch (err) {
      console.error(paint("  runOnce() threw (unexpected); continuing with no decisions.", C.red), err);
      decisions = [];
    }
    for (const d of decisions) {
      try {
        snapshotLogger.logMarket(d.market);
        snapshotLogger.logDecision(d);
        decisionLogger.log(d);
      } catch {
        // loggers are fail-safe; never let logging abort the run
      }
    }
    return decisions;
  }

  // ── 24/7 LOOP MODE (COLLECT_LOOP=true) ──────────────────────────────────
  // Runs forever, one compact line per cycle, so a systemd unit can keep it up
  // H24 to accumulate maximum market history. Still 100% read-only.
  if ((process.env.COLLECT_LOOP ?? "").toLowerCase() === "true") {
    const intervalMs = Math.max(2000, Number(process.env.COLLECT_INTERVAL_MS ?? 10000));
    console.log(paint(`  LOOP MODE: collecting every ${intervalMs}ms (Ctrl+C to stop).`, C.cyan, C.bold));
    console.log("");
    let cycle = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      cycle += 1;
      const t0 = Date.now();
      const decisions = await runCycle();
      let nt = 0, pt = 0, lb = 0;
      // Research stats: where a fair value was computable, surface the measured
      // gross edge / basis / confidence so the verdict is visible live even
      // though proxy mode never trades.
      let priced = 0;
      let bestEdge = 0; // max |gross edge| across markets this cycle
      let basisSum = 0, basisN = 0;
      let confSum = 0, confN = 0;
      for (const d of decisions) {
        if (d.action === "PAPER_TRADE") pt += 1;
        else if (d.action === "LIVE_ORDER_BLOCKED") lb += 1;
        else nt += 1;
        const fv = d.fairValue;
        if (fv && Number.isFinite(fv.fairYesTilted as number)) {
          priced += 1;
          const eY = Number.isFinite(fv.edgeYesGross as number) ? Math.abs(fv.edgeYesGross as number) : 0;
          const eN = Number.isFinite(fv.edgeNoGross as number) ? Math.abs(fv.edgeNoGross as number) : 0;
          bestEdge = Math.max(bestEdge, eY, eN);
          if (Number.isFinite(fv.confidenceScore as number)) { confSum += fv.confidenceScore as number; confN += 1; }
        }
        const bps = d.basis?.basisBps;
        if (Number.isFinite(bps as number)) { basisSum += bps as number; basisN += 1; }
      }
      const ts = new Date().toISOString();
      console.log(
        `  ${paint(ts, C.gray)} cycle ${cycle} — markets ${paint(String(decisions.length), C.cyan)} | ` +
          `NO_TRADE ${nt} | PAPER ${paint(String(pt), pt > 0 ? C.green : C.gray)}` +
          (lb > 0 ? ` | LIVE_BLOCKED ${paint(String(lb), C.yellow)}` : "") +
          paint(` | ${Date.now() - t0}ms`, C.dim),
      );
      // Research verdict line (proxy mode): priced count, best edge, conf, and the
      // multi-source consensus (USD median, measured USD dispersion, USDT basis).
      if (loaded.flags.allowProxyIndex) {
        const c = getLatestConsensus();
        const medVal = c ? `$${c.median.toFixed(0)}` : "—";
        const dispVal = c ? `${c.dispersionBps.toFixed(1)}bps/${c.nSources}src` : "—";
        const usdtVal = c && c.usdtBasisBps != null ? `${c.usdtBasisBps.toFixed(1)}bps` : "—";
        const avgConf = confN > 0 ? (confSum / confN).toFixed(2) : "—";
        console.log(
          paint(
            `      ↳ priced ${priced}/${decisions.length} | bestEdge ${(bestEdge * 100).toFixed(1)}¢ | ` +
              `avgConf ${avgConf} | USDmed ${medVal} disp ${dispVal} | USDTbasis ${usdtVal}`,
            C.dim,
          ),
        );
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  // ── ONE-SHOT MODE (default): full summary ───────────────────────────────
  const decisions = await runCycle();

  let noTrade = 0;
  let paperTrade = 0;
  let liveBlocked = 0;
  const blockedByCounts = new Map<string, number>();

  for (const d of decisions) {
    if (d.action === "PAPER_TRADE") paperTrade += 1;
    else if (d.action === "LIVE_ORDER_BLOCKED") liveBlocked += 1;
    else noTrade += 1;

    const reasons = Array.isArray(d.risk?.blockedBy) ? d.risk.blockedBy : [];
    for (const r of reasons) {
      blockedByCounts.set(r, (blockedByCounts.get(r) ?? 0) + 1);
    }
  }

  console.log(paint("  Summary", C.bold));
  console.log(paint("  " + "─".repeat(48), C.gray));
  console.log(`  Markets seen ............. ${paint(String(decisions.length), C.cyan, C.bold)}`);
  console.log(`  NO_TRADE ................. ${noTrade}`);
  console.log(`  PAPER_TRADE .............. ${paperTrade}`);
  if (liveBlocked > 0) {
    console.log(`  LIVE_ORDER_BLOCKED ....... ${paint(String(liveBlocked), C.yellow)} (no order sent)`);
  }
  console.log("");

  // Per-signal breakdown (colored).
  if (decisions.length > 0) {
    const sigCounts = new Map<string, number>();
    for (const d of decisions) {
      sigCounts.set(d.signal, (sigCounts.get(d.signal) ?? 0) + 1);
    }
    console.log(paint("  Signals", C.bold));
    console.log(paint("  " + "─".repeat(48), C.gray));
    for (const [sig, n] of [...sigCounts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${paint(pad(sig, 22), signalColor(sig))} ${n}`);
    }
    console.log("");
  }

  // Top blockedBy reasons.
  if (blockedByCounts.size > 0) {
    const top = [...blockedByCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    console.log(paint("  Top blockedBy reasons", C.bold));
    console.log(paint("  " + "─".repeat(48), C.gray));
    for (const [reason, n] of top) {
      console.log(`  ${paint(pad(reason, 30), C.yellow)} ${n}`);
    }
    console.log("");
  } else if (decisions.length > 0) {
    console.log(paint("  No block reasons recorded.", C.dim));
    console.log("");
  }

  console.log(
    paint(
      "  Decisions logged → data/jupiter_decisions (+ snapshots → data/jupiter_snapshots).",
      C.dim,
    ),
  );
  console.log(
    paint(
      "  READ-ONLY run complete. No orders were placed; this is not a profitability claim.",
      C.green,
    ),
  );
}

main().catch((err) => {
  // Final safety net — should never trigger.
  console.error("Unexpected fatal error:", err);
  process.exitCode = 1;
});
