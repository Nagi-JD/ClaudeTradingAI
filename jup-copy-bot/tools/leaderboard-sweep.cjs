// Full leaderboard sweep: pnl/volume/win_rate x weekly/monthly/all_time, 100 each.
// Dedupe, drop known wallets, auto-filter, then bankroll-check survivors.
const fs = require("fs");
const { execSync } = require("child_process");
const KEY = fs.readFileSync("/root/jup-copy-bot/.env", "utf8").match(/JUP_API_KEY=(.+)/)[1].trim();
const known = new Set([
  ...fs.readFileSync("/root/jup-copy-bot/.env", "utf8").match(/COPY_WATCHLIST=(.+)/)[1].split(","),
  // judged & rejected today
  "7RubT6ZYVQRHS8MbAyKG2UX1yQKH9U3XA4hkVprj4YPh", "GTtegpqYLmoLBJWs3GGjfro8o6gwkv5aVpwsqD944s8G",
  "8NMQJGcM2CgbjosaDHs92tj7eTWPXS893PSqvNrt1c7Z", "6S8QdxPnKM7dh2tTgbWifdTYcJW99Qpxb5vtb9NHv56g",
  "Aviv8GboDaosPfCCfkdp2wJakMaZUijeuPjTvfmmZcy3", "J8k8F3E8gNhxnYAPe47jkkEbt4BsDS6hmH7rYLDE1jP7",
  "Dwbn2Rkd86rdw2zADCeHmoaQ39jgru9cB47hEQhzaeJ8", "5vP4ckaouy8bSwZMzURP3JxJrr3F88XdtRYYWqv5WMt5",
  "H7bNKXEuS8s9jX1pBvTDu2Z84CyChSArCFQoYCZCY2J4", "H1ceDuzEoeXwcPrkNMPayBkEzYYA1ZcjBaAEhKdnXoY2",
  "8pa3QBsM7eKemQEY6unu6XWGwXLrQ8ZG4KXnVyetoLSB", "9f1GeNhtkuZnTGeCrBky2xmn2V5syZN7BVdZ3ZDpTAmM",
  "4NboL3fNkq6KFPmTKtTVL8Ww9YzkVJ9n8aKRo27X8vs3", "3tXABY16R6qfmxYv9eHdP8vEKto8iUTfe9ovwijzwjNs",
  "3NuZ9Ntii5oyJUNiKoQKoCcYe46PJH5o2dMN4tNo4kGb", "456xjxMrRKcp5odo8B1McWiTbvTUffFi5iCV1Ky9Sft7",
  "5ZVuxVocK7dSty7DfQFFqmUxZGPc3eX7mkYyVDHZhrA3", "6CX7iFFwzAZVbagnEocrYiM3H2Buhetcb95m3x4qW3T5",
]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const seen = new Map(); // wallet -> best entry
  for (const period of ["weekly", "monthly", "all_time"]) {
    for (const metric of ["pnl", "volume", "win_rate"]) {
      for (let a = 0; a < 4; a++) {
        try {
          const r = await fetch(`https://api.jup.ag/prediction/v1/leaderboards?period=${period}&metric=${metric}&limit=100`, { headers: { "x-api-key": KEY } });
          const j = await r.json();
          if (j.code === 429) { await sleep(8000); continue; }
          const rows = j.data || j.leaderboard || j.entries || [];
          console.log(`[sweep] ${period}/${metric}: ${rows.length}`);
          for (const e of rows) {
            const w = e.ownerPubkey || e.owner;
            if (!w || known.has(w)) continue;
            const pnl = (e.realizedPnlUsd || 0) / 1e6, vol = (e.totalVolumeUsd || 0) / 1e6, n = e.predictionsCount || 0;
            const prev = seen.get(w);
            if (!prev || pnl > prev.pnl) seen.set(w, { pnl, vol, n, wr: n ? (100 * (e.correctPredictions || 0)) / n : 0, src: `${period}/${metric}` });
          }
          break;
        } catch { await sleep(4000); }
      }
      await sleep(2500);
    }
  }
  console.log(`\nunique unknown wallets: ${seen.size}`);
  // auto-filter: real pnl + real sample + reasonable churn (edge per $1k > $3)
  const survivors = [...seen.entries()]
    .map(([w, s]) => ({ w, ...s, edge: s.vol > 0 ? (1000 * s.pnl) / s.vol : 0 }))
    .filter((s) => s.pnl >= 1000 && s.n >= 8 && s.edge >= 3)
    .sort((a, b) => b.pnl - a.pnl)
    .slice(0, 12);
  console.log(`survivors (pnl>=1k, n>=8, edge>=$3/1k): ${survivors.length}\n`);
  for (const s of survivors) {
    let bank = "n/a";
    try {
      const pf = JSON.parse(execSync(`jup spot portfolio --address ${s.w} -f json`, { timeout: 25000 }).toString());
      const tk = pf.tokens || [];
      const st = tk.filter((t) => /USD/i.test(t.symbol || "")).reduce((a, t) => a + (+t.amount || 0), 0);
      bank = "$" + st.toFixed(0);
    } catch {}
    console.log(`${s.w} pnl=$${s.pnl.toFixed(0)} n=${s.n} wr=${s.wr.toFixed(0)}% vol=$${s.vol.toFixed(0)} edge=$${s.edge.toFixed(1)}/1k stables=${bank} [${s.src}]`);
    await sleep(2500);
  }
})();
