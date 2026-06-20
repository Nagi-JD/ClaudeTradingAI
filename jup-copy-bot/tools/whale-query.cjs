#!/usr/bin/env node
// Query the whale database. Examples:
//   node whale-query.cjs --since 6h --min 2000
//   node whale-query.cjs --wallet 8jqFQXuE --since 24h
//   node whale-query.cjs --market "UFC" --min 1000
//   node whale-query.cjs --since 12h --top   (aggregate by wallet)
const fs = require("fs");
const args = process.argv.slice(2);
const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const sinceArg = get("--since") || "24h";
const min = Number(get("--min") || 0);
const wallet = get("--wallet");
const market = get("--market");
const top = args.includes("--top");
const mult = { m: 60, h: 3600, d: 86400 }[sinceArg.slice(-1)] || 3600;
const cutoff = Date.now() / 1000 - parseFloat(sinceArg) * mult;

const rows = fs.readFileSync("/root/jup-copy-bot/data/whales.jsonl", "utf8").trim().split("\n")
  .filter(Boolean).map((l) => JSON.parse(l))
  .filter((r) => r.ts >= cutoff && r.usd >= min)
  .filter((r) => !wallet || r.wallet.startsWith(wallet))
  .filter((r) => !market || new RegExp(market, "i").test(r.event + " " + r.market));

if (top) {
  const agg = {};
  for (const r of rows) { const a = (agg[r.wallet] ??= { n: 0, usd: 0 }); a.n++; a.usd += r.usd; }
  for (const [w, a] of Object.entries(agg).sort((x, y) => y[1].usd - x[1].usd).slice(0, 20))
    console.log(`${w}  $${a.usd.toFixed(0)} sur ${a.n} trades`);
} else {
  for (const r of rows.sort((a, b) => b.ts - a.ts).slice(0, 50))
    console.log(`${new Date(r.ts * 1000).toISOString().slice(5, 16)}  $${String(r.usd.toFixed(0)).padStart(6)}  ${r.action.padEnd(4)} ${r.side.padEnd(3)} @$${r.price}  ${r.wallet.slice(0, 8)}…  ${(r.event || "").slice(0, 42)}`);
  console.log(`-- ${rows.length} trades, $${rows.reduce((a, r) => a + r.usd, 0).toFixed(0)} total`);
}
