// scripts/jupiter_btc_dashboard.ts
//
// One-shot terminal dashboard. Reuses JupiterBtcStrategy.runOnce() for live
// state and renders the §23 panels as pragmatic ANSI tables (no heavy TUI dep).
// Panels: Market Discovery, Settlement Index, Basis, Vol Forecast, Binary
// Pricing, Orderbook Walk, Latency, Cost/Fills, Risk/Action, Calibration
// Scorecard. Signals are colored (green YES/NO_EDGE, yellow blocks, gray
// NO_TRADE). The calibration panel reads recent resolved paper trades if any
// exist, else prints "n/a (no resolved trades yet)".
//
// Run:  npx tsx scripts/jupiter_btc_dashboard.ts
//       (or)  npm run jupiter:dashboard

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "../src/config/load_config";
import { JupiterPredictionClient } from "../src/jupiter_prediction/client";
import { JupiterBtcStrategy } from "../src/strategy/jupiter_btc_strategy";
import { buildCalibrationReport } from "../src/research/calibration_engine";
import type {
  PaperTrade,
  StrategyDecision,
  StrategySignal,
} from "../src/jupiter_prediction/models";

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

function printBanner(title: string, flags: {
  readOnly: boolean;
  dryRun: boolean;
  enableLiveTrading: boolean;
  liveTradingPermitted: boolean;
}): void {
  const line = "═".repeat(78);
  console.log(paint(line, C.gray));
  console.log(paint(`  ${title}`, C.bold, C.cyan));
  console.log(
    `  READ_ONLY=${flags.readOnly}  DRY_RUN=${flags.dryRun}  ENABLE_LIVE_TRADING=${flags.enableLiveTrading}`,
  );
  console.log(
    flags.liveTradingPermitted
      ? paint("  LIVE TRADING: PERMITTED BY FLAGS — but orders are NEVER sent by this build.", C.red, C.bold)
      : paint("  LIVE TRADING: DISABLED", C.green, C.bold),
  );
  console.log(paint(line, C.gray));
}

// ──────────────────────────────────────────────────────── table rendering ──
type Col = { header: string; width: number };

function fit(s: unknown, w: number): string {
  let str = s === null || s === undefined ? "" : String(s);
  if (str.length > w) str = str.slice(0, Math.max(0, w - 1)) + "…";
  return str + " ".repeat(Math.max(0, w - str.length));
}

function panel(title: string, cols: Col[], rows: string[][]): void {
  console.log("");
  console.log(paint(`▌ ${title}`, C.bold, C.cyan));
  const header = cols.map((c) => fit(c.header, c.width)).join("  ");
  console.log(paint("  " + header, C.bold));
  console.log(paint("  " + cols.map((c) => "─".repeat(c.width)).join("  "), C.gray));
  if (rows.length === 0) {
    console.log(paint("  (no rows)", C.dim));
    return;
  }
  for (const r of rows) {
    const cells = cols.map((c, i) => fit(r[i] ?? "", c.width));
    console.log("  " + cells.join("  "));
  }
}

function kv(title: string, pairs: [string, string][]): void {
  console.log("");
  console.log(paint(`▌ ${title}`, C.bold, C.cyan));
  for (const [k, v] of pairs) {
    console.log(`  ${paint(fit(k, 26), C.gray)} ${v}`);
  }
}

// ─────────────────────────────────────────────────────────────── helpers ──
function num(x: unknown, digits = 4): string {
  return typeof x === "number" && Number.isFinite(x) ? x.toFixed(digits) : "—";
}
function usd(x: unknown): string {
  return typeof x === "number" && Number.isFinite(x) ? `$${x.toFixed(2)}` : "—";
}
function ms(x: unknown): string {
  return typeof x === "number" && Number.isFinite(x) ? `${Math.round(x)}ms` : "—";
}
function bool(x: unknown): string {
  return x === true ? paint("yes", C.green) : x === false ? paint("no", C.red) : "—";
}
function reasonsOf(arr: unknown): string {
  return Array.isArray(arr) && arr.length > 0 ? arr.slice(0, 3).join(",") : "—";
}

function signalColor(signal: StrategySignal | string): string {
  if (signal === "YES_EDGE" || signal === "NO_EDGE") return C.green;
  if (signal === "NO_TRADE" || signal === "BASELINE_ONLY") return C.gray;
  return C.yellow;
}
function coloredSignal(signal: StrategySignal | string): string {
  return paint(String(signal), signalColor(signal));
}

function shortId(d: StrategyDecision): string {
  return d.market?.marketTitle || d.market?.eventTitle || d.market?.marketId || "?";
}

// ──────────────────────────── recent paper trades for calibration panel ──
function loadRecentPaperTrades(dir: string, maxLines = 5000): PaperTrade[] {
  const trades: PaperTrade[] = [];
  let st;
  try {
    st = statSync(dir);
  } catch {
    return trades;
  }
  if (!st.isDirectory()) return trades;
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".jsonl"))
      .map((f) => join(dir, f));
  } catch {
    return trades;
  }
  for (const f of files) {
    let content: string;
    try {
      content = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const line of content.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try {
        const obj = JSON.parse(t);
        if (obj && typeof obj === "object" && typeof obj.marketId === "string") {
          trades.push(obj as PaperTrade);
        }
      } catch {
        // skip malformed line
      }
      if (trades.length >= maxLines) return trades;
    }
  }
  return trades;
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

  printBanner("Jupiter BTC V3 — Dashboard (one-shot)", loaded.flags);
  console.log(paint(`  config: ${loaded.configPath}`, C.dim));
  if (!loaded.env.jupiterApiKey) {
    console.log(
      paint(
        "  WARNING: JUPITER_API_KEY missing — live data unavailable; panels render the\n" +
          "  defensive/blocked state to demonstrate wiring offline.",
        C.yellow,
      ),
    );
  }

  const client = new JupiterPredictionClient({
    baseUrl: loaded.config.jupiter.baseUrl,
    apiKey: loaded.env.jupiterApiKey,
    timeoutMs: loaded.config.jupiter.requestTimeoutMs,
    maxRetries: loaded.config.jupiter.maxRetries,
    liveTradingPermitted: loaded.flags.liveTradingPermitted,
  });

  const strategy = new JupiterBtcStrategy({ loaded, client });

  let decisions: StrategyDecision[] = [];
  try {
    decisions = await strategy.runOnce();
  } catch (err) {
    console.error(paint("  runOnce() threw (unexpected); rendering empty state.", C.red), err);
  }

  // ── Panel 1: Market Discovery ──────────────────────────────────────────
  panel(
    "Market Discovery",
    [
      { header: "Market", width: 30 },
      { header: "Provider", width: 10 },
      { header: "Active", width: 6 },
      { header: "Live", width: 5 },
      { header: "TimeLeft(s)", width: 11 },
      { header: "BuyYES", width: 7 },
      { header: "BuyNO", width: 7 },
    ],
    decisions.map((d) => [
      shortId(d),
      d.market?.provider ?? "—",
      bool(d.market?.isActive),
      bool(d.market?.isLive),
      num(d.market?.timeLeftSeconds, 0),
      num(d.market?.buyYesPriceUsd, 3),
      num(d.market?.buyNoPriceUsd, 3),
    ]),
  );

  // ── Panel 2: Settlement Index ──────────────────────────────────────────
  panel(
    "Settlement Index",
    [
      { header: "Market", width: 24 },
      { header: "IndexName", width: 16 },
      { header: "IndexPx", width: 12 },
      { header: "Age", width: 8 },
      { header: "Conf", width: 6 },
      { header: "Mechanic", width: 14 },
    ],
    decisions.map((d) => [
      shortId(d),
      d.settlementIndex?.indexName ?? "—",
      usd(d.settlementIndex?.indexPrice),
      ms(d.settlementIndex?.dataAgeMs),
      num(d.settlementIndex?.confidence, 2),
      d.settlement?.settlementMechanic ?? "UNKNOWN",
    ]),
  );

  // ── Panel 3: Basis ─────────────────────────────────────────────────────
  panel(
    "Basis",
    [
      { header: "Market", width: 24 },
      { header: "IndexPx", width: 12 },
      { header: "CexRefPx", width: 12 },
      { header: "BasisBps", width: 9 },
      { header: "Stable", width: 6 },
      { header: "Reasons", width: 22 },
    ],
    decisions.map((d) => [
      shortId(d),
      usd(d.basis?.settlementIndexPrice),
      usd(d.basis?.cexReferencePrice),
      num(d.basis?.basisBps, 1),
      bool(d.basis?.isStable),
      reasonsOf(d.basis?.reasonCodes),
    ]),
  );

  // ── Panel 4: Vol Forecast ──────────────────────────────────────────────
  panel(
    "Vol Forecast",
    [
      { header: "Market", width: 24 },
      { header: "Regime", width: 12 },
      { header: "EWMAVol", width: 9 },
      { header: "ExpMove$", width: 10 },
      { header: "VolConf", width: 8 },
      { header: "Reasons", width: 20 },
    ],
    decisions.map((d) => [
      shortId(d),
      d.vol?.regime ?? "—",
      num(d.vol?.ewmaVol, 5),
      usd(d.vol?.expectedMoveUsd),
      num(d.vol?.volConfidence, 2),
      reasonsOf(d.vol?.reasonCodes),
    ]),
  );

  // ── Panel 5: Binary Pricing ────────────────────────────────────────────
  panel(
    "Binary Pricing",
    [
      { header: "Market", width: 24 },
      { header: "FairYES", width: 8 },
      { header: "FairNO", width: 8 },
      { header: "zScore", width: 8 },
      { header: "Dist2Tgt", width: 10 },
      { header: "Conf", width: 6 },
    ],
    decisions.map((d) => [
      shortId(d),
      num(d.fairValue?.fairYesTilted ?? d.fairValue?.fairYesBase, 3),
      num(d.fairValue?.fairNoTilted ?? d.fairValue?.fairNoBase, 3),
      num(d.fairValue?.zScore, 3),
      usd(d.fairValue?.distanceToTarget),
      num(d.fairValue?.confidenceScore, 2),
    ]),
  );

  // ── Panel 6: Orderbook Walk ────────────────────────────────────────────
  const obRows: string[][] = [];
  for (const d of decisions) {
    for (const side of ["YES", "NO"] as const) {
      const w = side === "YES" ? d.orderbookYes : d.orderbookNo;
      if (!w) continue;
      obRows.push([
        shortId(d),
        side,
        num(w.avgFillPrice, 3),
        num(w.worstFillPrice, 3),
        usd(w.availableSizeUsd),
        num(w.fillRatio, 2),
        w.filledAtMid === false ? paint("never", C.green) : paint("MID!", C.red),
        reasonsOf(w.reasonCodes),
      ]);
    }
  }
  panel(
    "Orderbook Walk",
    [
      { header: "Market", width: 20 },
      { header: "Side", width: 4 },
      { header: "AvgFill", width: 8 },
      { header: "WorstFill", width: 9 },
      { header: "Avail$", width: 9 },
      { header: "FillRatio", width: 9 },
      { header: "AtMid", width: 6 },
      { header: "Reasons", width: 18 },
    ],
    obRows,
  );

  // ── Panel 7: Latency ───────────────────────────────────────────────────
  panel(
    "Latency",
    [
      { header: "Market", width: 24 },
      { header: "p50", width: 8 },
      { header: "p95", width: 8 },
      { header: "p99", width: 8 },
      { header: "Budget", width: 7 },
      { header: "Reasons", width: 22 },
    ],
    decisions.map((d) => [
      shortId(d),
      ms(d.latency?.p50),
      ms(d.latency?.p95),
      ms(d.latency?.p99),
      bool(d.latency?.withinBudget),
      reasonsOf(d.latency?.reasonCodes),
    ]),
  );

  // ── Panel 8: Cost / Fills ──────────────────────────────────────────────
  panel(
    "Cost / Fills",
    [
      { header: "Market", width: 22 },
      { header: "EffBuyYES", width: 9 },
      { header: "EffBuyNO", width: 9 },
      { header: "Slip", width: 7 },
      { header: "LatPen", width: 7 },
      { header: "Fee", width: 7 },
      { header: "NetEdgeYES", width: 10 },
      { header: "NetEdgeNO", width: 10 },
    ],
    decisions.map((d) => [
      shortId(d),
      num(d.cost?.effectiveBuyYesPrice, 3),
      num(d.cost?.effectiveBuyNoPrice, 3),
      num(d.cost?.expectedSlippage, 4),
      num(d.cost?.latencyPenalty, 4),
      num(d.cost?.feeEstimate, 4),
      num(d.cost?.netEdgeYes, 4),
      num(d.cost?.netEdgeNo, 4),
    ]),
  );

  // ── Panel 9: Risk / Action ─────────────────────────────────────────────
  panel(
    "Risk / Action",
    [
      { header: "Market", width: 22 },
      { header: "Signal", width: 18 },
      { header: "Action", width: 18 },
      { header: "Side", width: 5 },
      { header: "Size$", width: 8 },
      { header: "BlockedBy", width: 24 },
    ],
    decisions.map((d) => [
      shortId(d),
      coloredSignal(d.signal),
      d.action === "PAPER_TRADE"
        ? paint(d.action, C.green)
        : d.action === "LIVE_ORDER_BLOCKED"
          ? paint(d.action, C.yellow)
          : paint(d.action, C.gray),
      d.risk?.side ?? "—",
      usd(d.risk?.sizeUsd),
      reasonsOf(d.risk?.blockedBy),
    ]),
  );

  // ── Panel 10: Calibration Scorecard ────────────────────────────────────
  const recentTrades = loadRecentPaperTrades("data/jupiter_paper_trades");
  const resolved = recentTrades.filter(
    (t) => t && (t.outcome === "YES" || t.outcome === "NO" || t.outcome === "VOID"),
  );
  console.log("");
  console.log(paint("▌ Calibration Scorecard", C.bold, C.cyan));
  if (resolved.length === 0) {
    console.log(paint("  n/a (no resolved trades yet)", C.dim));
  } else {
    const report = buildCalibrationReport(recentTrades, loaded.config);
    kv("", [
      ["Resolved samples", String(report.nResolved)],
      ["Brier (lower better)", num(report.brier, 4)],
      ["Log loss (lower better)", num(report.logLoss, 4)],
      ["σ forecast error", num(report.sigmaForecastError, 4)],
    ]);
    // Tiny reliability sparkline (predicted vs observed per bucket with data).
    const withData = report.reliability.filter((b) => b.n > 0);
    if (withData.length > 0) {
      console.log(paint("  Reliability (bucket: pred→obs, n)", C.gray));
      for (const b of withData) {
        console.log(
          `    ${fit(`b${b.bucket}`, 4)} ${num(b.predicted, 2)} → ${num(b.observed, 2)}  (n=${b.n})`,
        );
      }
    }
    for (const note of report.notes) {
      console.log(paint(`  • ${note}`, C.dim));
    }
  }

  console.log("");
  console.log(
    paint(
      "  One-shot snapshot complete. NO orders were placed. Not a profitability claim.",
      C.green,
    ),
  );
}

main().catch((err) => {
  console.error("Unexpected fatal error:", err);
  process.exitCode = 1;
});
