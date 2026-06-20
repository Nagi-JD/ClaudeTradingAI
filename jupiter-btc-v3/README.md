# Jupiter BTC V3 — research-first edge-measurement system

**This system is not designed to assume profitability.** It is designed to
prevent false confidence by measuring whether an edge exists **after**
settlement-index basis, spread, slippage, latency, adverse fills, and
calibration error. Its honest default output is `NO_TRADE`.

## Safety posture (hard-wired)
- `READ_ONLY=true`, `DRY_RUN=true`, `ENABLE_LIVE_TRADING=false` by default.
- No real orders. No transaction signing. No private keys. No hardcoded API keys.
- `JupiterPredictionClient.createOrder()` **throws** unless the full unsafe
  combination is set (`READ_ONLY=false` + `DRY_RUN=false` + `ENABLE_LIVE_TRADING=true`).
  In this build that combination is never reached → **LIVE TRADING IS DISABLED.**
- Any unknown / stale / ambiguous critical input ⇒ trade **blocked** with explicit
  `blockedBy` reason codes.

## Setup
```bash
npm install
cp .env.example .env      # then add JUPITER_API_KEY (optional MOONDEV_API_KEY)
```

## Run
```bash
npm run jupiter:collect       # read-only collection → data/jupiter_decisions + snapshots
npm run jupiter:dashboard     # one-shot terminal panels: settlement, basis, vol, pricing, risk
npm run jupiter:replay        # pessimistic-fill replay of saved decisions → PnL/exec metrics
npm run jupiter:calibration   # Brier / reliability / CLV / ablation report
npm run test:jupiter          # vitest suite
npm run typecheck             # tsc --noEmit
```
All scripts run offline (without an API key) to demonstrate wiring; they print a
banner with the safety flags and `LIVE TRADING: DISABLED`.

## Pricing model (empirical, conservative)
- Primary price = the **settlement/reference index** of the underlying provider
  (Polymarket / Kalshi via Jupiter aggregation), **not** generic CEX price.
- CEX price, CVD, liquidations, order-flow are **secondary features only** and are
  capped microstructure tilts that can never dominate the binary price.
- `expectedMove = idx * volPerSec * sqrt(secondsLeft)`, conditioned on settlement
  mechanic (point-in-time vs TWAP/window). `fairYes = Φ((idx − target)/expectedMove)`.
- Costs: never fill at mid; walk the (bids-only) book flipped to real asks; encode
  slippage, latency penalty, failed-fill penalty, and adverse selection.

## What remains provider-specific / MANUAL (must be supplied before any pricing you'd trust)
1. **Polymarket settlement oracle/index mapping** — `settlement_index_adapter.ts`
   currently returns confidence 0 (blocked) for Polymarket; wire the real UMA/oracle
   index source.
2. **Kalshi settlement index mapping** — same: stubbed to confidence 0 (blocked).
3. **Manual reading of each market's resolution rules** — `rule_parser.ts` is
   heuristic; confirm target/source/mechanic per market before trusting `canTrade`.
4. **Fee validation** — `cost_model.ts` fee estimate is a placeholder; confirm real
   Jupiter/provider fees.
5. **Actual fill behavior** — paper fills are deliberately pessimistic; validate
   against real fills before believing any edge.

Until (1)–(2) are supplied with real indices, the system will correctly emit
`SETTLEMENT_UNKNOWN` / `NO_TRADE` for live markets. That is the intended honest behavior.
