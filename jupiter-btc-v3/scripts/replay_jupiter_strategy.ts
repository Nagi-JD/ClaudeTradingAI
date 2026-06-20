// scripts/replay_jupiter_strategy.ts
//
// Replays saved StrategyDecision JSONL snapshots from data/jupiter_decisions,
// re-simulating fills PESSIMISTICALLY (worst price, partial fills, adverse
// selection), and prints the aggregate PnL metrics. This is an execution-quality
// diagnostic, NOT a profitability claim — fills are deliberately conservative.
//
// Run:  npx tsx scripts/replay_jupiter_strategy.ts
//       (or)  npm run jupiter:replay

import { loadConfig } from "../src/config/load_config";
import { replaySnapshots } from "../src/replay/replay_engine";

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

async function main(): Promise<void> {
  let loaded;
  try {
    loaded = loadConfig();
  } catch (err) {
    console.error(paint("FATAL: failed to load config.", C.red, C.bold), err);
    process.exitCode = 1;
    return;
  }

  printBanner("Jupiter BTC V3 — Strategy Replay (pessimistic fills)", loaded.flags);

  const dir = "data/jupiter_decisions";
  console.log(paint(`  Replaying decisions from: ${dir}`, C.dim));

  let result;
  try {
    result = await replaySnapshots({ dir, config: loaded.config });
  } catch (err) {
    // replaySnapshots is defensive and should never throw.
    console.error(paint("  replaySnapshots threw (unexpected); nothing to report.", C.red), err);
    process.exitCode = 1;
    return;
  }

  const p = result.pnl;

  console.log("");
  console.log(paint("  PnL / Execution-Quality Metrics", C.bold, C.cyan));
  console.log(paint("  " + "─".repeat(56), C.gray));
  const lines: [string, string][] = [
    ["Total decisions replayed", String(p.totalDecisions)],
    ["Allowed (sized) trades", String(p.allowed)],
    ["Rejected (no size)", String(p.rejected)],
    ["Gross PnL", usd(p.grossPnl)],
    ["Net PnL (after drags)", usd(p.netPnl)],
    ["Max drawdown", usd(p.maxDrawdown)],
    ["Avg edge (gross)", num(p.avgEdgeGross, 4)],
    ["Avg edge (net)", num(p.avgEdgeNet, 4)],
    ["Fill-quality drag", usd(p.fillQualityDrag)],
    ["Latency drag", usd(p.latencyDrag)],
  ];
  for (const [k, v] of lines) {
    console.log(`  ${paint(fit(k, 28), C.gray)} ${v}`);
  }

  // Replay-engine notes (dir status, malformed lines, conservative-fill caveat).
  if (Array.isArray(result.notes) && result.notes.length > 0) {
    console.log("");
    console.log(paint("  Notes", C.bold));
    console.log(paint("  " + "─".repeat(56), C.gray));
    for (const note of result.notes) {
      console.log(paint(`  • ${note}`, C.dim));
    }
  }

  console.log("");
  console.log(
    paint(
      "  Fills are simulated pessimistically (worst price, partial fills, adverse\n" +
        "  selection). These figures are an execution-quality diagnostic and are\n" +
        "  NOT a profitability claim.",
      C.yellow,
    ),
  );
}

main().catch((err) => {
  console.error("Unexpected fatal error:", err);
  process.exitCode = 1;
});
