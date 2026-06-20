# FORWARD TEST — PRE-REGISTRATION (committed while neutral)

> Written **before** the forward sample exists. The rule is fixed here; the
> evaluator (`forward-eval.ts`) enforces it mechanically. Changing any number
> below after data arrives voids the test.

## What we actually proved (the basis for this test)

The decisive empirical result is **not** the +$1.80/trade pre-match tennis. It is
the **in-play crash**: the SAME wallets, SAME sport, copied LATE (lag ≥ 3¢) →
**21% win, −$4.11/trade, t=−1.53 (n=14)**. Lag flips the sign. That is clean
mechanistic evidence that **latency is the killing variable, not the category** —
a hypothesis we assumed for five rounds and now see in the data on both sides.

This gives the pre-match edge a *mechanism* (you can follow a match before it
starts; you cannot once it is live), which is far stronger than an isolated
t=1.36. BUT: "not lag-poisoned" ≠ "profitable". The in-play disaster proves late
copying destroys; it does NOT prove the pre-match edge is positive. The +$1.80
must validate on its own.

## The forking-paths discount (why N is large)

The +$1.80 is the MAXIMUM of a search: clean → sport → tennis → pre-match (best
branch at every fork). Forking inflates the *edge*, not just the t, which
deflates the N-needed. At sd ≈ $9.9: +$1.80 → ~83; if the edge regresses to a
realistic +$1.00 → ~265; +$0.90 → ~330. **We budget for the regressed edge, not
the peak.**

## The correlation trap (why N is counted in EVENTS, not trade-lines)

**300 trade-lines ≠ 300 independent samples.** If 20 watched wallets pile into
one Alcaraz match, that is ONE bet on ONE outcome — it counts ~1 toward the
t-stat, not 20. Widening the wallet set inflates the trade COUNT far faster than
the number of independent EVENTS, and only independent events drive
significance. So the test counts **N in unique (match) events**: all our copies
on the same match collapse to a single per-event observation (mean $/trade), and
the t-stat runs on those. The gate is **independent events**, not lines —
otherwise t≥1.645 is a correlation artifact. The evaluator reports the inflation
ratio (lines ÷ events) so we see it.

## THE PRE-REGISTERED HYPOTHESIS (principled, not forked)

> **H1**: Pre-match sport copies — entry lag < 3¢ (proxy for not-yet-in-play),
> market is a real sporting event (not 5-min crypto, not coin-flip, not
> qualifier) — have a positive edge that clears real execution cost.

We test **pre-match SPORT**, the *principled* prediction (lag is the variable),
NOT hard-coded "tennis only" (the post-hoc branch). Tennis will dominate the
sample naturally; it is reported as a sub-slice for color but **does not change
the gate**. Testing the narrowest forked branch (tennis-only) would bake in the
fork.

## Test design (escapes the fork)

| Rule | Value |
|------|-------|
| **Walk-forward cohort** | `analysis/forward-cohort.json` (built by `cohort-update.ts`). Each wallet enters when it first satisfies the frozen rule (verified && predictions≥50) and is stamped `enteredMs`; that stamp is NEVER re-dated. A trade counts only if `openedAt > wallet.enteredMs`. This lets us WIDEN the observed set without any qualifying-record leaking into its own test window. The 194 baseline positions (openedAt ≤ Jun 19) are all excluded. |
| **Sample unit** | **independent (match) EVENTS** — correlated copies on the same match collapse to one observation (per-event mean $/trade). |
| **N (fixed)** | **250 independent events.** Pre-committed (budgets the post-fork edge regression). |
| **Optional stopping** | **FORBIDDEN.** No peeking-and-declaring. The evaluator emits NO verdict until events ≥ 250, then evaluates **ONCE**. |
| **Bar 1 (significance)** | `t ≥ 1.645` (one-sided 95%) on the **per-event** series |
| **Bar 2 (economics)** | `mean $/trade > real cost floor` (Solana p90 priority fee, ~$0.29). A barely-significant edge smaller than fees is significant-and-useless. |
| **Lag-distribution guard** | The forward set's lag p90 must stay < 3¢. If widening into thin-liquidity markets drifts lag right, the "clean" set is being contaminated with in-play-like trades — the exact thing that killed in-play tennis. The evaluator reports it. |
| **PASS = both bars** | → green light to **SHADOW-EXEC**, *not* real money. Paper keeps the adverse-selection + priority-fee haircut one more stage before capital. |
| **FAIL = either bar** | → the pre-match edge was an in-sample mirage. Stop. |

## Widening observation correctly (the accelerator, without corrupting the test)

The speed lever is **more independent matches**, not more wallets (correlated
copies don't add events). Test pre-match SPORT *broadly* (more sports/matches),
not tennis-only. Rules for the widening:

1. **Widen observation, freeze the decision.** Add as many wallets/markets to
   *observe* as you like; the copy rule (pre-match, lag<3¢, verified,
   MIN_COPY_PREDS, price band) stays exactly as pre-registered. Instrumentation
   yes, behavior no.
2. **Mechanical onboarding, no hand-picking.** Wallets enter via `cohort-update.ts`
   (frozen rule), never by intuition — hand-picking "good tennis wallets" is
   forking at the wallet level and re-introduces leaderboard survivorship.
3. **Hard temporal frontier** — enforced by per-wallet `enteredMs` (above).
4. **Helius WS to detect, REST only at the decision.** Pre-match has slack; do
   NOT re-saturate RPS polling the whole market universe. WS on watched wallets
   detects entries; fetch the orderbook only for the market a watched wallet
   just opened. That is how the freed 5-min budget is spent without re-burning it.
5. **Monitor realized lag.** Thin markets → higher effective lag → silent drift
   into the in-play-toxic regime even on "pre-match". `MAX_COPY_LAG_USD` stays
   enforced; the lag-distribution guard catches drift.

## The operational unlock (or this takes months)

300 new pre-match sport trades is reachable ONLY by **reallocating rate-limit
budget** from the dead 5-min crypto observation (V3 / liqpaper / tradetap noise)
toward **broad pre-match sport observation** — more sport wallets, more matches.
Not a better filter. A redeployment of the observation budget. At the current
debit (shared tier-1 RPS saturated by 5-min pollers) the forward would crawl.

## Status

- Pre-registered: 2026-06-20
- Evaluator: `analysis/forward-eval.ts` (run anytime; reports progress, verdict only at n≥300)
- This is paper. A pass is a green light to shadow-exec, not to capital.
