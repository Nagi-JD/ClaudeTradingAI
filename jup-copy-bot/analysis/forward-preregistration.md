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
deflates the trades-needed. At sd ≈ $9.9: +$1.80 → ~83 trades; but if the edge
regresses to a realistic +$1.00 → ~265; +$0.90 → ~330. **We budget N = 300, not
83.** Be pleasantly surprised if it converges sooner — but the rule is N=300.

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
| **Cutoff** | `openedAt > 1781960030776` (2026-06-20T11:33:50Z). The 194 baseline positions are EXCLUDED. Only NEW trades count — the baseline generated the hypothesis; including it is circular. |
| **Sample** | pre-match sport closed copies opened after the cutoff |
| **N (fixed)** | **300** new qualifying trades. Pre-committed. |
| **Optional stopping** | **FORBIDDEN.** No peeking-and-declaring. The evaluator emits NO verdict until n ≥ 300, then evaluates **ONCE**. |
| **Bar 1 (significance)** | `t ≥ 1.645` (one-sided 95%) on the new sample |
| **Bar 2 (economics)** | `mean $/trade > real cost floor` (Solana p90 priority fee, ~$0.29). A barely-significant edge smaller than fees is significant-and-useless. |
| **PASS = both bars** | → green light to **SHADOW-EXEC**, *not* real money. Paper keeps the adverse-selection + priority-fee haircut one more stage before capital. |
| **FAIL = either bar** | → the pre-match edge was an in-sample mirage. Stop. |

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
