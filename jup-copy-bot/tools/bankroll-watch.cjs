// Daily bankroll-delta watcher. Real-mint stablecoin balances (no symbol
// matching — scam tokens impersonate "USDC") for watchlist + tracked wallets,
// via Helius RPC (no Jupiter rate limit). Alerts on ±30% day-over-day moves.
const fs = require("fs");
const ENV = fs.readFileSync("/root/jup-copy-bot/.env", "utf8");
const RPC = ENV.match(/HELIUS_WS_URL=(.+)/)[1].trim().replace("wss://", "https://");
const MINTS = {
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  JupUSD: "JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD",
};
const HIST = "/root/bankrolls.json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function stables(wallet) {
  let total = 0;
  for (const mint of Object.values(MINTS)) {
    try {
      const r = await fetch(RPC, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner", params: [wallet, { mint }, { encoding: "jsonParsed" }] }),
      });
      const j = await r.json();
      for (const acc of j.result?.value || []) total += acc.account.data.parsed.info.tokenAmount.uiAmount || 0;
    } catch {}
    await sleep(150);
  }
  return total;
}

(async () => {
  while (true) {
    const watch = ENV.match(/COPY_WATCHLIST=(.+)/)[1].split(",").map((s) => s.trim()).filter(Boolean);
    let tracked = [];
    try { tracked = Object.keys(JSON.parse(fs.readFileSync("/root/jup-copy-bot/state/state.json", "utf8")).smartWallets || {}); } catch {}
    const wallets = [...new Set([...watch, ...tracked])];
    let hist = {};
    try { hist = JSON.parse(fs.readFileSync(HIST, "utf8")); } catch {}
    for (const w of wallets) {
      const now = await stables(w);
      const prev = hist[w]?.usd;
      hist[w] = { usd: +now.toFixed(0), ts: Date.now() };
      if (prev != null && prev >= 100) {
        const chg = (now - prev) / prev;
        if (Math.abs(chg) >= 0.30) {
          const dir = chg > 0 ? "📈 CROISSANCE" : "📉 EFFONDREMENT";
          const inWatch = watch.includes(w) ? " [WATCHLIST]" : "";
          console.log(`[BANKROLL] ${dir} ${(chg * 100).toFixed(0)}% — ${w} : $${prev} → $${now.toFixed(0)}${inWatch}`);
          fetch(process.env.DISCORD_WEBHOOK_URL, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ embeds: [{ title: `${dir} ${(chg * 100).toFixed(0)}%${inWatch}`, color: chg > 0 ? 0x2ecc71 : 0xe74c3c,
              description: `**Wallet:** \`${w}\`\n$${prev} → $${now.toFixed(0)}\n[portfolio](https://jup.ag/portfolio/${w})` }] }),
          }).catch(() => {});
        }
      }
      await sleep(300);
    }
    fs.writeFileSync(HIST, JSON.stringify(hist, null, 1));
    console.log(`[bankroll] snapshot ${wallets.length} wallets ok — prochain dans 24h`);
    await sleep(24 * 3600 * 1000);
  }
})();
