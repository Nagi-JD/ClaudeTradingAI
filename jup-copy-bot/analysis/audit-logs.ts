// ─────────────────────────────────────────────────────────────────────────
// PHASE 0 — LOG INTEGRITY AUDIT  (read-only; instrumentation, not behavior)
//
// The cheapest, most potentially-fatal test in the validation protocol: if the
// logged data is not internally consistent, EVERY downstream number (edge,
// win-rate, clean PnL) is built on sand and the project should stop until the
// logging is fixed — NOT continue analysing corrupt data.
//
// PRE-REGISTERED DECISION RULE (committed BEFORE seeing results):
//   The dataset is TRUSTWORTHY (analysis may proceed) iff ALL of:
//     (A) 0 PnL-accounting violations           (realizedPnl out of binary bounds)
//     (B) 0 exact-recompute mismatches > $0.01  (held-to-resolution positions)
//     (C) 0 phantom fills                        (fill price <= $0.005 — the
//         "$0.001 on a closed market" bug class)
//     (D) duplicate rate          <= 0.0%        (any dup = double-counting risk)
//     (E) orphan-closed rate       < 5.0%        (closed positions with no
//         traceable copy-fill entry = a logging gap that biases the sample)
//   If any fails -> VERDICT: NOT TRUSTWORTHY, exit code 1, downstream blocked.
//
// Run:  npx tsx analysis/audit-logs.ts
// ─────────────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── pre-registered thresholds ──────────────────────────────────────────────
const TH = {
  recomputeTolUsd: 0.01,      // exact PnL recompute tolerance
  phantomPriceUsd: 0.005,     // fill price at/below this on a real fill = phantom
  costRelTol: 0.02,           // 2% relative tolerance on cost identities
  lagTolUsd: 0.005,           // lagDelta vs (our-leader) tolerance
  maxDupRate: 0.0,            // any duplicate fails
  maxOrphanRate: 0.05,        // <5% orphan closed positions tolerated
};

const ROOT = process.env.BOT_ROOT ?? ".";
const P = {
  copyFills: resolve(ROOT, "data/copy-fills.jsonl"),
  blockedFills: resolve(ROOT, "data/blocked-fills.jsonl"),
  closed: resolve(ROOT, "state/closed-positions.json"),
  // Canonical exclusion ledger for known-bad rows (e.g. the $0.001 phantom-fill
  // glitch). Quarantining here is NON-DESTRUCTIVE: the live append-only
  // copy-fills.jsonl is never mutated; analysis simply excludes these keys.
  quarantine: resolve(ROOT, "data/copy-fills.bad-pricing.jsonl"),
};
// Key a copy-fill for quarantine matching. ts is unique enough per wallet+market
// +action to distinguish a legit entry from a later phantom re-entry.
const cfKey = (f: { ts?: number; wallet?: string; marketId?: string; action?: string }) =>
  `${f.ts}|${f.wallet}|${f.marketId}|${f.action}`;

// ── real schemas (from live data 2026-06-20) ──────────────────────────────
interface CopyFill {
  ts: number; wallet: string; action: "entry" | "increase" | "exit";
  marketId: string; marketType?: string; side: "yes" | "no";
  leaderPriceUsd?: number; ourPriceUsd?: number; lagDeltaUsd?: number;
  contracts?: number; costUsd?: number; title?: string;
  leaderSellPriceUsd?: number; ourSellPriceUsd?: number; realizedPnlUsd?: number;
}
interface BlockedFill {
  ts: number; wallet: string; action: string; marketId: string;
  side: "yes" | "no"; leaderPriceUsd?: number; ourPriceUsd?: number;
  lagDeltaUsd?: number; contracts?: number; costUsd?: number;
  blockedBy?: string[]; title?: string;
}
interface ClosedPos {
  marketId: string; marketTitle?: string; side: "yes" | "no";
  filledContracts: number; requestedUsd?: number; avgFillPriceUsd: number;
  grossCostUsd?: number; feeUsd?: number; netCostUsd: number; partial?: boolean;
  openedFromWallet?: string; openedAt: number; markPriceUsd?: number;
  resolved: boolean; closedAt: number; realizedPnlUsd: number;
  outcome: "win" | "loss"; exitFeeUsd?: number; note?: string;
}

const KNOWN_BLOCK = new Set(["live", "tossup", "crypto", "qualif"]);
const NOW = Date.now();

// ── loaders (never throw; bad lines counted) ───────────────────────────────
function loadJsonl<T>(path: string): { rows: T[]; bad: number } {
  let raw = "";
  try { raw = readFileSync(path, "utf8"); } catch { return { rows: [], bad: 0 }; }
  const rows: T[] = []; let bad = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line) as T); } catch { bad++; }
  }
  return { rows, bad };
}
function loadJson<T>(path: string): T[] {
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(j) ? j : Object.values(j);
  } catch { return []; }
}

// ── check accumulator ──────────────────────────────────────────────────────
interface Check { name: string; total: number; bad: number; samples: string[]; gate?: boolean; }
const checks: Check[] = [];
function check(name: string, gate = false): Check {
  const c: Check = { name, total: 0, bad: 0, samples: [], gate };
  checks.push(c); return c;
}
function fail(c: Check, msg: string) { c.bad++; if (c.samples.length < 4) c.samples.push(msg); }

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const inUnit = (x?: number) => isNum(x) && x > 0 && x < 1;

// ════════════════════════════════════════════════════════════════════════════
function main() {
  const cfAll = loadJsonl<CopyFill>(P.copyFills);
  const bf = loadJsonl<BlockedFill>(P.blockedFills);
  const closed = loadJson<ClosedPos>(P.closed);

  // Apply the quarantine ledger: exclude known-bad copy-fill rows from analysis.
  const quar = loadJsonl<CopyFill>(P.quarantine);
  const quarKeys = new Set(quar.rows.map(cfKey));
  const cfRows = cfAll.rows.filter(r => !quarKeys.has(cfKey(r)));
  const excluded = cfAll.rows.length - cfRows.length;
  const cf = { rows: cfRows, bad: cfAll.bad };

  console.log("PHASE 0 — LOG INTEGRITY AUDIT");
  console.log("─".repeat(72));
  console.log(`copy-fills: ${cfAll.rows.length} rows (${cf.bad} unparseable, ${excluded} quarantined → ${cfRows.length} analysed) | ` +
    `blocked-fills: ${bf.rows.length} (${bf.bad} bad) | closed-positions: ${closed.length}`);
  console.log("");

  // ── parse integrity ──
  const cParse = check("parse: all lines valid JSON", true);
  cParse.total = cf.rows.length + bf.rows.length + closed.length;
  cParse.bad = cf.bad + bf.bad;
  if (cf.bad) fail(cParse, `${cf.bad} unparseable copy-fills lines`);
  if (bf.bad) fail(cParse, `${bf.bad} unparseable blocked-fills lines`);

  // ════════ CLOSED POSITIONS — the PnL ground truth ════════
  const cBounds = check("(A) PnL within binary bounds [-netCost, contracts-netCost]", true);
  const cRecompute = check("(B) exact PnL recompute (held-to-resolution)", true);
  const cCost = check("closed: cost identity (net=gross+fee, contracts=gross/price)");
  const cOutcome = check("closed: outcome/resolved/time validity");
  const cMark = check("closed: outcome <-> markPrice consistency");
  const cPhantomC = check("(C) closed: no phantom fill price (<=$0.005)", true);
  const cDupC = check("(D) closed: no duplicate positions", true);

  const seenClosed = new Set<string>();
  for (const p of closed) {
    const id = `${p.marketId}|${p.openedFromWallet}|${p.openedAt}`;
    cDupC.total++;
    if (seenClosed.has(id)) fail(cDupC, `dup ${id}`); else seenClosed.add(id);

    // bounds (always holds for a binary)
    cBounds.total++;
    if (isNum(p.realizedPnlUsd) && isNum(p.netCostUsd) && isNum(p.filledContracts)) {
      const lo = -p.netCostUsd - 0.01;
      const hi = p.filledContracts - p.netCostUsd + 0.01;
      if (p.realizedPnlUsd < lo || p.realizedPnlUsd > hi)
        fail(cBounds, `${p.marketId} pnl=${p.realizedPnlUsd.toFixed(2)} ∉ [${lo.toFixed(2)},${hi.toFixed(2)}] (${p.outcome})`);
    } else fail(cBounds, `${p.marketId} missing numeric pnl/cost/contracts`);

    // exact recompute ONLY for held-to-resolution (markPrice is 0 or 1, no early exit)
    const heldToResolution = !p.exitFeeUsd && (p.markPriceUsd === 0 || p.markPriceUsd === 1);
    cRecompute.total++;
    if (heldToResolution && isNum(p.realizedPnlUsd) && isNum(p.netCostUsd) && isNum(p.filledContracts)) {
      const terminal = p.outcome === "win" ? p.filledContracts : 0;
      const expected = terminal - p.netCostUsd;
      if (Math.abs(expected - p.realizedPnlUsd) > TH.recomputeTolUsd)
        fail(cRecompute, `${p.marketId} ${p.outcome}: expected ${expected.toFixed(2)} got ${p.realizedPnlUsd.toFixed(2)}`);
    }

    // cost identities
    cCost.total++;
    if (isNum(p.grossCostUsd) && isNum(p.feeUsd) && isNum(p.netCostUsd)) {
      if (Math.abs(p.netCostUsd - (p.grossCostUsd + p.feeUsd)) > 0.02)
        fail(cCost, `${p.marketId} net ${p.netCostUsd} != gross ${p.grossCostUsd}+fee ${p.feeUsd}`);
    }
    if (isNum(p.grossCostUsd) && isNum(p.avgFillPriceUsd) && p.avgFillPriceUsd > 0 && isNum(p.filledContracts)) {
      const impliedContracts = p.grossCostUsd / p.avgFillPriceUsd;
      if (Math.abs(impliedContracts - p.filledContracts) / Math.max(p.filledContracts, 1) > TH.costRelTol)
        fail(cCost, `${p.marketId} contracts ${p.filledContracts.toFixed(2)} != gross/price ${impliedContracts.toFixed(2)}`);
    }

    // outcome / resolved / time
    cOutcome.total++;
    if (p.outcome !== "win" && p.outcome !== "loss") fail(cOutcome, `${p.marketId} bad outcome ${p.outcome}`);
    else if (p.resolved !== true) fail(cOutcome, `${p.marketId} not resolved`);
    else if (!(p.closedAt > p.openedAt)) fail(cOutcome, `${p.marketId} closedAt<=openedAt`);
    else if (p.closedAt > NOW + 60000 || p.openedAt > NOW + 60000) fail(cOutcome, `${p.marketId} future timestamp`);

    // outcome <-> markPrice (only when held to resolution)
    cMark.total++;
    if (heldToResolution) {
      if (p.outcome === "win" && p.markPriceUsd !== 1) fail(cMark, `${p.marketId} win but mark=${p.markPriceUsd}`);
      if (p.outcome === "loss" && p.markPriceUsd !== 0) fail(cMark, `${p.marketId} loss but mark=${p.markPriceUsd}`);
    }

    // phantom fill price
    cPhantomC.total++;
    if (isNum(p.avgFillPriceUsd) && p.avgFillPriceUsd <= TH.phantomPriceUsd)
      fail(cPhantomC, `${p.marketId} phantom fill @$${p.avgFillPriceUsd}`);
  }

  // ════════ COPY FILLS ════════
  const cfPrice = check("copy-fills: entry price in (0,1)");
  const cfLag = check("copy-fills: lagDelta == our - leader");
  const cfPhantom = check("(C) copy-fills: no phantom entry price (<=$0.005)", true);
  const cfDup = check("(D) copy-fills: no duplicate (ts,wallet,market,action)", true);
  const cfTime = check("copy-fills: no future timestamp");
  const seenCf = new Set<string>();
  for (const f of cf.rows) {
    const id = `${f.ts}|${f.wallet}|${f.marketId}|${f.action}`;
    cfDup.total++;
    if (seenCf.has(id)) fail(cfDup, `dup ${id}`); else seenCf.add(id);

    if (f.action === "entry" || f.action === "increase") {
      cfPrice.total++;
      if (!inUnit(f.ourPriceUsd)) fail(cfPrice, `${f.marketId} ourPrice=${f.ourPriceUsd}`);
      if (isNum(f.leaderPriceUsd) && !inUnit(f.leaderPriceUsd)) fail(cfPrice, `${f.marketId} leaderPrice=${f.leaderPriceUsd}`);
      cfPhantom.total++;
      if (isNum(f.ourPriceUsd) && f.ourPriceUsd <= TH.phantomPriceUsd) fail(cfPhantom, `${f.marketId} phantom @$${f.ourPriceUsd}`);
      if (isNum(f.ourPriceUsd) && isNum(f.leaderPriceUsd) && isNum(f.lagDeltaUsd)) {
        cfLag.total++;
        if (Math.abs(f.lagDeltaUsd - (f.ourPriceUsd - f.leaderPriceUsd)) > TH.lagTolUsd)
          fail(cfLag, `${f.marketId} lag ${f.lagDeltaUsd} != ${(f.ourPriceUsd - f.leaderPriceUsd).toFixed(4)}`);
      }
    }
    cfTime.total++;
    if (isNum(f.ts) && f.ts * 1000 > NOW + 60000) fail(cfTime, `${f.marketId} future ts ${f.ts}`);
  }

  // ════════ BLOCKED FILLS ════════
  const bfReason = check("blocked-fills: blockedBy non-empty & known reasons");
  const bfPrice = check("blocked-fills: price in (0,1)");
  for (const b of bf.rows) {
    bfReason.total++;
    if (!Array.isArray(b.blockedBy) || b.blockedBy.length === 0) fail(bfReason, `${b.marketId} empty blockedBy`);
    else for (const r of b.blockedBy) if (!KNOWN_BLOCK.has(r)) fail(bfReason, `${b.marketId} unknown reason ${r}`);
    if (b.action === "entry" || b.action === "increase") {
      bfPrice.total++;
      if (isNum(b.ourPriceUsd) && !inUnit(b.ourPriceUsd)) fail(bfPrice, `${b.marketId} ourPrice=${b.ourPriceUsd}`);
    }
  }

  // ════════ CROSS-FILE: orphan closed positions ════════
  // Every closed position should trace to a logged copy-fill entry (same market
  // + wallet). An orphan = a position we hold with no logged fill = a logging
  // gap that silently biases the realized-PnL sample.
  const cOrphan = check("(E) cross: closed positions traceable to a copy-fill", true);
  const fillKeys = new Set(cf.rows
    .filter(f => f.action === "entry" || f.action === "increase")
    .map(f => `${f.marketId}|${f.wallet}`));
  for (const p of closed) {
    cOrphan.total++;
    const key = `${p.marketId}|${p.openedFromWallet}`;
    if (!fillKeys.has(key)) fail(cOrphan, `orphan ${p.marketId} from ${(p.openedFromWallet ?? "?").slice(0, 8)}`);
  }

  // ── report ──
  console.log("CHECKS");
  console.log("─".repeat(72));
  for (const c of checks) {
    const rate = c.total > 0 ? (100 * c.bad / c.total) : 0;
    const tag = c.bad === 0 ? "PASS" : (c.gate ? "FAIL" : "WARN");
    console.log(`  [${tag}] ${c.name}`);
    console.log(`         ${c.bad}/${c.total} bad (${rate.toFixed(1)}%)` +
      (c.samples.length ? "  e.g. " + c.samples.slice(0, 2).join(" ; ") : ""));
  }
  console.log("");

  // ── pre-registered verdict ──
  const pnlBoundsBad = checks.find(c => c.name.startsWith("(A)"))!.bad;
  const recomputeBad = checks.find(c => c.name.startsWith("(B)"))!.bad;
  const phantomBad = checks.filter(c => c.name.startsWith("(C)")).reduce((s, c) => s + c.bad, 0);
  const dupBad = checks.filter(c => c.name.startsWith("(D)")).reduce((s, c) => s + c.bad, 0);
  const orphan = checks.find(c => c.name.startsWith("(E)"))!;
  const orphanRate = orphan.total > 0 ? orphan.bad / orphan.total : 0;

  const reasons: string[] = [];
  if (pnlBoundsBad > 0) reasons.push(`A: ${pnlBoundsBad} PnL-bounds violations`);
  if (recomputeBad > 0) reasons.push(`B: ${recomputeBad} recompute mismatches`);
  if (phantomBad > 0) reasons.push(`C: ${phantomBad} phantom fills`);
  if (dupBad > 0) reasons.push(`D: ${dupBad} duplicates`);
  if (orphanRate > TH.maxOrphanRate) reasons.push(`E: orphan rate ${(orphanRate * 100).toFixed(1)}% > ${(TH.maxOrphanRate * 100)}%`);

  console.log("PRE-REGISTERED VERDICT");
  console.log("─".repeat(72));
  if (reasons.length === 0) {
    console.log("  ✅ TRUSTWORTHY — all gate checks passed. Downstream analysis may proceed.");
    console.log(`     (orphan rate ${(orphanRate * 100).toFixed(1)}% within ${(TH.maxOrphanRate * 100)}% budget)`);
    process.exitCode = 0;
  } else {
    console.log("  ❌ NOT TRUSTWORTHY — downstream analysis BLOCKED until logging is fixed.");
    for (const r of reasons) console.log(`     - ${r}`);
    process.exitCode = 1;
  }
}

main();
