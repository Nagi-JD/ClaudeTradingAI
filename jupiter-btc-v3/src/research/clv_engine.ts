// Closing Line Value (CLV) engine. Measures whether we entered at a better
// price than the market's closing price — the single most predictive proxy for
// long-run edge in prediction markets, independent of any single resolution.
//
// CLV > 0 means we bought cheaper than the closing line (good). clvNet subtracts
// our trading costs. Pure + defensive: bad inputs → 0 contribution, never throw.

import type { AblationVariant, PaperTrade } from "../jupiter_prediction/models";

const ABLATION_VARIANTS: AblationVariant[] = [
  "base_only",
  "base_plus_cvd",
  "base_plus_liquidations",
  "base_plus_momentum",
  "base_plus_all",
];

export interface ClvInput {
  side: "YES" | "NO";
  entryPrice: number;
  closingYesPrice: number;
  closingNoPrice: number;
  costs?: number;
}

export interface ClvResult {
  clv: number;
  clvNet: number;
}

function isFiniteNum(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/**
 * Compute CLV for a single entry.
 *   For YES: closing line is closingYesPrice; CLV = closingYes - entry.
 *   For NO:  closing line is closingNoPrice;  CLV = closingNo  - entry.
 * Positive CLV = we got in cheaper than the close (favorable).
 * clvNet = clv - costs. Invalid inputs → {0,0} (fail-safe, no throw).
 */
export function computeClv(input: ClvInput): ClvResult {
  if (!input || typeof input !== "object") return { clv: 0, clvNet: 0 };

  const { side, entryPrice } = input;
  if (!isFiniteNum(entryPrice)) return { clv: 0, clvNet: 0 };

  const closing =
    side === "YES"
      ? input.closingYesPrice
      : side === "NO"
        ? input.closingNoPrice
        : NaN;

  if (!isFiniteNum(closing)) return { clv: 0, clvNet: 0 };

  const clv = closing - entryPrice;
  const costs = isFiniteNum(input.costs) ? input.costs : 0;
  const clvNet = clv - costs;
  return { clv, clvNet };
}

export type ClvByVariant = Record<
  AblationVariant,
  { n: number; avgClv: number; avgClvNet: number }
>;

type ClvTrade = PaperTrade & {
  closingYesPrice?: number;
  closingNoPrice?: number;
};

function emptyClvByVariant(): ClvByVariant {
  const out = {} as ClvByVariant;
  for (const v of ABLATION_VARIANTS) {
    out[v] = { n: 0, avgClv: 0, avgClvNet: 0 };
  }
  return out;
}

/**
 * Aggregate CLV by ablation variant. Only trades that carry both a usable entry
 * price (effectiveFillPrice) and a closing line for their side contribute.
 * Trades with missing closing data are skipped (not counted), so n reflects
 * the measurable sample, never an inflated one.
 */
export function aggregateClvByVariant(trades: ClvTrade[]): ClvByVariant {
  const result = emptyClvByVariant();
  if (!Array.isArray(trades)) return result;

  const sumClv: Record<string, number> = {};
  const sumClvNet: Record<string, number> = {};
  for (const v of ABLATION_VARIANTS) {
    sumClv[v] = 0;
    sumClvNet[v] = 0;
  }

  for (const t of trades) {
    if (!t || typeof t !== "object") continue;
    const variant = t.variant;
    if (!ABLATION_VARIANTS.includes(variant)) continue;
    if (!isFiniteNum(t.effectiveFillPrice)) continue;

    const closingYesPrice = isFiniteNum(t.closingYesPrice)
      ? t.closingYesPrice
      : NaN;
    const closingNoPrice = isFiniteNum(t.closingNoPrice)
      ? t.closingNoPrice
      : NaN;

    const closingForSide = t.side === "YES" ? closingYesPrice : closingNoPrice;
    if (!isFiniteNum(closingForSide)) continue; // no measurable closing line

    const { clv, clvNet } = computeClv({
      side: t.side,
      entryPrice: t.effectiveFillPrice,
      closingYesPrice,
      closingNoPrice,
      // costs ≈ the cost wedge already baked into edgeNet is not re-applied
      // here; CLV cost is the explicit trade cost if present, else 0.
    });

    sumClv[variant] += clv;
    sumClvNet[variant] += clvNet;
    result[variant].n += 1;
  }

  for (const v of ABLATION_VARIANTS) {
    const n = result[v].n;
    result[v].avgClv = n > 0 ? sumClv[v] / n : 0;
    result[v].avgClvNet = n > 0 ? sumClvNet[v] / n : 0;
  }

  return result;
}
