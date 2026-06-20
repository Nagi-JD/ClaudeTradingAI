// ─────────────────────────────────────────────────────────────────────────
// FORWARD TEST EVALUATOR — pre-match sport edge.  Read-only.
//
// Enforces the pre-registration in `forward-preregistration.md`. Designed to
// ESCAPE the forking-paths bias that produced the +$1.80 in-sample slice:
//   • NEW trades only (openedAt > CUTOFF) — disjoint from the 194 baseline.
//   • Fixed N, NO optional stopping — emits NO verdict until n >= N, then once.
//   • Principled hypothesis: pre-match (lag<3¢) SPORT — not hard-coded tennis.
//   • Two bars: t >= 1.645 AND mean > real cost floor.
//   • PASS = green light to SHADOW-EXEC, not capital (still paper).
//
// Run:  npx tsx analysis/forward-eval.ts
// ─────────────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── PRE-REGISTERED CONSTANTS (frozen — do not edit after data arrives) ──────
const CUTOFF_MS = 1781960030776;          // 2026-06-20T11:33:50Z; baseline excluded
const N = 300;                            // fixed sample size (budgets edge regression)
const Z = 1.645;                          // one-sided 95%
const LAG_PREMATCH_USD = 0.03;            // |lag| < 3¢ = pre-match proxy
// real cost floor (Solana p90 priority/landing fee), same model as unit-economics
const COST = { tipSol: 0.001, baseLamports: 5000, p90Mult: 4, txPerPosition: 1 };

const ROOT = process.env.BOT_ROOT ?? ".";
const CLOSED = resolve(ROOT, "state/closed-positions.json");
const COPYFILLS = resolve(ROOT, "data/copy-fills.jsonl");
const QUAR = resolve(ROOT, "data/copy-fills.bad-pricing.jsonl");

interface ClosedPos {
  marketId: string; marketTitle?: string; avgFillPriceUsd: number;
  netCostUsd: number; openedFromWallet?: string; openedAt: number;
  realizedPnlUsd: number; outcome: "win" | "loss";
}
interface CopyFill {
  ts?: number; wallet?: string; marketId?: string; action?: string;
  lagDeltaUsd?: number;
}

function loadJson<T>(p: string): T[] {
  const j = JSON.parse(readFileSync(p, "utf8"));
  return Array.isArray(j) ? j : Object.values(j);
}
function loadJsonl<T>(p: string): T[] {
  try {
    return readFileSync(p, "utf8").trim().split("\n")
      .map(l => { try { return JSON.parse(l) as T; } catch { return null; } })
      .filter((x): x is T => x !== null);
  } catch { return []; }
}
const cfKey = (f: { ts?: number; wallet?: string; marketId?: string; action?: string }) =>
  `${f.ts}|${f.wallet}|${f.marketId}|${f.action}`;

// toxic = NOT a clean pre-match sport candidate (crypto 5m / tossup / qualif)
function isToxic(p: ClosedPos): boolean {
  const t = (p.marketTitle || "").toLowerCase();
  if (/up or down|bitcoin|ethereum|\bsolana\b|\bbtc\b|\beth\b|above|all.?time high/.test(t)) return true;
  if (/qualif/.test(t)) return true;
  if (p.avgFillPriceUsd >= 0.40 && p.avgFillPriceUsd <= 0.60) return true;
  return false;
}
// tennis sub-slice (reported only; does NOT gate)
function isTennis(p: ClosedPos): boolean {
  const t = (p.marketTitle || ""); const lc = t.toLowerCase();
  if (/lol|cs2|cs:go|dota|valorant|\biem\b/.test(lc)) return false;
  return t.includes(":") && !/fifa|world cup|goalscor/.test(lc);
}
function st(xs: number[]) {
  const n = xs.length; if (!n) return { n: 0, mean: 0, sd: 0, t: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const se = sd / Math.sqrt(n);
  return { n, mean, sd, t: se > 0 ? mean / se : 0 };
}
async function solUsd(): Promise<number> {
  if (process.env.SOL_PRICE_USD) return Number(process.env.SOL_PRICE_USD);
  try {
    const id = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
    const r = await fetch(`https://hermes.pyth.network/v2/updates/price/latest?ids[]=${id}`, { signal: AbortSignal.timeout(8000) });
    const j: any = await r.json(); const pr = j.parsed[0].price;
    const v = Number(pr.price) * Math.pow(10, Number(pr.expo)); return v > 0 ? v : 150;
  } catch { return 150; }
}

async function main() {
  const closed = loadJson<ClosedPos>(CLOSED).filter(p => p.outcome === "win" || p.outcome === "loss");
  const cf = loadJsonl<CopyFill>(COPYFILLS);
  const quarKeys = new Set(loadJsonl<CopyFill>(QUAR).map(cfKey));

  // lag join (quarantine-aware): marketId|wallet -> worst entry lag
  const lagBy = new Map<string, number>();
  for (const f of cf) {
    if ((f.action === "entry" || f.action === "increase") && !quarKeys.has(cfKey(f))) {
      const k = `${f.marketId}|${f.wallet}`;
      const cur = lagBy.get(k);
      if (cur === undefined || Math.abs(f.lagDeltaUsd ?? 0) > Math.abs(cur)) lagBy.set(k, f.lagDeltaUsd ?? 0);
    }
  }

  // forward population: NEW (after cutoff) + sport (not toxic) + pre-match (lag<3¢)
  const forwardAll = closed.filter(p => p.openedAt > CUTOFF_MS);
  const sport = forwardAll.filter(p => !isToxic(p));
  const qualifying = sport.filter(p => {
    const lag = lagBy.get(`${p.marketId}|${p.openedFromWallet}`);
    return typeof lag === "number" && Math.abs(lag) < LAG_PREMATCH_USD;
  });

  console.log("FORWARD TEST — pre-match SPORT edge (pre-registered)");
  console.log("─".repeat(72));
  console.log(`cutoff: ${new Date(CUTOFF_MS).toISOString()}  |  fixed N: ${N}  |  bars: t>=${Z} AND mean>cost`);
  console.log(`new closed (post-cutoff): ${forwardAll.length}  →  sport: ${sport.length}  →  pre-match (lag<3¢): ${qualifying.length}`);
  console.log("");

  if (qualifying.length < N) {
    const pct = (100 * qualifying.length / N).toFixed(0);
    console.log(`PROGRESS: ${qualifying.length} / ${N} qualifying trades (${pct}%)`);
    console.log(`  ⏳ NO VERDICT — fixed-N design forbids optional stopping. Collect to N=${N}, then evaluate once.`);
    console.log(`  (need ${N - qualifying.length} more new pre-match sport copies.)`);
    if (qualifying.length > 0) {
      const s = st(qualifying.map(p => p.realizedPnlUsd));
      console.log(`  [running mean (informational, NOT a decision): ${s.mean.toFixed(2)}$/t, t=${s.t.toFixed(2)} — IGNORE until N]`);
    }
    process.exitCode = 0;
    return;
  }

  // ── n >= N: evaluate ONCE ──
  const sol = await solUsd();
  const costFloor = (COST.tipSol + COST.baseLamports / 1e9) * sol * COST.p90Mult * COST.txPerPosition;
  const S = st(qualifying.map(p => p.realizedPnlUsd));
  const wr = 100 * qualifying.filter(p => p.outcome === "win").length / qualifying.length;
  const bar1 = S.t >= Z;
  const bar2 = S.mean > costFloor;
  const tennis = st(qualifying.filter(isTennis).map(p => p.realizedPnlUsd));

  console.log("EVALUATION (once, at N)");
  console.log("─".repeat(72));
  console.log(`  n=${S.n}  win=${wr.toFixed(0)}%  mean=${S.mean.toFixed(3)}$/t  sd=${S.sd.toFixed(2)}  total=${(S.mean * S.n).toFixed(0)}$`);
  console.log(`  Bar 1  t=${S.t.toFixed(2)} ${bar1 ? ">=" : "<"} ${Z}        → ${bar1 ? "PASS" : "FAIL"}`);
  console.log(`  Bar 2  mean ${S.mean.toFixed(3)} ${bar2 ? ">" : "<="} cost ${costFloor.toFixed(3)} (SOL $${sol.toFixed(0)}) → ${bar2 ? "PASS" : "FAIL"}`);
  console.log(`  [tennis sub-slice (color only): n=${tennis.n} mean=${tennis.mean.toFixed(2)} t=${tennis.t.toFixed(2)}]`);
  console.log("");
  console.log("VERDICT");
  console.log("─".repeat(72));
  if (bar1 && bar2) {
    console.log(`  ✅ PASS — pre-match sport edge survived a clean forward (new trades, fixed N, two bars).`);
    console.log(`     → GREEN LIGHT TO SHADOW-EXEC. NOT to real capital. Paper keeps the haircut one more stage.`);
    process.exitCode = 0;
  } else {
    console.log(`  ❌ FAIL — the pre-match edge was an in-sample mirage (${!bar1 ? "not significant" : "below cost"}). Stop.`);
    process.exitCode = 1;
  }
}

main();
