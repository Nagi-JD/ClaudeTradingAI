// ─────────────────────────────────────────────────────────────────────────
// FORWARD TEST EVALUATOR — pre-match sport edge.  Read-only.
//
// Enforces `forward-preregistration.md`. Designed to escape the forking-paths
// bias AND the correlation trap:
//   • WALK-FORWARD cohort (analysis/forward-cohort.json): each wallet credited
//     only for trades opened AFTER its enteredMs — no qualifying-record leak.
//   • EFFECTIVE N = unique (match) events, NOT raw trade lines. 20 wallets on
//     one Alcaraz match = ONE independent observation, not 20. The t-stat runs
//     on per-event means; the gate is on independent events.
//   • Principled hypothesis: pre-match (lag<3¢) SPORT — tennis is a sub-slice.
//   • Two bars: t >= 1.645 AND mean > real cost floor.
//   • Lag distribution watch: if widening drifts lag toward the in-play regime,
//     the clean set is being contaminated — flag it.
//   • PASS = green light to SHADOW-EXEC, not capital (still paper).
//
// Run:  npx tsx analysis/forward-eval.ts
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── PRE-REGISTERED CONSTANTS (frozen) ──────────────────────────────────────
const N_EVENTS = 250;                  // fixed sample = INDEPENDENT events (not trade lines)
const Z = 1.645;                       // one-sided 95%
const LAG_PREMATCH_USD = 0.03;         // |lag| < 3¢ = pre-match proxy
const COST = { tipSol: 0.001, baseLamports: 5000, p90Mult: 4, txPerPosition: 1 };

const ROOT = process.env.BOT_ROOT ?? ".";
const CLOSED = resolve(ROOT, "state/closed-positions.json");
const COPYFILLS = resolve(ROOT, "data/copy-fills.jsonl");
const QUAR = resolve(ROOT, "data/copy-fills.bad-pricing.jsonl");
const LEDGER = resolve(ROOT, "analysis/forward-cohort.json");

interface ClosedPos {
  marketId: string; marketTitle?: string; avgFillPriceUsd: number;
  netCostUsd: number; openedFromWallet?: string; openedAt: number;
  realizedPnlUsd: number; outcome: "win" | "loss";
}
interface CopyFill { ts?: number; wallet?: string; marketId?: string; action?: string; lagDeltaUsd?: number; }
interface Entry { pubkey: string; enteredMs: number; }

function loadJson<T>(p: string): T[] { const j = JSON.parse(readFileSync(p, "utf8")); return Array.isArray(j) ? j : Object.values(j); }
function loadJsonl<T>(p: string): T[] {
  try { return readFileSync(p, "utf8").trim().split("\n").map(l => { try { return JSON.parse(l) as T; } catch { return null; } }).filter((x): x is T => x !== null); }
  catch { return []; }
}
const cfKey = (f: { ts?: number; wallet?: string; marketId?: string; action?: string }) => `${f.ts}|${f.wallet}|${f.marketId}|${f.action}`;
// event = the match; strip the trailing "-N" market index so sibling/side markets of the same match collapse to one independent outcome
const eventKey = (marketId: string) => marketId.replace(/-\d+$/, "");

function isToxic(p: ClosedPos): boolean {
  const t = (p.marketTitle || "").toLowerCase();
  if (/up or down|bitcoin|ethereum|\bsolana\b|\bbtc\b|\beth\b|above|all.?time high/.test(t)) return true;
  if (/qualif/.test(t)) return true;
  if (p.avgFillPriceUsd >= 0.40 && p.avgFillPriceUsd <= 0.60) return true;
  return false;
}
function isTennis(title: string): boolean {
  const lc = (title || "").toLowerCase();
  if (/lol|cs2|cs:go|dota|valorant|\biem\b/.test(lc)) return false;
  return (title || "").includes(":") && !/fifa|world cup|goalscor/.test(lc);
}
function st(xs: number[]) {
  const n = xs.length; if (!n) return { n: 0, mean: 0, sd: 0, t: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, mean, sd, t: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0 };
}
function pct(xs: number[], q: number) { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; }
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
  const ledger = JSON.parse(readFileSync(LEDGER, "utf8")) as { entries: Entry[] };
  const enteredBy = new Map(ledger.entries.map(e => [e.pubkey, e.enteredMs]));

  // lag join (quarantine-aware)
  const lagBy = new Map<string, number>();
  for (const f of cf) {
    if ((f.action === "entry" || f.action === "increase") && !quarKeys.has(cfKey(f))) {
      const k = `${f.marketId}|${f.wallet}`; const cur = lagBy.get(k);
      if (cur === undefined || Math.abs(f.lagDeltaUsd ?? 0) > Math.abs(cur)) lagBy.set(k, f.lagDeltaUsd ?? 0);
    }
  }

  // qualifying forward trades: cohort wallet, opened AFTER its entry, sport, pre-match
  const qualifying: { p: ClosedPos; lag: number }[] = [];
  for (const p of closed) {
    const entered = enteredBy.get(p.openedFromWallet ?? "");
    if (entered === undefined || !(p.openedAt > entered)) continue;   // walk-forward
    if (isToxic(p)) continue;                                          // sport, non-toxic
    const lag = lagBy.get(`${p.marketId}|${p.openedFromWallet}`);
    if (typeof lag !== "number" || Math.abs(lag) >= LAG_PREMATCH_USD) continue; // pre-match
    qualifying.push({ p, lag });
  }

  // EFFECTIVE N: collapse correlated copies into one observation per event (match)
  const byEvent = new Map<string, number[]>();
  for (const { p } of qualifying) {
    const k = eventKey(p.marketId);
    (byEvent.get(k) ?? byEvent.set(k, []).get(k)!).push(p.realizedPnlUsd);
  }
  const eventObs = [...byEvent.values()].map(arr => arr.reduce((a, b) => a + b, 0) / arr.length); // per-event mean $/trade
  const nEvents = eventObs.length;

  console.log("FORWARD TEST — pre-match SPORT edge (pre-registered, effective-N)");
  console.log("─".repeat(72));
  console.log(`cohort wallets (walk-forward): ${ledger.entries.length}  |  fixed N: ${N_EVENTS} INDEPENDENT EVENTS  |  bars: t>=${Z} AND mean>cost`);
  console.log(`qualifying trade-lines: ${qualifying.length}  →  independent events: ${nEvents}` +
    (qualifying.length ? `  (correlation inflation ${(qualifying.length / Math.max(nEvents, 1)).toFixed(1)}x)` : ""));
  if (qualifying.length) {
    const absLags = qualifying.map(q => Math.abs(q.lag) * 100);
    console.log(`lag distribution (¢): median ${pct(absLags, 0.5).toFixed(1)}  p90 ${pct(absLags, 0.9).toFixed(1)}  (must stay < 3.0 — drift = in-play contamination)`);
  }
  console.log("");

  if (nEvents < N_EVENTS) {
    console.log(`PROGRESS: ${nEvents} / ${N_EVENTS} independent events (${(100 * nEvents / N_EVENTS).toFixed(0)}%)`);
    console.log(`  ⏳ NO VERDICT — fixed-N forbids optional stopping. Collect to ${N_EVENTS} events, evaluate once.`);
    console.log(`  (more wallets ≠ faster; more independent MATCHES = faster.)`);
    if (nEvents > 1) { const s = st(eventObs); console.log(`  [running per-event mean (NOT a decision): ${s.mean.toFixed(2)}$/t, t=${s.t.toFixed(2)} — IGNORE until N]`); }
    process.exitCode = 0; return;
  }

  // ── n >= N: evaluate ONCE on per-event observations ──
  const sol = await solUsd();
  const costFloor = (COST.tipSol + COST.baseLamports / 1e9) * sol * COST.p90Mult * COST.txPerPosition;
  const S = st(eventObs);
  const tennisEvents = [...byEvent.entries()].filter(([k]) => {
    const any = qualifying.find(q => eventKey(q.p.marketId) === k);
    return any && isTennis(any.p.marketTitle || "");
  }).map(([, arr]) => arr.reduce((a, b) => a + b, 0) / arr.length);
  const T = st(tennisEvents);
  const bar1 = S.t >= Z, bar2 = S.mean > costFloor;

  console.log("EVALUATION (once, at N — per independent event)");
  console.log("─".repeat(72));
  console.log(`  events=${S.n}  mean=${S.mean.toFixed(3)}$/t  sd=${S.sd.toFixed(2)}`);
  console.log(`  Bar 1  t=${S.t.toFixed(2)} ${bar1 ? ">=" : "<"} ${Z}            → ${bar1 ? "PASS" : "FAIL"}`);
  console.log(`  Bar 2  mean ${S.mean.toFixed(3)} ${bar2 ? ">" : "<="} cost ${costFloor.toFixed(3)} (SOL $${sol.toFixed(0)}) → ${bar2 ? "PASS" : "FAIL"}`);
  console.log(`  [tennis sub-slice (color only): events=${T.n} mean=${T.mean.toFixed(2)} t=${T.t.toFixed(2)}]`);
  console.log("");
  console.log("VERDICT");
  console.log("─".repeat(72));
  if (bar1 && bar2) {
    console.log(`  ✅ PASS — pre-match sport edge survived a clean forward (new trades, walk-forward cohort,`);
    console.log(`     effective-N events, two bars). → GREEN LIGHT TO SHADOW-EXEC. NOT to capital.`);
    process.exitCode = 0;
  } else {
    console.log(`  ❌ FAIL — pre-match edge was an in-sample mirage (${!bar1 ? "not significant on independent events" : "below cost"}). Stop.`);
    process.exitCode = 1;
  }
}

main();
