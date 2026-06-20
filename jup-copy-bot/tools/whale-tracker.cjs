// Live whale tracker for Jupiter prediction markets.
// - Persistent Helius websocket on the prediction program (3ZZuTbwC…) → any
//   prediction tx anywhere triggers an immediate /trades poll (debounced 2s).
// - Baseline /trades poll every 20s (the feed carries USD notional).
// - Every trade with amountUsd >= WHALE_MIN_USD is appended to whales.jsonl.
// Query with whale-query.cjs (time window / threshold / wallet / market).
const fs = require("fs");
const WebSocket = require("/root/jup-copy-bot/node_modules/ws");

const ENV = fs.readFileSync("/root/jup-copy-bot/.env", "utf8");
const KEY = ENV.match(/JUP_API_KEY=(.+)/)[1].trim();
const WS_URL = ENV.match(/HELIUS_WS_URL=(.+)/)[1].trim();
const PROGRAM = "3ZZuTbwC6aJbvteyVxXUS7gtFYdf7AuXeitx6VyvjvUp";
const MIN_USD = Number(process.env.WHALE_MIN_USD || 1000);
const OUT = "/root/jup-copy-bot/data/whales.jsonl";
const STATE = "/root/whale-tracker-state.json";

let lastId = 0;
try { lastId = JSON.parse(fs.readFileSync(STATE, "utf8")).lastId || 0; } catch {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    for (let a = 0; a < 3; a++) {
      const r = await fetch("https://api.jup.ag/prediction/v1/trades", { headers: { "x-api-key": KEY } });
      const j = await r.json();
      if (j.code === 429) { await sleep(5000); continue; }
      const rows = (j.data || []).filter((t) => t.id > lastId).sort((a, b) => a.id - b.id);
      for (const t of rows) {
        lastId = Math.max(lastId, t.id);
        const usd = Number(t.amountUsd) / 1e6;
        if (usd < MIN_USD) continue;
        const rec = {
          id: t.id, ts: t.timestamp, wallet: t.ownerPubkey, marketId: t.marketId,
          eventId: t.eventId, event: t.eventTitle, market: t.marketTitle,
          action: t.action, side: t.side, usd: +usd.toFixed(2),
          price: +(Number(t.priceUsd) / 1e6).toFixed(4),
        };
        fs.appendFileSync(OUT, JSON.stringify(rec) + "\n");
        console.log(`[WHALE] $${usd.toFixed(0)} ${t.action} ${t.side} @$${rec.price} | ${t.ownerPubkey.slice(0, 8)}… | ${(t.eventTitle || "").slice(0, 45)}`);
        notifyDiscord(rec).catch(() => {});
      }
      fs.writeFileSync(STATE, JSON.stringify({ lastId }));
      break;
    }
  } catch (e) { console.error("[poll] " + e.message); }
  polling = false;
}

const WHALE_HOOK = process.env.DISCORD_WEBHOOK_URL;
async function notifyDiscord(rec) {
  const desc = [
    `**${rec.action.toUpperCase()} ${rec.side.toUpperCase()}** @ $${rec.price} — **$${rec.usd.toFixed(0)}**`,
    `**Wallet:** \`${rec.wallet}\``,
    `**Marché:** ${rec.event || ""} — ${rec.market || ""}`,
    `[portfolio](https://jup.ag/portfolio/${rec.wallet}) · [solscan](https://solscan.io/account/${rec.wallet})`,
  ].join("\n");
  await fetch(WHALE_HOOK, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ embeds: [{ title: `🐋 Whale $${rec.usd.toFixed(0)}`, description: desc, color: 0x58a1ff}] }),
  });
}

// --- Settlement watcher: big payout claims = proven winners, judged at source.
const RPC_URL = WS_URL.replace("wss://", "https://");
const USD_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD",  // JupUSD
]);
const CLAIM_MIN_USD = Number(process.env.CLAIM_MIN_USD || 2000);
const SETTLE_OUT = "/root/jup-copy-bot/data/settlements.jsonl";
async function inspectClaim(sig) {
  const r = await fetch(RPC_URL, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [sig, { maxSupportedTransactionVersion: 0, encoding: "json" }] }),
  });
  const tx = (await r.json()).result;
  if (!tx) return;
  // Payout = positive USD-mint token delta; its owner is the winner.
  const pre = new Map((tx.meta.preTokenBalances || []).map((b) => [b.accountIndex, b]));
  for (const post of tx.meta.postTokenBalances || []) {
    if (!USD_MINTS.has(post.mint)) continue;
    const before = pre.get(post.accountIndex)?.uiTokenAmount?.uiAmount || 0;
    const delta = (post.uiTokenAmount?.uiAmount || 0) - before;
    if (delta < CLAIM_MIN_USD) continue;
    const rec = { ts: Math.floor(Date.now() / 1000), sig, wallet: post.owner, payoutUsd: +delta.toFixed(2) };
    fs.appendFileSync(SETTLE_OUT, JSON.stringify(rec) + "\n");
    console.log(`[CLAIM] $${delta.toFixed(0)} payout → ${post.owner}`);
    notifyDiscordClaim(rec).catch(() => {});
  }
}
async function notifyDiscordClaim(rec) {
  await fetch(WHALE_HOOK, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ embeds: [{ title: `🏆 Payout $${rec.payoutUsd.toFixed(0)} — gagnant prouvé`, color: 0x2ecc71,
      description: `**Wallet:** \`${rec.wallet}\`\n[portfolio](https://jup.ag/portfolio/${rec.wallet}) · [tx](https://solscan.io/tx/${rec.sig})` }] }),
  });
}

// Baseline poll
setInterval(poll, 20_000);
poll();

// Helius push trigger: any prediction-program tx → debounced immediate poll.
let pending = null;
function connect() {
  const ws = new WebSocket(WS_URL);
  let ping;
  ws.on("open", () => {
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: [PROGRAM] }, { commitment: "confirmed" }] }));
    ping = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.ping(); }, 30_000);
    console.log("[ws] connected — watching prediction program globally");
  });
  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.method !== "logsNotification" || m.params?.result?.value?.err) return;
    const v = m.params.result.value;
    // Settlement signal: a payout claim reveals a PROVEN winner — far stronger
    // than entry signals. Inspect the tx for who got paid and how much.
    if ((v.logs || []).some((l) => l.includes("Instruction: ClaimPayout"))) {
      inspectClaim(v.signature).catch(() => {});
    }
    if (!pending) pending = setTimeout(() => { pending = null; poll(); }, 2_000);
  });
  const retry = () => { clearInterval(ping); console.log("[ws] closed — retry 5s"); setTimeout(connect, 5_000); };
  ws.on("close", retry);
  ws.on("error", (e) => { console.error("[ws] " + e.message); ws.close(); });
}
connect();
