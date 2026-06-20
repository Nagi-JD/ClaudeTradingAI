#!/usr/bin/env node
// PnL dashboard: our paper book (state.json) + leaders live via jup CLI.
const fs=require("fs"),{execSync}=require("child_process");
const S="/root/jup-copy-bot/state/state.json";
const F="/root/jup-copy-bot/data/copy-fills.jsonl";
const s=JSON.parse(fs.readFileSync(S,"utf8"));
const watch=(process.env.COPY_WATCHLIST||"").split(",").filter(Boolean);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const fmt=n=>(n>=0?"+":"")+n.toFixed(2);
(async()=>{
console.log("=== PAPER BOOK ===");
let u=0;
const leaderPos={};
for(const w of watch){
  try{const out=execSync(`jup predictions positions --address ${w} -f json`,{timeout:20000}).toString();
    leaderPos[w]=JSON.parse(out).positions||[];}catch{leaderPos[w]=null}
  await sleep(1500);
}
for(const p of s.paperPositions){
  // live mark from the leader CLI data when we hold the same market
  const lp=(leaderPos[p.openedFromWallet]||[]).find(q=>q.market&&q.event&&q.side===p.side);
  const mark=p.markPriceUsd??p.avgFillPriceUsd;
  const pnl=p.filledContracts*mark-p.netCostUsd;u+=pnl;
  console.log(`OPEN  ${p.marketTitle.padEnd(34)} ${p.side.toUpperCase().padEnd(3)} fill $${p.avgFillPriceUsd.toFixed(2)} mark $${(mark).toFixed(2)} uPnL ${fmt(pnl)} (${fmt(pnl/p.netCostUsd*100)}%)  [${p.openedFromWallet.slice(0,6)}]`);
}
console.log(`\nopen: ${s.paperPositions.length}  uPnL ${fmt(u)} | closed: ${s.closedPositions.length}  rPnL ${fmt(s.realizedPnlUsd)} | TOTAL ${fmt(u+s.realizedPnlUsd)}`);
// lag stats
const fills=fs.readFileSync(F,"utf8").trim().split("\n").map(l=>JSON.parse(l)).filter(f=>f.lagDeltaUsd!=null);
const lags=fills.map(f=>f.lagDeltaUsd*100);
if(lags.length){const avg=lags.reduce((a,b)=>a+b,0)/lags.length;
console.log(`lag: avg ${avg.toFixed(1)}c | worst ${Math.max(...lags).toFixed(1)}c | fills ${lags.length}`)}
console.log("\n=== LEADERS LIVE (via jup CLI) ===");
for(const w of watch){
  const ps=leaderPos[w];
  if(!ps){console.log(`${w.slice(0,8)}… (fetch failed)`);continue}
  const tot=ps.reduce((a,p)=>a+(p.pnlUsd||0),0);
  console.log(`\n${w.slice(0,8)}… — ${ps.length} open, uPnL ${fmt(tot)}`);
  for(const p of ps.slice(0,8))console.log(`  ${(p.event||"").slice(0,40).padEnd(40)} ${p.side.toUpperCase().padEnd(3)} cost $${(p.costUsd||0).toFixed(2)} val $${(p.valueUsd||0).toFixed(2)} ${fmt(p.pnlUsd||0)} (${fmt(p.pnlPct||0)}%)`);
}
})()
