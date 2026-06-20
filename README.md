# Claude Trading AI

Experimental research harness for **Jupiter prediction markets** (Solana). Two
independent systems plus a pre-registered validation harness. Everything runs in
**paper / read-only** mode — no real orders, no private keys, no signing.

> ⚠️ Research only. Not financial advice. Secrets live in `.env` files that are
> git-ignored; copy the `.env.example` in each project and fill your own keys.

---

## `jup-copy-bot/` — smart-money copy-trading (paper)

Discovers profitable prediction-market wallets, judges them on post-resolution
skill, mirrors their entries/exits as paper trades, and — crucially — **filters
the recurring toxic patterns** that destroy copy edge (live-lag, coin-flips,
qualifiers, crypto 5-min). The product is the *filter*, not the copy.

- Discovery → quality judgment → watch (Helius WS ~1s) → copy decision funnel →
  mark-to-market → resolution.
- Toxic block filters (`live, tossup, qualif, crypto`) proven on counterfactual
  resolution of blocked fills.
- Sport-oriented target selection (copy edge survives lag on sports, not 5-min
  crypto).

## `jupiter-btc-v3/` — BTC settlement-index edge measurement

A settlement-index-aware, provider-aware research system that measures whether a
tradeable edge exists on Jupiter BTC up/down markets **after** basis, spread,
slippage, latency, and calibration — rather than assuming profitability. Defaults
to `NO_TRADE`. Uses a low-confidence Pyth proxy index with a Binance basis
cross-check when the true settlement stream is unavailable.

## `jup-copy-bot/analysis/` — pre-registered validation harness

The "tribunal": cheap, disconfirming tests with **decision thresholds committed
before seeing results**, ordered by (cost ÷ probability-of-killing-the-project).

- `audit-logs.ts` — **Phase 0** log-integrity audit (accounting recompute,
  phantom-fill detection, orphan tracing). Blocks downstream analysis on corrupt
  data.
- `unit-economics.ts` — **Phase 0.5** upper-bound unit economics + minimum
  detectable forward edge. Uses the most optimistic (overfit) in-sample edge as a
  ceiling; if even the ceiling dies on costs/variance, the project stops.

Run (from a project dir): `npx tsx analysis/audit-logs.ts`

---

*Methodology principle: don't improve the strategy — improve the court that
judges it.*
