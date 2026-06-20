# Jupiter Smart-Money Scanner & Paper Copy-Trader — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans / subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Discover profitable Jupiter Prediction wallets, paper-trade their opening buys with realistic fills/fees, surface results via console + JSON + rich Discord embeds.

**Architecture:** Single Node/TypeScript process. Scheduled workers (discovery, P&L filter, paper executor, snapshot) share an in-memory state store persisted to JSON. Read-only Jupiter API. No keys/RPC in v1.

**Tech Stack:** TypeScript, tsx (run), vitest (test), native fetch, dotenv.

---

## File Structure
- `src/config.ts` — env loading + typed config
- `src/types.ts` — shared types (Trade, Event, Market, SmartWallet, PaperPosition, OrderbookSide)
- `src/jupiter.ts` — read-only API client
- `src/money.ts` — micro-USD↔USD + round-up-to-cent helpers
- `src/fills.ts` — `simulateFill`, `computeFee` (pure)
- `src/discovery.ts` — BTC + trending scanners
- `src/pnl-filter.ts` — promote candidates by 7d P&L
- `src/paper-executor.ts` — mirror buys → paper positions; mark-to-market
- `src/state.ts` — state store + JSON snapshots
- `src/notify.ts` — console table, JSON files, Discord embeds
- `src/index.ts` — scheduler/entrypoint (`--once`)
- `test/*.test.ts` — vitest unit tests w/ fixtures

---

### Task 1: Scaffold project
- [ ] package.json (type module), tsconfig, vitest config, .gitignore (.env, state/, node_modules), .env.example
- [ ] `npm i -D typescript tsx vitest @types/node` ; `npm i dotenv`
- [ ] Commit.

### Task 2: money.ts (TDD)
- [ ] Test: `microToUsd(1_000_000)===1`, `usdToContracts`, `roundUpCent(1.234)===1.24`, `roundUpCent(1.201)===1.21`.
- [ ] Implement; run; commit.

### Task 3: fills.ts — computeFee (TDD against doc table)
- [ ] Test fee at 100 contracts within ±0.01: 0.25→1.32, 0.40→1.68, 0.10→0.63, 0.05→0.34, 0.20→1.12; 1 contract → 0.01/0.02 band; min 0.01; rounds up.
- [ ] Implement uncertainty-weighted curve `fee = roundUpCent(k * contracts * price*(1-price) + base)` calibrated to table; run; commit.

### Task 4: fills.ts — simulateFill (TDD)
- [ ] Test: budget walks multi-level book → correct avgFillPrice, filledContracts; partial when depth<budget; zero-liquidity → 0.
- [ ] Implement orderbook walk; run; commit.

### Task 5: types.ts + config.ts
- [ ] Types for all API shapes + domain. Config from env with defaults per spec. Commit.

### Task 6: jupiter.ts (TDD with mocked fetch)
- [ ] Test: getEvents/getTrades/getProfilePnl/getOrderbook attach x-api-key, parse data, retry once on 5xx.
- [ ] Implement; run; commit.

### Task 7: discovery.ts (TDD)
- [ ] Test BTC matcher: picks 3 most-recently-closed btc up/down markets; trending filter keeps amountUsd*priceUsd>=500.
- [ ] Implement scanners returning candidate pubkeys; commit.

### Task 8: pnl-filter.ts (TDD)
- [ ] Test: keeps wallets with 7d pnl>=300, drops below, bounded concurrency. Implement; commit.

### Task 9: state.ts (TDD)
- [ ] Test: add/promote, seenTrades dedupe + cap, save/load roundtrip to temp file. Implement; commit.

### Task 10: paper-executor.ts (TDD)
- [ ] Test: buy by tracked wallet on open market → paper position w/ fill+fee; dedupe; skip closed/sell/zero-liq; risk caps; mark-to-market pnl. Implement; commit.

### Task 11: notify.ts — Discord embeds + console + JSON
- [ ] Console table (smart wallets, paper P&L). JSON snapshots. Discord rich embeds: (a) "🧠 New Smart Wallet" (pnl7d, winRate, volume, link), (b) "📥 Paper Fill" (market, side, contracts, avg price, fee, netCost), (c) hourly "📊 Paper P&L Summary". Color-coded, fields, footer. Best-effort post.
- [ ] Test embed builders produce valid payloads. Commit.

### Task 12: index.ts scheduler + --once
- [ ] Wire intervals; graceful shutdown snapshot; `--once` prints leaderboard. Commit.

### Task 13: README + .env.example finalize
- [ ] Usage, geo warning, key-rotation note, flags. Commit.

## Self-review notes
- Spec coverage: discovery, pnl filter, fills+fees, paper exec, state, notify, scheduler all mapped. ✓
- API base URL + mint are runtime config (.env), flagged in spec Open Questions.
