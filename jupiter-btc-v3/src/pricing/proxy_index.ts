// Free, key-less proxy price sources — RESEARCH ONLY.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ NOT SETTLEMENT-GRADE. READ THIS.                                       │
// │                                                                        │
// │ Pyth (Hermes) BTC/USD is the PRIMARY proxy settlement index used ONLY  │
// │ when the true settlement stream (e.g. Chainlink Data Streams) is not   │
// │ wired. Binance spot is an INDEPENDENT cross-check leg for the basis    │
// │ monitor (proxy↔independent gap). Every proxy snapshot is deliberately  │
// │ LOW confidence; the pipeline is EXPECTED to stay mostly NO_TRADE on    │
// │ proxy data. This is for measuring whether an edge/basis exists, NOT    │
// │ for trading.                                                           │
// └──────────────────────────────────────────────────────────────────────┘
//
// Self-contained: owns its OWN rolling tick buffer (no import from the
// settlement adapter) to avoid a circular dependency. Never throws on the hot
// path — any fetch failure degrades to null and the caller blocks.

// Pyth BTC/USD price feed id (mainnet). Override via env if needed.
const PYTH_BTC_FEED_ID =
  process.env.PYTH_BTC_FEED_ID ??
  "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const HERMES_BASE =
  process.env.PYTH_HERMES_BASE ?? "https://hermes.pyth.network";
// Binance data CDN first (rarely geo-blocked), then the main API as fallback.
const BINANCE_BASES = (
  process.env.BINANCE_BASES ??
  "https://data-api.binance.vision,https://api.binance.com"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const FETCH_TIMEOUT_MS = 4000;
const MAX_TICKS = 4000;

export interface ProxyQuote {
  /** Price in USD. */
  price: number;
  /** Pyth confidence interval (USD), when available. */
  confUsd?: number;
  /** OBSERVATION time (ms) — when WE fetched it. Used for staleness. */
  tMs: number;
  /** Upstream publish time (ms), informational (Pyth only). */
  publishMs?: number;
  source: string;
}

let latestPyth: ProxyQuote | null = null;
let latestBinance: ProxyQuote | null = null;

const ticks: { t: number; price: number }[] = [];

function pushTick(price: number, t: number): void {
  if (!Number.isFinite(price) || price <= 0) return;
  ticks.push({ t, price });
  if (ticks.length > MAX_TICKS) ticks.splice(0, ticks.length - MAX_TICKS);
}

/** Rolling proxy BTC tick buffer (oldest → newest) for the vol engine. */
export function getProxyTicks(): { t: number; price: number }[] {
  return ticks.slice();
}

/**
 * Look up the recorded proxy price closest to `tMs` (e.g. a market's window
 * open). Returns null if the buffer does not cover that instant within
 * `toleranceMs` — so a window we never observed at open yields no anchor.
 */
export function getProxyPriceAt(
  tMs: number,
  toleranceMs = 90000,
): { price: number; t: number; ageMs: number } | null {
  if (!Number.isFinite(tMs)) return null;
  let best: { t: number; price: number } | null = null;
  let bestDiff = Infinity;
  for (const tk of ticks) {
    const diff = Math.abs(tk.t - tMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = tk;
    }
  }
  if (!best || bestDiff > toleranceMs) return null;
  return { price: best.price, t: best.t, ageMs: bestDiff };
}

export function getLatestPyth(): ProxyQuote | null {
  return latestPyth;
}

export function getLatestBinance(): ProxyQuote | null {
  return latestBinance;
}

async function getJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res || !res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/** Fetch latest Pyth BTC/USD via Hermes. Records a tick. Null on failure. */
export async function fetchPythBtcUsd(): Promise<ProxyQuote | null> {
  const id = PYTH_BTC_FEED_ID.replace(/^0x/, "");
  const url = `${HERMES_BASE}/v2/updates/price/latest?ids[]=${id}`;
  const j = await getJson(url);
  const parsed = (asRecord(j).parsed as unknown[]) ?? [];
  const p = asRecord(parsed[0]).price;
  const pr = asRecord(p);
  const expo = Number(pr.expo);
  const rawPrice = Number(pr.price);
  const rawConf = Number(pr.conf);
  const publishMs = Number(pr.publish_time) * 1000;
  if (!Number.isFinite(expo) || !Number.isFinite(rawPrice)) return null;
  const scale = Math.pow(10, expo);
  const price = rawPrice * scale;
  if (!(price > 0)) return null;
  const confUsd = Number.isFinite(rawConf) ? rawConf * scale : undefined;
  const nowMs = Date.now();
  const q: ProxyQuote = {
    price,
    confUsd,
    tMs: nowMs,
    publishMs: Number.isFinite(publishMs) ? publishMs : undefined,
    source: "PYTH_HERMES",
  };
  latestPyth = q;
  pushTick(price, nowMs);
  return q;
}

/** Fetch latest Binance BTC/USDT spot (independent basis leg). Null on failure. */
export async function fetchBinanceBtcUsdt(): Promise<ProxyQuote | null> {
  for (const base of BINANCE_BASES) {
    const j = await getJson(`${base}/api/v3/ticker/price?symbol=BTCUSDT`);
    const price = Number(asRecord(j).price);
    if (Number.isFinite(price) && price > 0) {
      const q: ProxyQuote = {
        price,
        tMs: Date.now(),
        source: `BINANCE:${base.replace(/^https?:\/\//, "")}`,
      };
      latestBinance = q;
      return q;
    }
  }
  return null;
}

let pythTimer: ReturnType<typeof setInterval> | null = null;
let binanceTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start background pollers. Pyth at ~1s (drives vol RV windows), Binance at ~3s
 * (basis cross-check). Idempotent. Timers are unref'd so they never keep an
 * otherwise-idle process alive on their own.
 */
export function startProxyPollers(opts?: {
  pythIntervalMs?: number;
  binanceIntervalMs?: number;
}): void {
  const pythMs = Math.max(
    500,
    opts?.pythIntervalMs ?? Number(process.env.PYTH_POLL_MS ?? 1000),
  );
  const binMs = Math.max(
    1000,
    opts?.binanceIntervalMs ?? Number(process.env.BINANCE_POLL_MS ?? 3000),
  );
  if (!pythTimer) {
    void fetchPythBtcUsd();
    pythTimer = setInterval(() => {
      void fetchPythBtcUsd();
    }, pythMs);
    if (typeof (pythTimer as { unref?: () => void }).unref === "function") {
      (pythTimer as { unref: () => void }).unref();
    }
  }
  if (!binanceTimer) {
    void fetchBinanceBtcUsdt();
    binanceTimer = setInterval(() => {
      void fetchBinanceBtcUsdt();
    }, binMs);
    if (typeof (binanceTimer as { unref?: () => void }).unref === "function") {
      (binanceTimer as { unref: () => void }).unref();
    }
  }
}

export function stopProxyPollers(): void {
  if (pythTimer) {
    clearInterval(pythTimer);
    pythTimer = null;
  }
  if (binanceTimer) {
    clearInterval(binanceTimer);
    binanceTimer = null;
  }
}
