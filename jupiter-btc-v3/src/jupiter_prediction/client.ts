// Jupiter Prediction API client.
//
// BETA API → every GET parses defensively with zod and FAILS SAFE: on schema
// drift, transport error, or non-2xx status we still return { raw, ok:false,
// status } and never throw in a hot path.
//
// HARD SAFETY: this client NEVER signs, NEVER requires a private key, and
// NEVER sends a real order. `createOrder` ALWAYS throws unless the constructor
// was given liveTradingPermitted===true (false in this build). `createOrderDryRun`
// only echoes the request back as a simulation; it performs no network write.

import { z } from "zod";

export interface JupiterClientOpts {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
  liveTradingPermitted: boolean;
  /** Min ms between outbound requests (gateway is ~1 RPS/key). Default 1100. */
  minIntervalMs?: number;
}

export interface GetResult {
  raw: unknown;
  ok: boolean;
  status: number;
  data?: any;
}

export interface DryRunResult {
  raw: unknown;
  simulated: true;
}

// A permissive envelope: the BETA API may wrap payloads in {data}, {result},
// or return bare arrays/objects. We never reject on shape — we just record ok.
const LooseEnvelope = z.union([
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
  z.null(),
]);

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, Math.max(0, ms)));
}

export class JupiterPredictionClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly liveTradingPermitted: boolean;
  private readonly minIntervalMs: number;
  /** Monotonic next-allowed request time; serializes spacing across calls. */
  private nextSlot = 0;

  constructor(opts: JupiterClientOpts) {
    // Trim a single trailing slash so path-joining is predictable.
    this.baseUrl = (opts.baseUrl ?? "").replace(/\/+$/, "");
    this.apiKey = opts.apiKey ?? "";
    this.timeoutMs =
      Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
        ? opts.timeoutMs
        : 3000;
    this.maxRetries =
      Number.isFinite(opts.maxRetries) && opts.maxRetries >= 0
        ? Math.floor(opts.maxRetries)
        : 3;
    this.liveTradingPermitted = opts.liveTradingPermitted === true;
    const envMin = Number(process.env.JUP_MIN_INTERVAL_MS);
    this.minIntervalMs =
      Number.isFinite(opts.minIntervalMs) && (opts.minIntervalMs as number) >= 0
        ? (opts.minIntervalMs as number)
        : Number.isFinite(envMin) && envMin >= 0
          ? envMin
          : 1100;
  }

  // Self-throttle: serialize requests at least minIntervalMs apart so we stay
  // under the gateway's ~1 RPS/key limit even when discovery + strategy fan out.
  private async throttle(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + this.minIntervalMs;
    if (wait > 0) await sleep(wait);
  }

  // ───────────────────────────────────────────────────────── GET methods ──

  getTradingStatus(): Promise<GetResult> {
    return this.get("/trading-status");
  }

  getEvents(params?: Record<string, any>): Promise<GetResult> {
    return this.get("/events", params);
  }

  searchEvents(query: string): Promise<GetResult> {
    return this.get("/events/search", { query });
  }

  getEvent(eventId: string): Promise<GetResult> {
    return this.get(`/events/${encodeURIComponent(String(eventId ?? ""))}`);
  }

  getMarketDetails(eventId: string, marketId: string): Promise<GetResult> {
    // Real API: GET /markets/{marketId}. eventId retained for signature compat.
    void eventId;
    return this.get(`/markets/${encodeURIComponent(String(marketId ?? ""))}`);
  }

  getOrderbook(marketId: string): Promise<GetResult> {
    // Real API: GET /orderbook/{marketId}.
    return this.get(`/orderbook/${encodeURIComponent(String(marketId ?? ""))}`);
  }

  getTrades(params?: Record<string, any>): Promise<GetResult> {
    return this.get("/trades", params);
  }

  getLeaderboards(params?: Record<string, any>): Promise<GetResult> {
    return this.get("/leaderboards", params);
  }

  getPositions(ownerPubkey: string): Promise<GetResult> {
    return this.get("/positions", { owner: ownerPubkey });
  }

  getOrders(params?: Record<string, any>): Promise<GetResult> {
    return this.get("/orders", params);
  }

  getOrderStatus(orderPubkey: string): Promise<GetResult> {
    return this.get(
      `/orders/${encodeURIComponent(String(orderPubkey ?? ""))}`,
    );
  }

  // ──────────────────────────────────────────────────────── order paths ──

  /**
   * Simulates an order. Performs NO network write — it merely echoes the
   * request back tagged as simulated. Never throws in normal operation.
   */
  async createOrderDryRun(orderRequest: unknown): Promise<DryRunResult> {
    return { raw: orderRequest, simulated: true };
  }

  /**
   * HARD SAFETY GATE. This build never permits live trading, so this method
   * ALWAYS throws. Even if liveTradingPermitted were somehow true, this
   * client deliberately refuses to construct/sign/send a real order — that is
   * out of scope for the research system.
   */
  async createOrder(_orderRequest: unknown): Promise<never> {
    if (!this.liveTradingPermitted) {
      throw new Error(
        "createOrder blocked: live trading is not permitted (liveTradingPermitted=false). " +
          "This research build never sends real orders. Use createOrderDryRun instead.",
      );
    }
    throw new Error(
      "createOrder blocked: live order submission is intentionally unimplemented in this research build. " +
        "No order was signed or sent.",
    );
  }

  // ─────────────────────────────────────────────────────────── internals ──

  private buildUrl(path: string, params?: Record<string, any>): string {
    const p = path.startsWith("/") ? path : `/${path}`;
    let url = `${this.baseUrl}${p}`;
    if (params && typeof params === "object") {
      const search = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) {
          for (const item of v) {
            if (item === undefined || item === null) continue;
            search.append(k, String(item));
          }
        } else {
          search.append(k, String(v));
        }
      }
      const qs = search.toString();
      if (qs) url += `?${qs}`;
    }
    return url;
  }

  private backoffMs(attempt: number, retryAfterHeader?: string | null): number {
    // Honor Retry-After when present (seconds or HTTP date-ish numeric).
    if (retryAfterHeader) {
      const secs = Number(retryAfterHeader);
      if (Number.isFinite(secs) && secs >= 0) {
        return Math.min(secs * 1000, 30_000);
      }
    }
    // Exponential backoff with jitter, capped.
    const base = 250 * Math.pow(2, attempt);
    const jitter = Math.random() * 100;
    return Math.min(base + jitter, 10_000);
  }

  private async get(
    path: string,
    params?: Record<string, any>,
  ): Promise<GetResult> {
    const url = this.buildUrl(path, params);
    let lastStatus = 0;
    let lastRaw: unknown = undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        await this.throttle();
        const res = await fetch(url, {
          method: "GET",
          headers: {
            "x-api-key": this.apiKey,
            accept: "application/json",
          },
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        lastStatus = res.status;
        const text = await res.text();
        lastRaw = this.tryParseJson(text);

        if (res.status === 429 || RETRYABLE_STATUS.has(res.status)) {
          if (attempt < this.maxRetries) {
            await sleep(
              this.backoffMs(attempt, res.headers.get("retry-after")),
            );
            continue;
          }
          // Out of retries → fail safe.
          return { raw: lastRaw, ok: false, status: res.status };
        }

        if (!res.ok) {
          // Non-retryable error status → fail safe, preserve raw.
          return { raw: lastRaw, ok: false, status: res.status };
        }

        // Success status. Validate shape defensively; on drift keep raw, ok:false.
        const parsed = LooseEnvelope.safeParse(lastRaw);
        if (!parsed.success) {
          return { raw: lastRaw, ok: false, status: res.status };
        }
        return {
          raw: lastRaw,
          ok: true,
          status: res.status,
          data: this.unwrap(lastRaw),
        };
      } catch (err) {
        // Network error / timeout / abort. Retry if budget remains.
        lastRaw = { error: errMessage(err) };
        lastStatus = 0;
        if (attempt < this.maxRetries) {
          await sleep(this.backoffMs(attempt));
          continue;
        }
        return { raw: lastRaw, ok: false, status: lastStatus };
      }
    }

    // Exhausted loop without returning (shouldn't happen) → fail safe.
    return { raw: lastRaw, ok: false, status: lastStatus };
  }

  private tryParseJson(text: string): unknown {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      // Not JSON — return the raw text so callers can still inspect it.
      return text;
    }
  }

  // Unwrap the common BETA envelopes into the useful payload, but always keep
  // raw on the result so nothing is lost.
  private unwrap(raw: unknown): any {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const obj = raw as Record<string, unknown>;
      if ("data" in obj && obj.data !== undefined) return obj.data;
      if ("result" in obj && obj.result !== undefined) return obj.result;
      if ("events" in obj && obj.events !== undefined) return obj.events;
      if ("markets" in obj && obj.markets !== undefined) return obj.markets;
    }
    return raw;
  }
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  try {
    return String(err);
  } catch {
    return "unknown error";
  }
}
