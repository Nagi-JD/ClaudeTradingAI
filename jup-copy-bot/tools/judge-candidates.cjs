// Profile every scanner candidate not already tracked/watchlisted; print promising ones.
const fs = require("fs");
const KEY = fs.readFileSync("/root/jup-copy-bot/.env", "utf8").match(/JUP_API_KEY=(.+)/)[1].trim();
const s = JSON.parse(fs.readFileSync("/root/jup-copy-bot/state/state.json", "utf8"));
const tracked = new Set(Object.keys(s.smartWallets || {}));
const watch = new Set(fs.readFileSync("/root/jup-copy-bot/.env", "utf8").match(/COPY_WATCHLIST=(.+)/)[1].split(","));
const cands = Object.keys(s.candidates || {}).filter((c) => !tracked.has(c) && !watch.has(c));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
console.log("candidats non-trackes a profiler:", cands.length);
(async () => {
  const good = [];
  for (const w of cands) {
    for (let a = 0; a < 3; a++) {
      try {
        const r = await fetch("https://api.jup.ag/prediction/v1/profiles/" + w, { headers: { "x-api-key": KEY } });
        const p = await r.json();
        if (p.code === 429) { await sleep(6000); continue; }
        const pnl = (p.realizedPnlUsd || 0) / 1e6, n = p.predictionsCount || 0;
        const wr = n ? (100 * p.correctPredictions) / n : 0, vol = (p.totalVolumeUsd || 0) / 1e6;
        if (pnl > 300 && n >= 5) good.push({ w, pnl, n, wr, vol });
        break;
      } catch { await sleep(3000); }
    }
    await sleep(1400);
  }
  console.log("\nprometteurs (pnl>$300, n>=5):", good.length);
  for (const g of good.sort((a, b) => b.pnl - a.pnl))
    console.log(g.w, "pnl=$" + g.pnl.toFixed(0), "n=" + g.n, "wr=" + g.wr.toFixed(0) + "%", "vol=$" + g.vol.toFixed(0));
})();
