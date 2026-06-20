import { microToUsd } from "./money.js";
import type {
  Trade,
  Orderbook,
  Market,
  ProfilePnlPoint,
  LeaderboardEntry,
  ProfileStats,
} from "./types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// exponential backoff with jitter: ~0.4s, 0.8s, 1.6s, 3.2s …
const backoff = (attempt: number) => Math.round((400 * 2 ** attempt) * (0.7 + Math.random() * 0.6));

export interface JupiterClientOpts {
  apiBase: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Floor spacing between requests to avoid microbursts (default 150ms). */
  minRequestGapMs?: number;
}

export interface ApiStats {
  ok: number;
  http4xx: number;
  http5xx: number; // incl. 429 rate-limits
  network: number; // fetch threw / timeout / DNS
}

export interface RateState {
  remaining: number; // tokens left in the current window (from x-ratelimit-remaining)
  resetAtMs: number; // epoch ms when the window resets (from x-ratelimit-reset)
  lastSentMs: number; // when we last dispatched a request
  minGapMs: number; // floor spacing between requests
}

/**
 * How long to wait before dispatching the next request. Pure so it's testable:
 * obey the server's bucket (wait until reset when exhausted) AND a floor gap to
 * avoid microbursts; take whichever is longer.
 */
export function rateLimitDelayMs(s: RateState, nowMs: number): number {
  const bucketWait = s.remaining <= 0 && nowMs < s.resetAtMs ? s.resetAtMs - nowMs : 0;
  const gapWait = s.minGapMs - (nowMs - s.lastSentMs);
  return Math.max(bucketWait, gapWait, 0);
}

export class JupiterClient {
  private base: string;
  private key: string;
  private f: typeof fetch;
  // Per-attempt outcome counters so we can SEE whether the API is healthy or
  // silently failing (every swallowed error otherwise looks like "no signal").
  private stats: ApiStats = { ok: 0, http4xx: 0, http5xx: 0, network: 0 };
  // Header-adaptive rate limiter: serialize requests through one lane and pace
  // them by the server's own x-ratelimit-* headers (shared 60s sliding-window
  // bucket, per-account). Self-tunes to whatever plan tier the key is on.
  private rate: RateState;
  private lane: Promise<void> = Promise.resolve();

  constructor(opts: JupiterClientOpts) {
    this.base = opts.apiBase.replace(/\/$/, "");
    this.key = opts.apiKey;
    this.f = opts.fetchImpl ?? fetch;
    this.rate = {
      remaining: Number.POSITIVE_INFINITY,
      resetAtMs: 0,
      lastSentMs: 0,
      minGapMs: opts.minRequestGapMs ?? 150,
    };
  }

  /** Serialize + pace: wait our turn, then honor the bucket/min-gap before sending. */
  private async acquire(): Promise<() => void> {
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const prev = this.lane;
    this.lane = prev.then(() => mine);
    await prev;
    const delay = rateLimitDelayMs(this.rate, Date.now());
    if (delay > 0) await sleep(delay);
    this.rate.lastSentMs = Date.now();
    return release;
  }

  /** Update the bucket view from response headers (x-ratelimit-remaining/reset). */
  private observeHeaders(res: Response): void {
    const rem = Number(res.headers?.get?.("x-ratelimit-remaining"));
    const reset = Number(res.headers?.get?.("x-ratelimit-reset"));
    if (Number.isFinite(rem)) this.rate.remaining = rem;
    if (Number.isFinite(reset) && reset > 0) this.rate.resetAtMs = reset * 1000; // header is unix seconds
  }

  /** Snapshot and reset the API outcome counters (call once per cycle to log). */
  drainStats(): ApiStats {
    const s = { ...this.stats };
    this.stats = { ok: 0, http4xx: 0, http5xx: 0, network: 0 };
    return s;
  }

  private async get<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
    const url = new URL(this.base + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
      }
    }
    const MAX_ATTEMPTS = 5;
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const release = await this.acquire();
      try {
        const res = await this.f(url.toString(), {
          headers: { "x-api-key": this.key, accept: "application/json" },
        });
        this.observeHeaders(res);
        // 429 (rate limit) and 5xx are retryable; honor Retry-After when given.
        if (res.status === 429 || res.status >= 500) {
          this.stats.http5xx++;
          if (res.status === 429) this.rate.remaining = 0; // hard stop until reset
          const ra = Number(res.headers?.get?.("retry-after"));
          const waitMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff(attempt);
          release();
          await sleep(waitMs);
          throw new Error(`HTTP ${res.status}`);
        }
        if (!res.ok) { this.stats.http4xx++; release(); throw new Error(`HTTP ${res.status} on ${path}`); }
        const json = (await res.json()) as T;
        this.stats.ok++;
        release();
        return json;
      } catch (e) {
        release();
        lastErr = e;
        // count genuine network/transport failures (our own HTTP errors are
        // already tallied above and re-thrown with an "HTTP ..." message)
        if (!(e instanceof Error && e.message.startsWith("HTTP"))) this.stats.network++;
        if (attempt < MAX_ATTEMPTS - 1) await sleep(backoff(attempt));
      }
    }
    throw lastErr;
  }

  /** Recent global order_filled feed. */
  async getTrades(): Promise<Trade[]> {
    const r = await this.get<{ data: Trade[] }>("/trades");
    return r.data ?? [];
  }

  async getOrderbook(marketId: string): Promise<Orderbook> {
    const raw = await this.get<Orderbook>(`/orderbook/${marketId}`);
    return normalizeOrderbookToDollars(raw);
  }

  /** Full market object incl. status/result/closeTime. */
  async getMarket(marketId: string): Promise<Market> {
    return this.get<Market>(`/markets/${marketId}`);
  }

  /** Event metadata (isLive/beginAt/subcategory) — powers the live block filter. */
  async getEvent(eventId: string): Promise<any> {
    return this.get<any>(`/events/${eventId}`);
  }

  /** True only if the market is live and tradeable (open, unresolved, not past close). */
  async isMarketOpen(marketId: string): Promise<boolean> {
    return isOpenForTrading(await this.getMarket(marketId));
  }

  /** A wallet's current open positions (raw). Powers leader position-diff copying. */
  async getPositionsRaw(ownerPubkey: string): Promise<any[]> {
    const r = await this.get<{ data: any[] }>("/positions", { ownerPubkey });
    return r.data ?? [];
  }

  /** 7-day realized P&L in USD for a wallet (cumulative-now minus cumulative-7d-ago). */
  async getWeeklyPnlUsd(ownerPubkey: string): Promise<number> {
    const r = await this.get<{ history: ProfilePnlPoint[] }>(
      `/profiles/${ownerPubkey}/pnl-history`,
      { interval: "1w", count: 1000 }
    );
    return weeklyPnlFromHistory(r.history ?? []);
  }

  /** Resolved (post-settlement) profile stats for a wallet. */
  async getProfile(ownerPubkey: string): Promise<ProfileStats> {
    const p = await this.get<{
      realizedPnlUsd: string;
      totalVolumeUsd: string;
      correctPredictions: string;
      wrongPredictions: string;
    }>(`/profiles/${ownerPubkey}`);
    return {
      allTimePnlUsd: microToUsd(p.realizedPnlUsd ?? 0),
      volumeUsd: microToUsd(p.totalVolumeUsd ?? 0),
      correct: Number(p.correctPredictions ?? 0),
      wrong: Number(p.wrongPredictions ?? 0),
    };
  }

  async getLeaderboard(
    metric: "pnl" | "volume" | "win_rate" = "pnl",
    period: "all_time" | "weekly" | "monthly" = "weekly",
    limit = 100
  ): Promise<LeaderboardEntry[]> {
    const r = await this.get<{ data: LeaderboardEntry[] }>("/leaderboards", { metric, period, limit });
    return r.data ?? [];
  }
}

/**
 * Compute true 7-day realized P&L (USD) from a pnl-history series.
 *
 * The API returns a CUMULATIVE all-time realized-P&L curve in micro-USD (the
 * newest point equals the wallet's all-time realizedPnlUsd), sampled at
 * irregular timestamps, newest-first. The weekly figure is therefore
 * (cumulative now) - (cumulative as of ~7 days ago) — NOT a single absolute
 * point. The old code took hist[last] (the OLDEST sample) and treated that
 * absolute level as "weekly", which is dimensionally wrong.
 */
export function weeklyPnlFromHistory(history: ProfilePnlPoint[]): number {
  if (history.length < 2) return 0; // need two points to form a delta
  const pts = history
    .map((p) => ({ t: p.timestamp, v: Number(p.realizedPnlUsd) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
    .sort((a, b) => a.t - b.t);
  if (pts.length < 2) return 0;
  const newest = pts[pts.length - 1];
  const cutoff = newest.t - 7 * 86400;
  // Cumulative level as of ~7d ago: latest sample at/before the cutoff,
  // else the earliest sample we have (history shorter than a week).
  let baseline = pts[0];
  for (let i = pts.length - 1; i >= 0; i--) {
    if (pts[i].t <= cutoff) { baseline = pts[i]; break; }
  }
  return microToUsd(newest.v - baseline.v);
}

/**
 * A market is tradeable only when actively open, not yet resolved, and still
 * within its trading window. Copying into closed/resolved markets is where the
 * "$1.00 winning-side" fills came from — there's no edge buying a decided market.
 */
export function isOpenForTrading(m: Market): boolean {
  const resolved = m.result != null && m.result !== "";
  const nowSec = Date.now() / 1000;
  const pastClose = typeof m.closeTime === "number" && m.closeTime > 0 && m.closeTime <= nowSec;
  return m.status === "open" && !resolved && !pastClose;
}

/**
 * Jupiter delivers each book in two price scales:
 *   yes / no            -> integer CENTS   ([1, qty] === $0.01)
 *   yes_dollars / no_*  -> dollar strings  (["0.0100", qty])
 * The rest of the bot reasons in USD, so collapse both ladders to dollars,
 * preferring the authoritative *_dollars strings and falling back to cents/100.
 * Without this, a real $0.01 ask reads as $1.00 (100x) — every fill looks like
 * capped-upside garbage and the price-band guard rejects everything.
 */
export function normalizeOrderbookToDollars(raw: Orderbook): Orderbook {
  const toDollars = (
    dollars: [number | string, number][] | undefined,
    cents: [number, number][] | undefined
  ): [number, number][] => {
    if (dollars && dollars.length) return dollars.map(([p, q]) => [Number(p), q]);
    if (cents && cents.length) return cents.map(([p, q]) => [p / 100, q]);
    return [];
  };
  return {
    yes: toDollars(raw.yes_dollars, raw.yes),
    no: toDollars(raw.no_dollars, raw.no),
    yes_dollars: raw.yes_dollars,
    no_dollars: raw.no_dollars,
  };
}
