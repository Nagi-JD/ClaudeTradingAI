// ─────────────────────────────────────────────────────────────────────────
// WALK-FORWARD COHORT ONBOARDING (mechanical, no look-ahead).
//
// Resolves the tension between "widen observation for speed" and "freeze the
// cohort for rigor": each wallet enters the test cohort the FIRST time it
// satisfies the frozen, pre-registered rule — and is stamped with enteredMs=now.
// An existing entry's enteredMs is NEVER changed (no survivorship re-dating).
// The forward test then credits each wallet's trades ONLY after its enteredMs,
// so a wallet's qualifying record can never leak into its own test window.
//
// Run periodically (cron) while widening observation. Adding wallets here does
// NOT change the copy DECISION rule — that stays exactly as pre-registered.
//
// Run:  npx tsx analysis/cohort-update.ts
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.env.BOT_ROOT ?? ".";
const SW = resolve(ROOT, "state/smart-wallets.json");
const LEDGER = resolve(ROOT, "analysis/forward-cohort.json");
const MIN_PREDS = Number(process.env.MIN_COPY_PREDS ?? 50);
const RULE = `verified && predictions>=${MIN_PREDS} (qualifies on data available at entry)`;

interface Entry { pubkey: string; enteredMs: number; predsAtEntry?: number; wrAtEntry?: number; }
interface Ledger { rule: string; updatedMs: number; entries: Entry[]; }

function qualifies(w: any): boolean {
  return !!w && w.verified === true && (w.predictions ?? 0) >= MIN_PREDS;
}

const sw = JSON.parse(readFileSync(SW, "utf8"));
const wallets = Object.values(sw) as any[];

let ledger: Ledger = existsSync(LEDGER)
  ? JSON.parse(readFileSync(LEDGER, "utf8"))
  : { rule: RULE, updatedMs: 0, entries: [] };
if (!Array.isArray(ledger.entries)) ledger.entries = [];

const have = new Set(ledger.entries.map(e => e.pubkey));
const now = Date.now();
let added = 0;
for (const w of wallets) {
  if (qualifies(w) && !have.has(w.ownerPubkey)) {
    ledger.entries.push({
      pubkey: w.ownerPubkey, enteredMs: now,
      predsAtEntry: w.predictions, wrAtEntry: Math.round(w.winRatePct ?? 0),
    });
    added++;
  }
}
ledger.rule = RULE;
ledger.updatedMs = now;
writeFileSync(LEDGER, JSON.stringify(ledger, null, 1));
console.log(`cohort ledger: ${ledger.entries.length} total (+${added} new) @ ${new Date(now).toISOString()}`);
if (added) for (const e of ledger.entries.slice(-added)) console.log(`  + ${e.pubkey.slice(0, 10)} preds=${e.predsAtEntry} wr=${e.wrAtEntry}%`);
