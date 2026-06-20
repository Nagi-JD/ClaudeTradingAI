// ─────────────────────────────────────────────────────────────────────────
// PHASE 0.5 — UNIT ECONOMICS (upper-bound kill test) + PRE-REGISTERED FORWARD
// THRESHOLD.  Read-only. Runs only on TRUSTWORTHY data (Phase 0 must pass first).
//
// Two of the cheapest disconfirming tests, both committed BEFORE the forward run:
//
//  (1) UPPER-BOUND UNIT ECONOMICS.  Take the MOST OPTIMISTIC in-sample edge (the
//      clean, overfit number — used deliberately as a ceiling). It already nets
//      the spread crossed (sim fills) and the Jupiter entry fee (in netCost).
//      Subtract the ONE friction paper never paid: the Solana priority/landing
//      fee at a PESSIMISTIC (p90 congestion) level. If even the ceiling minus the
//      pessimistic floor of costs is <= 0, the project is dead at this size — stop
//      now. This is (cost) ÷ (kill-probability)-optimal: cheap, and uses the
//      number we KNOW is inflated as the upper bound.
//
//  (2) MINIMUM DETECTABLE FORWARD EDGE.  From the per-trade variance, the edge a
//      forward run of N trades would need to be statistically distinguishable
//      from zero. PRE-REGISTER it: if the forward edge lands below this, it is
//      DEAD even if positive. Fixing the rule while neutral = pre-registration.
//
// Run:  npx tsx analysis/unit-economics.ts        (fetches SOL price live)
//       SOL_PRICE_USD=150 npx tsx analysis/unit-economics.ts   (override)
// ─────────────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.env.BOT_ROOT ?? ".";
const CLOSED = resolve(ROOT, "state/closed-positions.json");

// ── pre-registered parameters (commit BEFORE looking) ──────────────────────
const PARAMS = {
  forwardN: Number(process.env.FORWARD_N ?? 500),  // planned forward sample
  z: 1.645,                                          // one-sided 95% confidence
  // Solana real-money execution cost (paper never paid this):
  tipSol: Number(process.env.TIP_SOL ?? 0.001),     // Jupiter landing tip
  baseLamports: 5000,                               // base tx fee
  p90Mult: Number(process.env.P90_MULT ?? 4),       // congestion multiplier (p90 vs typical)
  txPerPosition: Number(process.env.TX_PER_POSITION ?? 1), // entry only; settle is keeper-free
};

interface ClosedPos {
  marketId: string; marketTitle?: string; avgFillPriceUsd: number;
  netCostUsd: number; feeUsd?: number; exitFeeUsd?: number;
  realizedPnlUsd: number; outcome: "win" | "loss";
}

function loadJson<T>(p: string): T[] {
  const j = JSON.parse(readFileSync(p, "utf8"));
  return Array.isArray(j) ? j : Object.values(j);
}
const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);
function stats(xs: number[]) {
  const n = xs.length; if (n === 0) return { n: 0, mean: 0, sd: 0, se: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, mean, sd, se: sd / Math.sqrt(n) };
}

// toxic classification (matches the bot's blockFilters, minus `live` which needs
// per-fill lag absent from closed-positions — so "clean" here is slightly
// OPTIMISTIC, which is correct for an upper-bound test).
function isToxic(p: ClosedPos): boolean {
  const t = (p.marketTitle || "").toLowerCase();
  if (/up or down|bitcoin|ethereum|\bsolana\b|\bbtc\b|\beth\b|all.?time high|\babove\b/.test(t)) return true; // crypto
  if (/qualif/.test(t)) return true;                                       // qualif
  if (p.avgFillPriceUsd >= 0.40 && p.avgFillPriceUsd <= 0.60) return true; // tossup
  return false;
}

async function fetchSolUsd(): Promise<number> {
  if (process.env.SOL_PRICE_USD) return Number(process.env.SOL_PRICE_USD);
  try {
    const id = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
    const r = await fetch(`https://hermes.pyth.network/v2/updates/price/latest?ids[]=${id}`, { signal: AbortSignal.timeout(8000) });
    const j: any = await r.json();
    const pr = j.parsed[0].price;
    const v = Number(pr.price) * Math.pow(10, Number(pr.expo));
    return v > 0 ? v : 150;
  } catch { return 150; }
}

async function main() {
  const all = loadJson<ClosedPos>(CLOSED).filter(p => p.outcome === "win" || p.outcome === "loss");
  const clean = all.filter(p => !isToxic(p));
  const toxic = all.filter(p => isToxic(p));

  const allPnl = all.map(p => num(p.realizedPnlUsd));
  const cleanPnl = clean.map(p => num(p.realizedPnlUsd));
  const A = stats(allPnl), C = stats(cleanPnl);

  // per-$ normalisation (stakes vary $10-21)
  const cleanPerDollar = clean.map(p => num(p.realizedPnlUsd) / Math.max(num(p.netCostUsd), 1));
  const Cpd = stats(cleanPerDollar);
  const avgStake = stats(clean.map(p => num(p.netCostUsd))).mean;

  const avgEntryFee = stats(all.map(p => num(p.feeUsd))).mean;
  const avgExitFee = stats(all.filter(p => p.exitFeeUsd).map(p => num(p.exitFeeUsd))).mean;

  const sol = await fetchSolUsd();
  const txCostTypical = (PARAMS.tipSol + PARAMS.baseLamports / 1e9) * sol;
  const priorityFee = txCostTypical * PARAMS.p90Mult * PARAMS.txPerPosition;

  console.log("PHASE 0.5 — UNIT ECONOMICS + FORWARD THRESHOLD");
  console.log("─".repeat(72));
  console.log(`closed positions: ${all.length}  (clean ${clean.length} / toxic ${toxic.length})`);
  console.log(`SOL/USD: $${sol.toFixed(2)} (${process.env.SOL_PRICE_USD ? "override" : "live"})`);
  console.log("");

  console.log("EDGE (in-sample, realized)");
  console.log("─".repeat(72));
  console.log(`  ALL trades   : mean ${A.mean.toFixed(3)}$/trade  sd ${A.sd.toFixed(2)}  se ${A.se.toFixed(3)}  (n=${A.n})`);
  console.log(`  CLEAN (optimistic ceiling): mean ${C.mean.toFixed(3)}$/trade  sd ${C.sd.toFixed(2)}  se ${C.se.toFixed(3)}  (n=${C.n})`);
  console.log(`               per-$: ${Cpd.mean.toFixed(4)}$/$  | avg stake $${avgStake.toFixed(2)}`);
  console.log(`  embedded in realized: entry fee avg $${avgEntryFee.toFixed(3)}, exit fee avg $${avgExitFee.toFixed(3)} (spread crossed via sim fills)`);
  console.log("");

  console.log("(1) UPPER-BOUND UNIT ECONOMICS  — does the optimistic ceiling survive real costs?");
  console.log("─".repeat(72));
  console.log(`  optimistic clean edge (ceiling) ........ +${C.mean.toFixed(3)} $/trade`);
  console.log(`  Solana priority/landing fee (p90) ...... -${priorityFee.toFixed(3)} $/trade`);
  console.log(`     (tip ${PARAMS.tipSol} SOL + base ${PARAMS.baseLamports} lamports = $${txCostTypical.toFixed(4)}/tx × ${PARAMS.p90Mult} p90 × ${PARAMS.txPerPosition} tx)`);
  const realCeiling = C.mean - priorityFee;
  console.log(`  ───────────────────────────────────────────────────`);
  console.log(`  real-money UPPER-BOUND edge ............ ${realCeiling >= 0 ? "+" : ""}${realCeiling.toFixed(3)} $/trade`);
  console.log("");

  console.log("(2) MINIMUM DETECTABLE FORWARD EDGE  — pre-registered kill line");
  console.log("─".repeat(72));
  const minDetect = PARAMS.z * C.sd / Math.sqrt(PARAMS.forwardN);
  console.log(`  per-trade sd (clean) ................... $${C.sd.toFixed(2)}`);
  console.log(`  forward N (planned) ................... ${PARAMS.forwardN}`);
  console.log(`  min edge distinguishable from 0 (z=${PARAMS.z}) .. $${minDetect.toFixed(3)} /trade`);
  console.log(`  → PRE-REGISTERED: a forward run of ${PARAMS.forwardN} trades must beat`);
  console.log(`    +$${minDetect.toFixed(3)}/trade NET to be real. Below that = DEAD even if positive.`);
  // also: how many trades to prove the (real-money) ceiling edge, if it's >0?
  if (realCeiling > 0) {
    const nNeeded = Math.ceil((PARAMS.z * C.sd / realCeiling) ** 2);
    console.log(`  → at the real-money ceiling edge (+$${realCeiling.toFixed(3)}), proving it needs ~${nNeeded} trades.`);
  }
  console.log("");

  // ── FAVORITES-ONLY cut: lower variance → faster convergence ──────────────
  // The full clean set is longshot-heavy (huge sd). Favorites (fill >= $0.60)
  // historically have 4-5x lower per-trade variance — the only plausibly
  // provable subset. Test whether a path to proof exists at all.
  const FAV_MIN = Number(process.env.FAV_MIN_PRICE ?? 0.60);
  const fav = clean.filter(p => p.avgFillPriceUsd >= FAV_MIN);
  const F = stats(fav.map(p => num(p.realizedPnlUsd)));
  const favRealCeiling = F.mean - priorityFee;
  const favMinDetect = F.n > 1 ? PARAMS.z * F.sd / Math.sqrt(PARAMS.forwardN) : Infinity;
  const favNNeeded = favRealCeiling > 0 ? Math.ceil((PARAMS.z * F.sd / favRealCeiling) ** 2) : Infinity;
  console.log(`FAVORITES-ONLY (fill >= $${FAV_MIN}, clean)  — lower-variance subset`);
  console.log("─".repeat(72));
  console.log(`  n=${F.n}  mean ${F.mean.toFixed(3)}$/trade  sd ${F.sd.toFixed(2)}  | real-money ceiling ${(favRealCeiling).toFixed(3)}$/trade`);
  console.log(`  min detectable (N=${PARAMS.forwardN}): $${Number.isFinite(favMinDetect) ? favMinDetect.toFixed(3) : "n/a"}/trade  | trades to prove ceiling: ${Number.isFinite(favNNeeded) ? "~" + favNNeeded : "∞"}`);
  console.log("");

  console.log("PRE-REGISTERED VERDICT");
  console.log("─".repeat(72));
  if (realCeiling <= 0) {
    console.log(`  ❌ KILL — even the inflated in-sample ceiling (+$${C.mean.toFixed(3)}) dies on p90 priority fees`);
    console.log(`     (real-money upper bound ${realCeiling.toFixed(3)}$/trade ≤ 0). No forward run justified.`);
    process.exitCode = 1;
  } else if (realCeiling < minDetect) {
    console.log(`  ❌ UNPROVABLE (full clean set) — real-money ceiling +$${realCeiling.toFixed(3)} is BELOW the`);
    console.log(`     ${PARAMS.forwardN}-trade noise floor +$${minDetect.toFixed(3)}. Even the OVERFIT edge can't be proven at N=${PARAMS.forwardN}`);
    console.log(`     (needs ~${Math.ceil((PARAMS.z * C.sd / realCeiling) ** 2)} trades). With ~194 lifetime trades + a saturated rate limit,`);
    console.log(`     this set is statistically out of reach. Do NOT run a doomed forward on it.`);
    if (favRealCeiling > favMinDetect && Number.isFinite(favNNeeded)) {
      console.log(`  → ONLY plausible path: FAVORITES-ONLY subset (ceiling +$${favRealCeiling.toFixed(3)} > floor +$${favMinDetect.toFixed(3)}, ~${favNNeeded} trades).`);
      console.log(`     Re-scope the forward to fill >= $${FAV_MIN} ONLY, or accept no provable edge exists.`);
    } else {
      console.log(`  → Even favorites-only does not clear its own noise floor. No provable edge at any achievable N.`);
    }
    process.exitCode = 1;
  } else {
    console.log(`  ⚠️ SURVIVES — ceiling +$${realCeiling.toFixed(3)} clears both costs AND the ${PARAMS.forwardN}-trade floor +$${minDetect.toFixed(3)}.`);
    console.log(`     Still the OVERFIT number: forward must clear +$${minDetect.toFixed(3)}/trade NET. Proceed to forward, not live.`);
    process.exitCode = 0;
  }
}

main();
