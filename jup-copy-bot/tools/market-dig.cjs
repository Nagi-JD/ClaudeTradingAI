// Dig the accumulated global feed for copyable candidates: owners trading
// NON-binary markets (sports/politics/etc) with real size, then profile +
// bankroll-check the unknowns.
const fs = require("fs");
const { execSync } = require("child_process");
const KEY = fs.readFileSync("/root/jup-copy-bot/.env", "utf8").match(/JUP_API_KEY=(.+)/)[1].trim();
const watch = new Set(fs.readFileSync("/root/jup-copy-bot/.env", "utf8").match(/COPY_WATCHLIST=(.+)/)[1].split(","));
const rejected = new Set(JSON.parse(fs.existsSync("/root/rejected.json") ? fs.readFileSync("/root/rejected.json", "utf8") : "[]"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = fs.readFileSync("/root/jup-copy-bot/data/trades.jsonl", "utf8").trim().split("\n");
const st = {};
for (const l of lines) {
  let t; try { t = JSON.parse(l); } catch { continue; }
  if (/Up or Down/i.test(t.eventTitle)) continue; // binaries = discovery only
  const o = t.owner || t.ownerPubkey;
  if (watch.has(o) || rejected.has(o)) continue;
  const s = (st[o] ??= { n: 0, usd: 0, evts: new Set() });
  s.n++; s.usd += Number(t.amountUsd) / 1e6; s.evts.add(t.eventTitle.slice(0, 30));
}
const cands = Object.entries(st)
  .map(([o, s]) => ({ o, n: s.n, usd: s.usd, avg: s.usd / s.n, evts: s.evts.size }))
  .filter((c) => c.n >= 2 && c.avg >= 100)
  .sort((a, b) => b.usd - a.usd)
  .slice(0, 15);
console.log("candidats feed (non-binaire, n>=2, avg>=$100):", cands.length);
(async () => {
  for (const c of cands) {
    let prof = "?", bank = "?";
    for (let a = 0; a < 3; a++) {
      try {
        const r = await fetch("https://api.jup.ag/prediction/v1/profiles/" + c.o, { headers: { "x-api-key": KEY } });
        const p = await r.json();
        if (p.code === 429) { await sleep(8000); continue; }
        const pnl = (p.realizedPnlUsd || 0) / 1e6, n = p.predictionsCount || 0;
        prof = `pnl=$${pnl.toFixed(0)} n=${n} wr=${n ? ((100 * p.correctPredictions) / n).toFixed(0) : 0}%`;
        break;
      } catch { await sleep(4000); }
    }
    await sleep(2000);
    try {
      const pf = JSON.parse(execSync(`jup spot portfolio --address ${c.o} -f json`, { timeout: 25000 }).toString());
      const stb = (pf.tokens || []).filter((t) => /USD/i.test(t.symbol || "")).reduce((a, t) => a + (+t.amount || 0), 0);
      bank = "$" + stb.toFixed(0);
    } catch {}
    console.log(`${c.o} | feed: $${c.usd.toFixed(0)}/${c.n}t avg $${c.avg.toFixed(0)} ${c.evts}evts | ${prof} | stables ${bank}`);
    await sleep(2000);
  }
})();
