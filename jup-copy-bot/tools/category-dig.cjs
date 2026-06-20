// Per-category wallet mining: classify every feed trade by market category,
// rank owners per category, profile the top unknowns.
const fs = require("fs");
const KEY = fs.readFileSync("/root/jup-copy-bot/.env", "utf8").match(/JUP_API_KEY=(.+)/)[1].trim();
const watch = new Set(fs.readFileSync("/root/jup-copy-bot/.env", "utf8").match(/COPY_WATCHLIST=(.+)/)[1].split(","));
const rejected = new Set(JSON.parse(fs.readFileSync("/root/rejected.json", "utf8")));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CATS = [
  ["TENNIS", /Roland Garros|ATP|WTA|Championships, Qualif|Open, Qualification|Libema|Prostejov|Heilbronn|Stuttgart Open|HSBC/i],
  ["UFC/MMA", /UFC|Fight Night|MMA/i],
  ["NBA", /Knicks|Spurs|Thunder|Lakers|Celtics|Pacers|NBA/i],
  ["MLB", /Orioles|Yankees|Mets|Dodgers|Guardians|Padres|Red Sox|Cubs|Giants vs|Rangers|Blue Jays|MLB/i],
  ["NHL", /Hurricanes|Golden Knights|Stanley Cup|Oilers|Panthers|NHL/i],
  ["FOOT/SOCCER", /FIFA|World Cup|UEFA|Champions League|vs\. (FC|Real|Barcelona)|Premier League|Ligue 1|Bundesliga|Brazil vs|Korea Republic/i],
  ["ESPORT", /LoL:|CS2|Counter-Strike|Dota|Valorant|esports|BO[135]/i],
  ["POLITIQUE", /Election|President|Senate|Fed |Mayor|Minister|Parliament/i],
  ["CRYPTO-LT", /above ___|all time high|What price will|hit in 2026|ATH/i],
];
function cat(title) {
  if (/Up or Down/i.test(title)) return null; // binaries excluded
  for (const [name, re] of CATS) if (re.test(title)) return name;
  return "AUTRE";
}
const lines = fs.readFileSync("/root/jup-copy-bot/data/trades.jsonl", "utf8").trim().split("\n");
const byCat = {};
for (const l of lines) {
  let t; try { t = JSON.parse(l); } catch { continue; }
  const c = cat(t.eventTitle || "");
  if (!c) continue;
  const o = t.owner;
  if (watch.has(o)) continue;
  const m = (byCat[c] ??= {});
  const s = (m[o] ??= { n: 0, usd: 0 });
  s.n++; s.usd += Number(t.amountUsd) / 1e6;
}
(async () => {
  for (const [c, owners] of Object.entries(byCat)) {
    const top = Object.entries(owners)
      .map(([o, s]) => ({ o, ...s }))
      .filter((s) => s.usd >= 50)
      .sort((a, b) => b.usd - a.usd)
      .slice(0, 6);
    console.log(`\n##CAT ${c} — ${Object.keys(owners).length} wallets, top ${top.length}:`);
    for (const w of top) {
      const flag = rejected.has(w.o) ? " [rejete]" : "";
      let prof = "";
      if (!flag) {
        for (let a = 0; a < 3; a++) {
          try {
            const r = await fetch("https://api.jup.ag/prediction/v1/profiles/" + w.o, { headers: { "x-api-key": KEY } });
            const p = await r.json();
            if (p.code === 429) { await sleep(8000); continue; }
            prof = `pnl=$${((p.realizedPnlUsd || 0) / 1e6).toFixed(0)} n=${p.predictionsCount || 0} wr=${p.predictionsCount ? ((100 * p.correctPredictions) / p.predictionsCount).toFixed(0) : 0}%`;
            break;
          } catch { await sleep(4000); }
        }
        await sleep(1600);
      }
      console.log(`${w.o} feed=$${w.usd.toFixed(0)}/${w.n}t ${prof}${flag}`);
    }
  }
  console.log("\nDONE-CATDIG");
})();
