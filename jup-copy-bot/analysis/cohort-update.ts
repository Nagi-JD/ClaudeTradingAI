// ─────────────────────────────────────────────────────────────────────────
// WALK-FORWARD COHORT ONBOARDING (mechanical, sport-specific, no look-ahead).
//
// Resolves "widen for speed" vs "freeze for rigor": a wallet enters the cohort
// the FIRST time it satisfies the frozen rule, stamped enteredMs=now; the stamp
// is NEVER re-dated (no survivorship re-dating). The forward credits a wallet's
// trades only after its enteredMs.
//
// QUALIFICATION IS SPORT-SPECIFIC (locked 2026-06-20, at 0/250):
//   verified (global skill floor)
//   AND observed sport trades >= MIN_SPORT_OBS
//   AND sport share >= MIN_SPORT_SHARE
// Global verified alone let crypto-5m wallets (e.g. 2% sport, 0% sport) into the
// cohort — they'd be copied on sport with zero edge (skill-non-transfer). The
// sport gate ensures the wallet's earned skill is in the domain we copy.
//
// Run:  npx tsx analysis/cohort-update.ts   (cron hourly)
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.env.BOT_ROOT ?? ".";
const SW = resolve(ROOT, "state/smart-wallets.json");
const TRADES = resolve(ROOT, "data/trades.jsonl");
const LEDGER = resolve(ROOT, "analysis/forward-cohort.json");

const MIN_SPORT_OBS = Number(process.env.MIN_SPORT_OBS ?? 10);
const MIN_SPORT_SHARE = Number(process.env.MIN_SPORT_SHARE ?? 0.5);
const RULE = `verified && sportObs>=${MIN_SPORT_OBS} && sportShare>=${MIN_SPORT_SHARE} (sport-specific; qualifies on data at entry)`;

interface Entry { pubkey: string; enteredMs: number; sportObs?: number; sportShare?: number; }
interface Ledger { rule: string; updatedMs: number; entries: Entry[]; }

// sport = a sporting event, NOT crypto 5-min (the skill-non-transfer trap)
function sportish(eventTitle: string, marketTitle: string): boolean {
  const x = `${eventTitle || ""} ${marketTitle || ""}`.toLowerCase();
  if (/up or down|bitcoin|ethereum|\bsolana\b|\bbtc\b|\beth\b|above|all.?time high/.test(x)) return false;
  return / vs |vs\.|:| at |open|cup|league|atp|wta|nba|mlb|nhl|lol|cs2/.test(x);
}

// per-wallet observed sport activity from the /trades feed
const trades = (() => {
  try { return readFileSync(TRADES, "utf8").trim().split("\n").map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as any[]; }
  catch { return []; }
})();
const obs = new Map<string, { tot: number; sport: number }>();
for (const t of trades) {
  const w = t.ownerPubkey ?? t.owner; if (!w) continue;
  const o = obs.get(w) ?? { tot: 0, sport: 0 };
  o.tot++; if (sportish(t.eventTitle, t.marketTitle)) o.sport++;
  obs.set(w, o);
}

function qualifies(w: any): { ok: boolean; sportObs: number; sportShare: number } {
  const o = obs.get(w?.ownerPubkey) ?? { tot: 0, sport: 0 };
  const share = o.tot > 0 ? o.sport / o.tot : 0;
  const ok = !!w && w.verified === true && o.sport >= MIN_SPORT_OBS && share >= MIN_SPORT_SHARE;
  return { ok, sportObs: o.sport, sportShare: share };
}

const wallets = Object.values(JSON.parse(readFileSync(SW, "utf8"))) as any[];
let ledger: Ledger = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, "utf8")) : { rule: RULE, updatedMs: 0, entries: [] };
if (!Array.isArray(ledger.entries)) ledger.entries = [];

const have = new Set(ledger.entries.map(e => e.pubkey));
const now = Date.now();
let added = 0;
for (const w of wallets) {
  const q = qualifies(w);
  if (q.ok && !have.has(w.ownerPubkey)) {
    ledger.entries.push({ pubkey: w.ownerPubkey, enteredMs: now, sportObs: q.sportObs, sportShare: Number(q.sportShare.toFixed(2)) });
    added++;
  }
}
ledger.rule = RULE;
ledger.updatedMs = now;
writeFileSync(LEDGER, JSON.stringify(ledger, null, 1));
console.log(`cohort ledger: ${ledger.entries.length} total (+${added} new) @ ${new Date(now).toISOString()}`);
for (const e of ledger.entries.slice(-added)) console.log(`  + ${e.pubkey.slice(0, 10)} sportObs=${e.sportObs} share=${e.sportShare}`);
