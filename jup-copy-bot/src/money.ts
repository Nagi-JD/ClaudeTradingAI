// Money helpers. All on-chain USD values are micro-USD (1_000_000 = $1.00).

export function microToUsd(micro: number | string): number {
  return Number(micro) / 1_000_000;
}

export function usdToMicro(usd: number): number {
  return Math.round(usd * 1_000_000);
}

/** Round a USD amount UP to the nearest cent (fees are always rounded up). */
export function roundUpCent(usd: number): number {
  // Guard against FP noise like 1.2000000001 -> 1.21.
  const cents = Math.ceil(Number((usd * 100).toFixed(6)));
  return cents / 100;
}

/** Contracts obtainable for a USD budget at a given per-contract price. */
export function usdToContracts(usd: number, priceUsd: number): number {
  if (priceUsd <= 0) return 0;
  return usd / priceUsd;
}

export function fmtUsd(usd: number): string {
  return `$${usd.toFixed(2)}`;
}
