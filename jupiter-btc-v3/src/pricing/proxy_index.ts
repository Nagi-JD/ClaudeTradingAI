// Free, key-less MULTI-SOURCE proxy price layer — RESEARCH ONLY.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ NOT SETTLEMENT-GRADE — BUT BETTER THAN ONE SOURCE.                     │
// │                                                                        │
// │ Chainlink Data Stream (the actual Jupiter BTC settlement) is itself a  │
// │ volume-weighted aggregate of major CEXs. So a MEDIAN of the same       │
// │ venues (Pyth + Binance + Coinbase + Kraken) reproduces Chainlink's     │
// │ METHODOLOGY, not "the true price" — shrinking the single-source bias   │
// │ (Pyth-alone sat ~10bps off).                                           │
// │                                                                        │
// │ Two distinct uncertainties, NEVER conflated:                          │
// │  (1) inter-source DISPERSION — how well our sources agree (= is our    │
// │      MEASUREMENT good). Tight agreement lets confidence leave the 0.3  │
// │      floor. This is an OUTPUT we measure, not an assumption.           │
// │  (2) residual-to-Chainlink — our consensus ≠ the Data Stream value at  │
// │      the sub-second settlement tick. This is NOT observable here; it   │
// │      dominates near the strike and must CAP confidence there. Source   │
// │      agreement does NOT prove we match Chainlink at settlement.        │
// └──────────────────────────────────────────────────────────────────────┘
//
// Self-contained, fail-safe (any source can drop), never throws on hot path.

const PYTH_BTC_FEED_ID =
  process.env.PYTH_BTC_FEED_ID ??
  "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const HERMES_BASE = process.env.PYTH_HERMES_BASE ?? "https://hermes.pyth.network";
const BINANCE_BASES = (process.env.BINANCE_BASES ??
  "https://data-api.binance.vision,https://api.binance.com")
  .split(",").map((s) => s.trim()).filter(Boolean);
const COINBASE_BASE = process.env.COINBASE_BASE ?? "https://api.exchange.coinbase.com";
const KRAKEN_BASE = process.env.KRAKEN_BASE ?? "https://api.kraken.com";

const FETCH_TIMEOUT_MS = 4000;
const MAX_TICKS = 4000;

export interface SourceQuote { source: string; price: number; tMs: number; unit: "USD" | "USDT"; }
export interface ConsensusQuote {
  /** median across the USD sources — the proxy index value (settlement is USD) */
  median: number;
  /** ALL sources fetched (incl. the USDT reference), for visibility */
  sources: SourceQuote[];
  /** count of USD sources that formed the median */
  nSources: number;
  /** MEASURED dispersion across USD sources (bps): (max-min)/median*1e4. Uncertainty (1). */
  dispersionBps: number;
  /** per-USD-source offset from the median (bps) */
  offsetsBps: Record<string, number>;
  /** Binance BTC/USDT offset from the USD median (bps) — the USDT basis, MONITORED not used */
  usdtBasisBps: number | null;
  tMs: number;
}

let latestConsensus: ConsensusQuote | null = null;
const ticks: { t: number; price: number }[] = [];

function pushTick(price: number, t: number): void {
  if (!Number.isFinite(price) || price <= 0) return;
  ticks.push({ t, price });
  if (ticks.length > MAX_TICKS) ticks.splice(0, ticks.length - MAX_TICKS);
}

export function getProxyTicks(): { t: number; price: number }[] { return ticks.slice(); }
export function getProxyPriceAt(tMs: number, toleranceMs = 90000): { price: number; t: number; ageMs: number } | null {
  if (!Number.isFinite(tMs)) return null;
  let best: { t: number; price: number } | null = null; let bestDiff = Infinity;
  for (const tk of ticks) { const d = Math.abs(tk.t - tMs); if (d < bestDiff) { bestDiff = d; best = tk; } }
  if (!best || bestDiff > toleranceMs) return null;
  return { price: best.price, t: best.t, ageMs: bestDiff };
}
export function getLatestConsensus(): ConsensusQuote | null { return latestConsensus; }
// Back-compat: settlement adapter still imports getLatestPyth — derive from consensus.
export function getLatestPyth(): { price: number; confUsd?: number; tMs: number; source: string } | null {
  if (!latestConsensus) return null;
  return { price: latestConsensus.median, tMs: latestConsensus.tMs, source: "MULTI_SOURCE_MEDIAN" };
}
export function getLatestBinance(): SourceQuote | null {
  return latestConsensus?.sources.find((s) => s.source.startsWith("BINANCE")) ?? null;
}

async function getJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res || !res.ok) return null;
    return await res.json();
  } catch { return null; }
}
function asRecord(v: unknown): Record<string, unknown> { return v && typeof v === "object" ? (v as Record<string, unknown>) : {}; }

async function srcPyth(): Promise<SourceQuote | null> {
  const id = PYTH_BTC_FEED_ID.replace(/^0x/, "");
  const j = await getJson(`${HERMES_BASE}/v2/updates/price/latest?ids[]=${id}`);
  const p = asRecord(asRecord((asRecord(j).parsed as unknown[])?.[0]).price);
  const expo = Number(p.expo), raw = Number(p.price);
  if (!Number.isFinite(expo) || !Number.isFinite(raw)) return null;
  const price = raw * Math.pow(10, expo);
  return price > 0 ? { source: "PYTH", price, tMs: Date.now(), unit: "USD" } : null;
}
async function srcBinance(): Promise<SourceQuote | null> {
  for (const base of BINANCE_BASES) {
    const j = await getJson(`${base}/api/v3/ticker/price?symbol=BTCUSDT`);
    const price = Number(asRecord(j).price);
    // Binance spot is BTC/USDT — a USDT proxy, NOT USD. Measured ~+11bps rich vs
    // the USD cluster (the USDT basis). Kept for monitoring, NOT in the median.
    if (Number.isFinite(price) && price > 0) return { source: `BINANCE`, price, tMs: Date.now(), unit: "USDT" };
  }
  return null;
}
async function srcCoinbase(): Promise<SourceQuote | null> {
  const j = await getJson(`${COINBASE_BASE}/products/BTC-USD/ticker`);
  const price = Number(asRecord(j).price);
  return Number.isFinite(price) && price > 0 ? { source: "COINBASE", price, tMs: Date.now(), unit: "USD" } : null;
}
async function srcKraken(): Promise<SourceQuote | null> {
  const j = await getJson(`${KRAKEN_BASE}/0/public/Ticker?pair=XBTUSD`);
  const result = asRecord(asRecord(j).result);
  const pair = Object.values(result)[0];
  const c = (asRecord(pair).c as unknown[]) ?? [];
  const price = Number(c[0]);
  return Number.isFinite(price) && price > 0 ? { source: "KRAKEN", price, tMs: Date.now(), unit: "USD" } : null;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b); const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/**
 * Fetch all sources in parallel; the consensus median is over the USD sources
 * ONLY (Jupiter BTC settles in USD via Chainlink). Binance BTC/USDT is fetched
 * but excluded from the median — kept as a monitored USDT-basis reference.
 * dispersionBps measures the USD sources' agreement = uncertainty (1).
 */
export async function fetchConsensus(): Promise<ConsensusQuote | null> {
  const settled = await Promise.allSettled([srcPyth(), srcBinance(), srcCoinbase(), srcKraken()]);
  const all: SourceQuote[] = [];
  for (const r of settled) if (r.status === "fulfilled" && r.value) all.push(r.value);
  const usd = all.filter((s) => s.unit === "USD");
  if (usd.length < 2) return null; // need >=2 USD sources to cross-validate
  const prices = usd.map((s) => s.price);
  const med = median(prices);
  const dispersionBps = med > 0 ? ((Math.max(...prices) - Math.min(...prices)) / med) * 10000 : 0;
  const offsetsBps: Record<string, number> = {};
  for (const s of usd) offsetsBps[s.source] = med > 0 ? ((s.price - med) / med) * 10000 : 0;
  const usdt = all.find((s) => s.unit === "USDT");
  const usdtBasisBps = usdt && med > 0 ? ((usdt.price - med) / med) * 10000 : null;
  const now = Date.now();
  const q: ConsensusQuote = { median: med, sources: all, nSources: usd.length, dispersionBps, offsetsBps, usdtBasisBps, tMs: now };
  latestConsensus = q;
  pushTick(med, now);
  return q;
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startProxyPollers(opts?: { intervalMs?: number }): void {
  const ms = Math.max(500, opts?.intervalMs ?? Number(process.env.PROXY_POLL_MS ?? 1000));
  if (timer) return;
  void fetchConsensus();
  timer = setInterval(() => { void fetchConsensus(); }, ms);
  if (typeof (timer as { unref?: () => void }).unref === "function") (timer as { unref: () => void }).unref();
}
export function stopProxyPollers(): void { if (timer) { clearInterval(timer); timer = null; } }
