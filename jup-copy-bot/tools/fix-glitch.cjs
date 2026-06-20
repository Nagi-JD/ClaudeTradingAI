// Surgical state repair after the 2026-06-07 18:45 API-glitch incident.
// - Revert the 6 fake closes (keep Walton: real resolution at $0.999).
// - Delete the 6 fake re-buys opened 18:46 (incl. $0.001 fills on closed markets
//   and Ahef's pre-watch Colombia position).
// - Close 8jqF's leftover Cobolli add at his real $0.81 exit (he sold ALL).
const fs = require("fs");
const F = "/root/jup-copy-bot/state/state.json";
const s = JSON.parse(fs.readFileSync(F, "utf8"));
const inWin = (t, a, b) => t >= a && t <= b;
// Glitch windows (UTC ms) — from the audit.
const closeA = Date.parse("2026-06-07T18:45:25Z"), closeB = Date.parse("2026-06-07T18:45:35Z");
const buyA = Date.parse("2026-06-07T18:46:25Z"), buyB = Date.parse("2026-06-07T18:46:50Z");

const keepClosed = [], reopen = [];
for (const p of s.closedPositions) {
  const fake = inWin(p.closedAt || 0, closeA, closeB) && !/Tyler: Adam Walton/.test(p.marketTitle);
  if (fake) {
    const { resolved, closedAt, realizedPnlUsd, outcome, markPriceUsd, valueUsd, unrealizedPnlUsd, ...rest } = p;
    reopen.push(rest);
  } else keepClosed.push(p);
}
console.log("fake closes reverted:", reopen.length, "| kept closed:", keepClosed.length);

const keptOpen = s.paperPositions.filter((p) => !inWin(p.openedAt || 0, buyA, buyB));
console.log("fake re-buys deleted:", s.paperPositions.length - keptOpen.length);

s.closedPositions = keepClosed;
s.paperPositions = [...keptOpen, ...reopen];

// 8jqF sold his entire Cobolli stack at $0.81 — close our leftover add.
const i = s.paperPositions.findIndex((p) => p.openedFromWallet.startsWith("8jqFQX") && p.marketId === "POLY-2447621-1");
if (i >= 0) {
  const p = s.paperPositions.splice(i, 1)[0];
  const realized = p.filledContracts * 0.81 - p.netCostUsd;
  s.closedPositions.push({ ...p, resolved: true, closedAt: Date.now(), markPriceUsd: 0.81, realizedPnlUsd: +realized.toFixed(2), outcome: realized >= 0 ? "win" : "loss", note: "closed at leader real exit 0.81 (second lot)" });
  console.log("8jqF cobolli add closed at 0.81:", realized.toFixed(2));
}

s.realizedPnlUsd = s.closedPositions.reduce((a, p) => a + (p.realizedPnlUsd || 0), 0);
fs.writeFileSync(F, JSON.stringify(s, null, 2));
console.log("FINAL open:", s.paperPositions.length, "closed:", s.closedPositions.length, "rPnL:", s.realizedPnlUsd.toFixed(2));
for (const p of s.paperPositions) console.log("  OPEN", p.marketTitle.slice(0, 34), p.openedFromWallet.slice(0, 6), "$" + p.avgFillPriceUsd.toFixed(3));
