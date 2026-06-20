// Basis monitor. Tracks the spread between the settlement index price and an
// independent CEX reference (BTC context) price. A wide or volatile basis means
// the settlement index is decoupled from the market we model σ on — which makes
// our fair value unreliable. When unstable, downstream pricing/tilt must back off.
//
// isStable = index present & fresh AND |basisBps| <= maxBasisBps AND
//            basisVolatilityBps <= maxBasisVolBps.
//
// Never throws.

import type { BasisSnapshot, BtcContextSnapshot, SettlementIndexSnapshot } from "../jupiter_prediction/models";
import type { Config } from "../config/load_config";

// Treat settlement index as stale beyond this age. Independent of basis vol.
const INDEX_STALE_AGE_MS = 5000;

interface BasisInput {
  settlementIndex: SettlementIndexSnapshot;
  btcContext: BtcContextSnapshot;
  history: number[]; // recent basisBps observations for volatility estimation
  config: Config;
}

/** Sample standard deviation of a numeric series; 0 when <2 finite samples. */
function stddev(xs: number[]): number {
  const v = xs.filter((x) => Number.isFinite(x));
  if (v.length < 2) return 0;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  let acc = 0;
  for (const x of v) acc += (x - mean) * (x - mean);
  const variance = acc / (v.length - 1);
  const s = Math.sqrt(Math.max(variance, 0));
  return Number.isFinite(s) ? s : 0;
}

/** Simple trend: last - first over the history window (in bps). */
function trend(xs: number[]): number | undefined {
  const v = xs.filter((x) => Number.isFinite(x));
  if (v.length < 2) return undefined;
  return v[v.length - 1] - v[0];
}

export function computeBasis(input: BasisInput): BasisSnapshot {
  try {
    const { settlementIndex, btcContext, config } = input;
    const reasonCodes: string[] = [];
    const history = Array.isArray(input.history) ? input.history : [];

    const indexPrice =
      settlementIndex != null && Number.isFinite(settlementIndex.indexPrice as number)
        ? (settlementIndex.indexPrice as number)
        : null;
    const cexPrice =
      btcContext != null && Number.isFinite(btcContext.btcCexPriceNow as number)
        ? (btcContext.btcCexPriceNow as number)
        : null;

    // Missing settlement index → unstable.
    if (indexPrice === null) {
      reasonCodes.push("SETTLEMENT_INDEX_MISSING");
      return {
        settlementIndexPrice: null,
        cexReferencePrice: cexPrice,
        basisUsd: null,
        basisBps: null,
        isStable: false,
        reasonCodes,
      };
    }

    // Stale settlement index → unstable.
    const indexAge = Number.isFinite(settlementIndex.dataAgeMs) ? settlementIndex.dataAgeMs : Number.POSITIVE_INFINITY;
    const indexConfidence = Number.isFinite(settlementIndex.confidence) ? settlementIndex.confidence : 0;
    let stale = false;
    if (indexAge > INDEX_STALE_AGE_MS || indexConfidence <= 0) {
      stale = true;
      reasonCodes.push("SETTLEMENT_INDEX_STALE");
    }

    // Without a CEX reference we cannot compute basis, but the index itself may
    // be fine. Report nulls for basis and mark unstable (can't validate decoupling).
    if (cexPrice === null || !(cexPrice > 0)) {
      reasonCodes.push("BASIS_NO_REFERENCE");
      return {
        settlementIndexPrice: indexPrice,
        cexReferencePrice: null,
        basisUsd: null,
        basisBps: null,
        basisVolatilityBps: undefined,
        isStable: false,
        reasonCodes,
      };
    }

    const basisUsd = indexPrice - cexPrice;
    const basisBps = (basisUsd / cexPrice) * 10000;

    // Volatility of the basis from history (include current observation).
    const basisVolatilityBps = stddev([...history, basisBps]);
    const basisTrend = trend([...history, basisBps]);

    const maxBasisBps = Number.isFinite(config.basis.maxBasisBps) ? config.basis.maxBasisBps : 5;
    const maxBasisVolBps = Number.isFinite(config.basis.maxBasisVolBps) ? config.basis.maxBasisVolBps : 3;

    let tooWide = false;
    let tooVolatile = false;
    if (Math.abs(basisBps) > maxBasisBps) {
      tooWide = true;
      reasonCodes.push("BASIS_TOO_WIDE");
    }
    if (basisVolatilityBps > maxBasisVolBps) {
      tooVolatile = true;
      reasonCodes.push("BASIS_TOO_VOLATILE");
    }

    const isStable = !stale && !tooWide && !tooVolatile;

    return {
      settlementIndexPrice: indexPrice,
      cexReferencePrice: cexPrice,
      basisUsd,
      basisBps,
      basisVolatilityBps,
      basisTrend,
      isStable,
      reasonCodes,
    };
  } catch {
    return {
      settlementIndexPrice: null,
      cexReferencePrice: null,
      basisUsd: null,
      basisBps: null,
      isStable: false,
      reasonCodes: ["BASIS_INTERNAL_ERROR"],
    };
  }
}
