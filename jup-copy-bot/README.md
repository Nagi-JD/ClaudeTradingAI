# Jupiter Prediction — Smart-Money Scanner & Paper Copy-Trader

Discovers profitable "smart money" wallets on [Jupiter Prediction Markets](https://developers.jup.ag/docs/prediction)
and **paper-trades** their opening buys with realistic fills & fees — **no real money, no private keys**.
Built for the "RBI" workflow: **R**esearch (discover) → **B**acktest (paper) → **I**mplement (live, later).

## What it does

1. **Discovery (hourly)** — polls the `/trades` feed (accumulated over time) and finds wallets that:
   - traded the 3 most-recently-traded **BTC up/down** markets, or
   - placed a single trade ≥ `MIN_TRADE_USD` ($500) on any market.
2. **P&L filter** — keeps only wallets with **7-day realized P&L ≥ `PNL_THRESHOLD_USD`** ($300),
   via `/profiles/{wallet}/pnl-history?interval=1w`.
3. **Paper copy-trader** — when a tracked wallet opens a buy, simulates the order:
   - walks the live `/orderbook` for a true **average fill price + slippage** (and partial fills),
   - applies the **documented fee** (`0.07 × contracts × price × (1−price)`, rounded up to the cent),
   - records a paper position; marks it to live market price for unrealized P&L. **No auto-close.**
4. **Outputs** — console leaderboard, JSON snapshots (`state/`), and rich **Discord embeds**.

## Setup

```bash
npm install
cp .env.example .env   # then edit .env
```

Set in `.env`:
- `JUP_API_KEY` — from https://developers.jup.ag/portal **(rotate the key if it has ever been shared!)**
- `DISCORD_WEBHOOK_URL` — optional; channel webhook for you + collaborators
- thresholds/cadence — see `.env.example` (sane defaults provided)

## Run

```bash
npm run once     # single discovery+P&L pass, prints the smart-money leaderboard, exits
npm start        # full loop: hourly discovery + ~12s paper-copy poll + snapshots
npm test         # 34 unit tests (fee table, fill/slippage, dedupe, risk caps, embeds)
```

State persists to `state/state.json` and survives restarts. Ctrl+C saves and exits cleanly.

## Discord visuals
- 🧠 **New Smart Wallet** — pubkey (Solscan link), 7d P&L, win rate, source scanner.
- 📥 **Paper Fill** — market, side, contracts, avg fill, gross / fee / net cost.
- 📊 **Paper P&L Summary** (hourly) — tracked wallets, open positions, cost basis, mark value,
  unrealized P&L, return % (green/red coded).

## Notes & limits (beta API)
- **Geo-restricted:** Jupiter blocks **US & South Korea** IPs — run from a permitted region.
- `/trades` is a small *recent* global feed (~20 rows); the bot accumulates it in a rolling buffer.
- This is **paper mode only**. Going live (local keypair + RPC + `POST /orders`) is a future phase,
  intentionally not implemented here.

## Layout
```
src/money.ts          micro-USD math, round-up-to-cent
src/fills.ts          computeFee (fit to docs), simulateFill (orderbook walk)
src/jupiter.ts        read-only API client (x-api-key, retries)
src/discovery.ts      BTC + big-trade wallet scanners (feed-based)
src/pnl-filter.ts     7-day P&L threshold + bounded concurrency
src/state.ts          in-memory store + JSON snapshots + trade buffer
src/paper-executor.ts copy decision, paper fill, mark-to-market
src/notify.ts         Discord embeds + console + JSON
src/index.ts          scheduler / entrypoint (--once)
```

See `docs/superpowers/specs/` and `docs/superpowers/plans/` for the design + plan.
