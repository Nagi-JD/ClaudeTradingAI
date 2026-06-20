// scripts/calibration_report.ts
//
// Loads resolved paper trades (JSONL) from data/jupiter_paper_trades, builds the
// calibration report, and prints Brier / log loss / reliability curve / CLV /
// ablation. It is deliberately conservative: small samples are flagged and it
// NEVER claims profitability. Empty input → a clear "no data" note.
//
// Run:  npx tsx scripts/calibration_report.ts
//       (or)  npm run jupiter:calibration

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "../src/config/load_config";
import { buildCalibrationReport } from "../src/research/calibration_engine";
import {
  aggregateClvByVariant,
  type ClvByVariant,
} from "../src/research/clv_engine";
import { shouldDisableTilt } from "../src/research/ablation_engine";
import type { AblationVariant, PaperTrade } from "../src/jupiter_prediction/models";

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
  const line = "─".repeat(72);
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

function fit(s: unknown, w: number): string {
  const str = s === null || s === undefined ? "" : String(s);
  return str.length >= w ? str : str + " ".repeat(w - str.length);
}
function num(x: unknown, digits = 4): string {
  return typeof x === "number" && Number.isFinite(x) ? x.toFixed(digits) : "—";
}
function usd(x: unknown): string {
  return typeof x === "number" && Number.isFinite(x) ? `$${x.toFixed(2)}` : "—";
}

const ABLATION_VARIANTS: AblationVariant[] = [
  "base_only",
  "base_plus_cvd",
  "base_plus_liquidations",
  "base_plus_momentum",
  "base_plus_all",
];

// ───────────────────────────────────────────── defensive paper-trade load ──
function loadPaperTrades(dir: string): { trades: PaperTrade[]; notes: string[] } {
  const trades: PaperTrade[] = [];
  const notes: string[] = [];

  let st;
  try {
    st = statSync(dir);
  } catch {
    notes.push(`Paper-trade dir "${dir}" does not exist.`);
    return { trades, notes };
  }
  if (!st.isDirectory()) {
    notes.push(`Paper-trade path "${dir}" is not a directory.`);
    return { trades, notes };
  }

  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".jsonl"))
      .map((f) => join(dir, f));
  } catch {
    notes.push(`Could not read paper-trade dir "${dir}".`);
    return { trades, notes };
  }
  if (files.length === 0) {
    notes.push(`No .jsonl paper-trade files found in "${dir}".`);
    return { trades, notes };
  }

  let bad = 0;
  for (const f of files) {
    let content: string;
    try {
      content = readFileSync(f, "utf8");
    } catch {
      notes.push(`Could not read "${f}"; skipped.`);
      continue;
    }
    for (const line of content.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try {
        const obj = JSON.parse(t);
        if (obj && typeof obj === "object" && typeof obj.marketId === "string") {
          trades.push(obj as PaperTrade);
        } else {
          bad += 1;
        }
      } catch {
        bad += 1;
      }
    }
  }
  if (bad > 0) notes.push(`Skipped ${bad} malformed/incomplete paper-trade line(s).`);
  notes.push(`Loaded ${trades.length} paper trade(s) from ${files.length} file(s).`);
  return { trades, notes };
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

  printBanner("Jupiter BTC V3 — Calibration Report", loaded.flags);

  const dir = "data/jupiter_paper_trades";
  console.log(paint(`  Reading paper trades from: ${dir}`, C.dim));

  const { trades, notes: loadNotes } = loadPaperTrades(dir);
  for (const n of loadNotes) console.log(paint(`  • ${n}`, C.dim));

  if (trades.length === 0) {
    console.log("");
    console.log(
      paint(
        "  No paper trades found. Nothing to calibrate yet.\n" +
          "  Run the collector (npm run jupiter:collect) in dry-run to generate paper\n" +
          "  trades, then resolve them before calibration can be measured.",
        C.yellow,
      ),
    );
    return;
  }

  const report = buildCalibrationReport(trades, loaded.config);

  // ── Core calibration metrics ───────────────────────────────────────────
  console.log("");
  console.log(paint("  Calibration Metrics", C.bold, C.cyan));
  console.log(paint("  " + "─".repeat(56), C.gray));
  const core: [string, string][] = [
    ["Resolved samples", String(report.nResolved)],
    ["Brier score (lower better)", num(report.brier, 4)],
    ["Log loss (lower better)", num(report.logLoss, 4)],
    ["σ forecast error", num(report.sigmaForecastError, 4)],
  ];
  for (const [k, v] of core) console.log(`  ${paint(fit(k, 28), C.gray)} ${v}`);

  // ── Reliability curve ──────────────────────────────────────────────────
  console.log("");
  console.log(paint("  Reliability Curve", C.bold, C.cyan));
  console.log(paint("  " + fit("Bucket", 8) + fit("Predicted", 12) + fit("Observed", 12) + "n", C.bold));
  console.log(paint("  " + "─".repeat(40), C.gray));
  const withData = report.reliability.filter((b) => b.n > 0);
  if (withData.length === 0) {
    console.log(paint("  (no populated buckets — no resolved samples)", C.dim));
  } else {
    for (const b of report.reliability) {
      const row =
        "  " +
        fit(`b${b.bucket}`, 8) +
        fit(num(b.predicted, 3), 12) +
        fit(num(b.observed, 3), 12) +
        String(b.n);
      console.log(b.n > 0 ? row : paint(row, C.dim));
    }
  }

  // ── Ablation (per-variant) ─────────────────────────────────────────────
  console.log("");
  console.log(paint("  Ablation by Variant", C.bold, C.cyan));
  console.log(
    paint(
      "  " +
        fit("Variant", 26) +
        fit("n", 5) +
        fit("Brier", 9) +
        fit("AvgEdgeNet", 12) +
        "NetPnL",
      C.bold,
    ),
  );
  console.log(paint("  " + "─".repeat(64), C.gray));
  for (const v of ABLATION_VARIANTS) {
    const s = report.byVariant[v];
    console.log(
      "  " +
        fit(v, 26) +
        fit(String(s.n), 5) +
        fit(num(s.brier, 4), 9) +
        fit(num(s.avgEdgeNet, 4), 12) +
        usd(s.netPnl),
    );
  }

  // Tilt honesty gate.
  const tiltDecision = shouldDisableTilt(report.byVariant);
  console.log("");
  console.log(
    `  Tilt recommendation: ${
      tiltDecision.disable
        ? paint("DISABLE", C.yellow, C.bold)
        : paint("KEEP", C.green, C.bold)
    }`,
  );
  console.log(paint(`    ${tiltDecision.reason}`, C.dim));

  // ── CLV by variant ─────────────────────────────────────────────────────
  const clv: ClvByVariant = aggregateClvByVariant(
    trades as (PaperTrade & { closingYesPrice?: number; closingNoPrice?: number })[],
  );
  console.log("");
  console.log(paint("  Closing Line Value (CLV) by Variant", C.bold, C.cyan));
  console.log(
    paint("  " + fit("Variant", 26) + fit("n", 5) + fit("AvgCLV", 12) + "AvgCLVNet", C.bold),
  );
  console.log(paint("  " + "─".repeat(56), C.gray));
  const anyClv = ABLATION_VARIANTS.some((v) => clv[v].n > 0);
  for (const v of ABLATION_VARIANTS) {
    const s = clv[v];
    console.log(
      "  " + fit(v, 26) + fit(String(s.n), 5) + fit(num(s.avgClv, 4), 12) + num(s.avgClvNet, 4),
    );
  }
  if (!anyClv) {
    console.log(
      paint(
        "  (no measurable CLV — trades lack closingYesPrice/closingNoPrice fields)",
        C.dim,
      ),
    );
  }

  // ── Honesty notes ──────────────────────────────────────────────────────
  console.log("");
  console.log(paint("  Notes", C.bold));
  console.log(paint("  " + "─".repeat(56), C.gray));
  for (const note of report.notes) {
    console.log(paint(`  • ${note}`, C.dim));
  }
  console.log(
    paint(
      "  • Small-sample caveat: with few resolved trades these metrics are\n" +
        "    statistically unreliable. This is calibration measurement, NOT a\n" +
        "    profitability claim.",
      C.yellow,
    ),
  );
}

main().catch((err) => {
  console.error("Unexpected fatal error:", err);
  process.exitCode = 1;
});
