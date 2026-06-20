# Jupiter Prediction — Smart-Money Scanner & Paper Copy-Trader

**Date:** 2026-06-05
**Status:** Approved design (pending spec review)

## Goal

Continuously discover profitable "smart money" wallets trading on Jupiter
Prediction Markets, then **paper-trade** their opening buys (no real money) to
validate the strategy before any live trading. "RBI": discover → paper → (later) live.

## Phasing

- **Phase 1 (priority):** Smart-money scanner — discover wallets, filter by P&L,
  output a smart-wallet leaderboard, persist across restarts.
- **Phase 2 (this spec):** Paper copy-trader — simulate mirroring tracked
  wallets' opening buys; mark-to-market; report paper P&L.
- **Phase 3 (NOT built):** Live trading via local keypair + RPC + `POST /orders`,
  gated behind a `PAPER`/`DRY_RUN` flag. Out of scope here.

## Non-Goals (v1)

- No private key, no RPC, no transaction signing, no `POST /orders`.
- No auto-selling/exit or payout claiming.
- No proportional sizing (fixed USD only).
- No Kalshi provider (Polymarket default only).

## External API (Jupiter Prediction, read-only endpoints)

Base: `https://...` (Jupiter Prediction API base), header `x-api-key: <JUP_API_KEY>`.
All USD values are **micro-USD on-chain → divide by 1,000,000** for dollars.

| Need | Endpoint |
|---|---|
| List/sort events & markets | `GET /events?provider=polymarket&category=crypto&sortBy=volume&sortDirection=desc&filter=trending&includeMarkets=true&start=&end=` |
| Event detail w/ markets | `GET /events/{eventId}` |
| Global recent fills feed | `GET /trades` → `data[]`: `id, ownerPubkey, marketId, action(buy/sell), side(yes/no), amountUsd, priceUsd, timestamp, eventTitle, marketTitle, eventId` |
| Per-wallet 7d P&L | `GET /profiles/{ownerPubkey}/pnl-history?interval=1w` and/or `GET /profiles/{ownerPubkey}` (`realizedPnlUsd`) |
| Top earners shortcut | `GET /leaderboards?period=weekly&metric=pnl&limit=100` |
| Market detail/status | `GET /markets/{marketId}` (`status` open/closed, `result`, prices) |
| Orderbook depth (fill sim) | `GET /orderbook/{marketId}` → `yes`/`no`/`yes_dollars`/`no_dollars` arrays of `[price, quantity]` |

Notes:
- `/trades` takes **no params** — it returns only *recent* global fills. We poll
  it on an interval and accumulate; filter client-side by `marketId` / `amountUsd`.
- `/events` `sortBy=volume` is event-level volume; `filter=trending` = recent activity.
- Geo: API blocks US & South Korea IPs; bot must run from a permitted IP.

## Architecture

Single Node.js / TypeScript process with scheduled workers sharing an in-memory
state store that snapshots to JSON.

```
Discovery (hourly) ──▶ P&L Filter (hourly) ──▶ smartWallets
                                                   │
Paper Executor (poll /trades ~12s) ◀───────────────┘
        │
        ▼
State store {smartWallets, candidates, seenTrades, paperPositions}
        │  snapshot every N sec + on shutdown → state.json
        ▼
Outputs: console table, JSON snapshots, Discord webhook
```

## Components

### 1. `src/jupiter.ts` — API client
Typed wrapper over the read endpoints above. Responsibilities: attach `x-api-key`,
timeout + retry w/ backoff, parse `data`/`pagination`, convert micro-USD→USD.
No write/order methods in v1.

### 2. `src/discovery.ts` — Discovery worker (hourly)
Two scanners producing candidate `ownerPubkey`s:
- **BTC scanner:** via `/events?category=crypto`, identify the 3 most recently
  closed BTC up/down markets (title match, e.g. `/bitcoin|btc/i` + up/down +
  `status=closed`, sorted by close time). Collect `ownerPubkey`s from accumulated
  `/trades` whose `marketId` is in that set.
- **Trending scanner:** `/events?category=crypto&sortBy=volume&filter=trending&includeMarkets=true`,
  take top 50 markets; collect wallets from `/trades` where
  `amountUsd * priceUsd >= MIN_TRADE_USD` ($500 default).
Writes unique candidates to `state.candidates`.

### 3. `src/pnl-filter.ts` — P&L filter worker (hourly)
For each candidate (bounded concurrency, default 5 in flight): fetch
`/profiles/{w}/pnl-history?interval=1w`; compute 7-day realized P&L. Keep wallets
with `pnl7d >= PNL_THRESHOLD_USD` ($300). Promote to `state.smartWallets` with
metadata (pnl7d, volume, winRate, discoveredAt, lastSeen).

### 4. `src/fills.ts` — Realistic fill & fee engine (pure functions)
Paper fills must model the real economics, not just record a quoted price.

**Fill simulation (`simulateFill`):** given `sizeUsd`, `side`, and the market
`/orderbook`, walk the relevant depth ladder (best price first) consuming
`[price, quantity]` levels until the USD budget is spent or depth is exhausted:
- `filledContracts` = Σ qty consumed across levels (may be **partial** if depth thin)
- `avgFillPriceUsd` = Σ(price·qty) / filledContracts  → captures **slippage**
- `grossCostUsd` = Σ(price·qty)
- returns partial-fill flag when budget can't be fully filled.

**Fee model (`computeFee`):** fit to the documented price→fee table. Properties:
- inputs `(avgFillPriceUsd, filledContracts)`
- uncertainty-weighted: peaks near $0.50, → 0 near $0.00/$1.00 (model with a
  `price·(1-price)`-shaped factor calibrated so per-100-contract values match the
  doc table: e.g. $0.25→$1.32, $0.40→$1.68, $0.10→$0.63 …)
- **rounded UP to the nearest cent**, minimum $0.01 on any executed trade.
- fee charged in the deposit mint.

**Net result:** `netCostUsd = grossCostUsd + feeUsd`; the paper position stores
gross cost, fee, avg fill price, and filled contracts separately.

### 5. `src/paper-executor.ts` — Paper copy-trader (polls `/trades` ~12s)
When a tracked smart wallet appears with `action=buy` on an `open` market and the
trade `id` is unseen:
- Fetch `/orderbook/{marketId}`, run `simulateFill(FIXED_USD_PER_TRADE, side, book)`
  then `computeFee(avgFillPrice, filledContracts)`.
- Open/append a **paper position**:
  `{marketId, side, filledContracts, requestedUsd, avgFillPriceUsd, grossCostUsd,
    feeUsd, netCostUsd, partial, openedFromWallet, openedAt}`.
  Skip if `filledContracts == 0` (no liquidity).
- Record trade `id` in `seenTrades` (never double-copy).
- **No auto-close.** A separate mark-to-market pass periodically fetches current
  `sell` price (`sellYes/NoPriceUsd` or orderbook bid) per held market and updates
  unrealized paper P&L = `filledContracts·markPrice − netCostUsd` (entry fees
  included; exit fee estimated when/ if marked as closed).
Risk guards still apply in paper mode (caps below) so paper mirrors live limits.

### 6. `src/state.ts` — State store + persistence
In-memory maps: `candidates`, `smartWallets`, `seenTrades`, `paperPositions`.
Flush to `state.json` every `SNAPSHOT_SEC` and on `SIGINT`/`SIGTERM`; load on
startup. Bounded `seenTrades` (cap size / age out) to avoid unbounded growth.

### 7. `src/notify.ts` — Output sinks
- Console: pretty leaderboard table each cycle + paper-P&L summary.
- JSON: write `smart-wallets.json` and `paper-positions.json` snapshots.
- Discord: POST to `DISCORD_WEBHOOK_URL` on (a) new smart wallet promoted,
  (b) new paper fill. Best-effort, failures logged not fatal.

### 8. `src/index.ts` — Scheduler / entrypoint
`setInterval`: discovery+P&L every `SCAN_INTERVAL_MIN`; paper-executor poll every
`COPY_POLL_SEC`; mark-to-market + snapshot loops. Flags:
- `--once`: single discovery+filter pass, print leaderboard, exit (no executor).
- Graceful shutdown snapshot.

## Config (`.env`, gitignored)

| Var | Default | Purpose |
|---|---|---|
| `JUP_API_KEY` | — | API auth (rotate the leaked key!) |
| `JUP_API_BASE` | (prod base) | API base URL |
| `PROVIDER` | polymarket | events provider |
| `FIXED_USD_PER_TRADE` | 10 | paper order size |
| `PNL_THRESHOLD_USD` | 300 | min 7d P&L to track a wallet |
| `MIN_TRADE_USD` | 500 | trending scanner size filter |
| `SCAN_INTERVAL_MIN` | 60 | discovery+P&L cadence |
| `COPY_POLL_SEC` | 12 | `/trades` poll cadence |
| `SNAPSHOT_SEC` | 30 | state flush cadence |
| `PNL_CONCURRENCY` | 5 | parallel profile fetches |
| `MAX_OPEN_POSITIONS` | 50 | paper risk guard |
| `DAILY_SPEND_CAP_USD` | 500 | paper risk guard |
| `DISCORD_WEBHOOK_URL` | (optional) | notifications |

## Risk Guards (enforced even in paper mode)
- Only copy `action=buy`; never mirror sells in v1.
- Only `status=open` markets.
- Dedupe by trade `id`.
- Respect `MAX_OPEN_POSITIONS` and `DAILY_SPEND_CAP_USD`.
- No pyramiding: skip a market already held (configurable later).

## Testing (vitest, fixture-based — no live calls)
- micro-USD↔USD conversion.
- Trending `amountUsd*priceUsd >= 500` filter.
- P&L `>= 300` threshold + 7d window selection.
- BTC market title matching + "3 most recently closed" selection.
- Dedupe via `seenTrades`.
- **Fee model:** `computeFee` reproduces the documented price→fee table within
  ±$0.01 at 1 and 100 contracts (e.g. $0.25→$1.32, $0.40→$1.68, $0.10→$0.63),
  rounds up to the cent, min $0.01.
- **Fill engine:** orderbook walk gives correct `avgFillPriceUsd`/`filledContracts`
  across multiple levels; partial fill when depth < budget; zero-liquidity skip.
- Paper position math: netCost = gross + fee; mark-to-market unrealized P&L.
- Risk-guard rejection (caps).
- `--once` smoke path against a fixture server/mocked client.

## Open Questions / Assumptions
- Exact API base URL + JupUSD vs USDC mint to confirm from portal at build time.
- `/trades` feed depth/rate limits unknown (beta) — poll conservatively, accumulate.
```
