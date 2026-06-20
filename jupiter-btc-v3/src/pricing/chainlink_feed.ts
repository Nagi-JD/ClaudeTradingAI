// Chainlink BTC/USD on-chain Data Feed reader (Ethereum mainnet aggregator).
// FREE via public RPC. Pure fetch, no I/O, fail-safe (null on any error).
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ CALIBRATION REFERENCE ONLY — read the caveat.                          │
// │                                                                        │
// │ This is the on-chain Data FEED (push: deviation-threshold + heartbeat),│
// │ NOT the Data STREAM that Jupiter settles on. Between updates it is      │
// │ FROZEN on its last value — so in a fast move it lags a full band while │
// │ the Stream has already moved sub-second. It calibrates the consensus↔  │
// │ Chainlink METHODOLOGY *in calm regimes only*; it does NOT measure the  │
// │ sub-second residual that flips near-the-money binaries. When computing │
// │ a bias from these samples LATER, keep only calm + feed-fresh ones      │
// │ (low chainlinkAgeMs AND low dispersion) or you will measure the feed's │
// │ staleness and mistake it for a bias in your consensus.                 │
// └──────────────────────────────────────────────────────────────────────┘

// Chainlink BTC/USD aggregator proxy (Ethereum mainnet).
const AGG = process.env.CHAINLINK_BTCUSD_AGG ?? "0xF4030086522a5beEa4988F8cA5B36dbC97BeE88c";
const RPCS = (process.env.ETH_RPCS ??
  "https://ethereum-rpc.publicnode.com,https://eth.llamarpc.com,https://cloudflare-eth.com")
  .split(",").map((s) => s.trim()).filter(Boolean);
// latestRoundData() selector
const SELECTOR = "0xfeaf968c";

export interface ChainlinkRead {
  price: number;
  updatedAtMs: number;
  /** age of the on-chain print at read time (ms). High age = stale/calm. */
  ageMs: number;
  roundId: string;
}

export async function fetchChainlinkBtcUsd(): Promise<ChainlinkRead | null> {
  for (const rpc of RPCS) {
    try {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: AGG, data: SELECTOR }, "latest"] }),
        signal: AbortSignal.timeout(6000),
      });
      if (!res || !res.ok) continue;
      const j = (await res.json()) as { result?: string };
      const hex = j?.result;
      if (typeof hex !== "string" || hex.length < 2 + 320) continue; // 5 x 32-byte words
      const h = hex.slice(2);
      // (roundId, answer, startedAt, updatedAt, answeredInRound)
      const roundId = BigInt("0x" + h.slice(0, 64)).toString();
      const answer = BigInt("0x" + h.slice(64, 128));     // int256, BTC price > 0
      const updatedAt = Number(BigInt("0x" + h.slice(192, 256)));
      const price = Number(answer) / 1e8;                  // Chainlink feeds use 8 decimals
      if (price > 0 && updatedAt > 0) {
        const updatedAtMs = updatedAt * 1000;
        return { price, updatedAtMs, ageMs: Date.now() - updatedAtMs, roundId };
      }
    } catch { /* try next RPC */ }
  }
  return null;
}
