import { describe, it, expect, vi, afterEach } from "vitest";
import { JupiterPredictionClient } from "../src/jupiter_prediction/client";
import { loadConfig } from "../src/config/load_config";

const realFetch = globalThis.fetch;

function okResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("JupiterPredictionClient", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("sends the x-api-key header on GET requests", async () => {
    const fetchSpy = vi.fn(async () => okResponse({ data: [] }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const client = new JupiterPredictionClient({
      baseUrl: "https://example.test/v1",
      apiKey: "SECRET-KEY-123",
      timeoutMs: 1000,
      maxRetries: 0,
      liveTradingPermitted: false,
    });

    const res = await client.getEvents();
    expect(res.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const call = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const init = call[1];
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("SECRET-KEY-123");
  });

  it("fails safe (ok:false, no throw) on schema drift / junk payload", async () => {
    // A bare number is not a valid LooseEnvelope -> ok:false, raw preserved.
    globalThis.fetch = vi.fn(async () =>
      okResponse(12345),
    ) as unknown as typeof fetch;

    const client = new JupiterPredictionClient({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      timeoutMs: 1000,
      maxRetries: 0,
      liveTradingPermitted: false,
    });

    const res = await client.getEvents();
    expect(res.ok).toBe(false);
    expect(res.raw).toBe(12345);
  });

  it("fails safe on transport error without throwing", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const client = new JupiterPredictionClient({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      timeoutMs: 1000,
      maxRetries: 0,
      liveTradingPermitted: false,
    });

    const res = await client.getTradingStatus();
    expect(res.ok).toBe(false);
    expect(res.status).toBe(0);
  });

  it("createOrderDryRun echoes the request as simulated and never writes", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const client = new JupiterPredictionClient({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      timeoutMs: 1000,
      maxRetries: 0,
      liveTradingPermitted: false,
    });

    const out = await client.createOrderDryRun({ size: 1 });
    expect(out.simulated).toBe(true);
    expect(out.raw).toEqual({ size: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("createOrder throws (live trading not permitted)", async () => {
    const client = new JupiterPredictionClient({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      timeoutMs: 1000,
      maxRetries: 0,
      liveTradingPermitted: false,
    });
    await expect(client.createOrder({})).rejects.toThrow(/createOrder blocked/);
  });

  it("live trading disabled by default via loadConfig flags", async () => {
    const loaded = loadConfig();
    expect(loaded.flags.liveTradingPermitted).toBe(false);

    // A client built with the loaded (disabled) permission still refuses.
    const client = new JupiterPredictionClient({
      baseUrl: loaded.config.jupiter.baseUrl,
      apiKey: loaded.env.jupiterApiKey,
      timeoutMs: loaded.config.jupiter.requestTimeoutMs,
      maxRetries: loaded.config.jupiter.maxRetries,
      liveTradingPermitted: loaded.flags.liveTradingPermitted,
    });
    await expect(client.createOrder({})).rejects.toThrow();
  });
});
