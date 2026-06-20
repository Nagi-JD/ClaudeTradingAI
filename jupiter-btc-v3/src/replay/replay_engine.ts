// Replay engine: reads saved StrategyDecision JSONL snapshots from a directory,
// re-simulates fills PESSIMISTICALLY (via fill_simulator), reconstructs paper
// trades, and aggregates PnL metrics. Every layer is defensive: a missing dir,
// an empty dir, or malformed JSONL lines never throw — they degrade to a safe,
// note-annotated empty/partial result.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { Config } from "../config/load_config";
import type {
  AblationVariant,
  PaperTrade,
  StrategyDecision,
} from "../jupiter_prediction/models";
import { simulateFill } from "./fill_simulator";
import { computePnlMetrics, type PnlMetrics } from "./pnl_metrics";

export interface ReplayInput {
  dir: string;
  config: Config;
}

export interface ReplayResult {
  decisions: StrategyDecision[];
  trades: PaperTrade[];
  pnl: PnlMetrics;
  notes: string[];
}

function isFiniteNum(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function emptyResult(notes: string[]): ReplayResult {
  return {
    decisions: [],
    trades: [],
    pnl: computePnlMetrics([]),
    notes,
  };
}

/** Defensive parse of a single JSONL line into a StrategyDecision-ish object.
 *  Returns null on any failure or on an object missing the core shape. */
function parseDecisionLine(line: string): StrategyDecision | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const d = obj as Partial<StrategyDecision>;
  // Minimum viable shape: must have a market and a risk decision to replay.
  if (!d.market || typeof d.market !== "object") return null;
  if (!d.risk || typeof d.risk !== "object") return null;
  return d as StrategyDecision;
}

/** List candidate JSONL files in dir. Returns [] (with a note) if dir is
 *  missing or not a directory. */
function listJsonlFiles(
  dir: string,
  notes: string[],
): string[] {
  if (typeof dir !== "string" || dir.length === 0) {
    notes.push("Replay dir not provided; returning empty result.");
    return [];
  }
  let st;
  try {
    st = statSync(dir);
  } catch {
    notes.push(`Replay dir "${dir}" does not exist; returning empty result.`);
    return [];
  }
  if (!st.isDirectory()) {
    notes.push(`Replay path "${dir}" is not a directory; returning empty result.`);
    return [];
  }
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    notes.push(`Replay dir "${dir}" could not be read; returning empty result.`);
    return [];
  }
  const files = entries
    .filter((f) => f.toLowerCase().endsWith(".jsonl"))
    .map((f) => join(dir, f));
  if (files.length === 0) {
    notes.push(`No .jsonl files found in "${dir}".`);
  }
  return files;
}

/** Re-derive a side for replay from the recorded risk decision / fair value. */
function chooseSide(d: StrategyDecision): "YES" | "NO" | null {
  const riskSide = d.risk?.side;
  if (riskSide === "YES" || riskSide === "NO") return riskSide;
  return null;
}

/** Build a pessimistically re-simulated PaperTrade from a decision, or null if
 *  the decision did not represent an allowed, fillable position. */
function replayDecisionToTrade(
  d: StrategyDecision,
  config: Config,
): PaperTrade | null {
  if (!d.risk?.allowed) return null;
  const side = chooseSide(d);
  if (!side) return null;

  const sizeUsd = isFiniteNum(d.risk.sizeUsd) ? d.risk.sizeUsd : 0;
  if (sizeUsd <= 0) return null;

  const walk = side === "YES" ? d.orderbookYes : d.orderbookNo;
  if (!walk) return null;

  const volRegime = d.vol?.regime ?? "DATA_STALE";

  const fill = simulateFill({
    walk,
    side,
    sizeUsd,
    volRegime,
    config,
  });

  if (!fill.filled || fill.fillPrice === null) return null;

  const fairPriceAtDecision =
    side === "YES"
      ? d.fairValue?.fairYesTilted ?? d.fairValue?.fairYesBase
      : d.fairValue?.fairNoTilted ?? d.fairValue?.fairNoBase;

  const fairPx = isFiniteNum(fairPriceAtDecision) ? fairPriceAtDecision : 0;
  // Net edge under the pessimistic fill: fair minus the actual (worst) fill.
  const edgeNet = fairPx - fill.fillPrice;

  const variant: AblationVariant = "base_only";

  const reasonCodes = [...fill.reasonCodes];
  if (fill.adverse) reasonCodes.push("ADVERSE_SELECTION");

  const trade: PaperTrade = {
    timestamp: typeof d.timestamp === "string" ? d.timestamp : new Date().toISOString(),
    marketId: d.market?.marketId ?? "",
    provider: d.market?.provider ?? "unknown",
    side,
    sizeUsd: fill.filledSizeUsd,
    effectiveFillPrice: fill.fillPrice,
    fairPriceAtDecision: fairPx,
    edgeNet,
    timeLeftSeconds: isFiniteNum(d.market?.timeLeftSeconds)
      ? (d.market.timeLeftSeconds as number)
      : null,
    settlementIndexPrice: isFiniteNum(d.settlementIndex?.indexPrice)
      ? (d.settlementIndex.indexPrice as number)
      : null,
    targetPrice: isFiniteNum(d.settlement?.targetPrice)
      ? (d.settlement.targetPrice as number)
      : null,
    volRegime,
    basisBps: isFiniteNum(d.basis?.basisBps) ? (d.basis.basisBps as number) : null,
    latencyP95: isFiniteNum(d.latency?.p95) ? (d.latency.p95 as number) : 0,
    variant,
    reasonCodes,
    outcome: null,
    realizedPnlUsd: null,
  };

  return trade;
}

/**
 * Replay all StrategyDecision JSONL snapshots in `dir`. Returns decisions,
 * re-simulated trades, and aggregate pnl. Never throws; missing/empty dir →
 * empty result with an explanatory note.
 */
export async function replaySnapshots(input: ReplayInput): Promise<ReplayResult> {
  const notes: string[] = [];

  if (!input || typeof input !== "object") {
    return emptyResult(["Invalid replay input; returning empty result."]);
  }

  const { dir, config } = input;
  const files = listJsonlFiles(dir, notes);
  if (files.length === 0) {
    return emptyResult(notes);
  }

  const decisions: StrategyDecision[] = [];
  const trades: PaperTrade[] = [];
  let badLines = 0;

  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      notes.push(`Could not read "${file}"; skipped.`);
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      const decision = parseDecisionLine(line);
      if (!decision) {
        badLines += 1;
        continue;
      }
      decisions.push(decision);
      const trade = replayDecisionToTrade(decision, config);
      if (trade) trades.push(trade);
    }
  }

  if (badLines > 0) {
    notes.push(`Skipped ${badLines} malformed/incomplete JSONL line(s).`);
  }
  notes.push(
    `Replayed ${decisions.length} decision(s) → ${trades.length} re-simulated trade(s) from ${files.length} file(s).`,
  );
  notes.push(
    "Fills were re-simulated pessimistically (worst price, partial fills, adverse selection); PnL is biased conservative and is not a profit claim.",
  );

  const pnl = computePnlMetrics(trades);

  return { decisions, trades, pnl, notes };
}
