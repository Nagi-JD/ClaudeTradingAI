// Standard normal CDF via Abramowitz & Stegun 7.1.26 erf approximation.
// Accuracy ~1e-7, ample for binary option pricing. Pure, dependency-free,
// deterministic — the bedrock of the binary pricer and its tests.

export function erf(x: number): number {
  // Save sign; erf is odd.
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);

  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t -
      0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);

  return sign * y;
}

/** Φ(z): probability a standard normal is ≤ z. */
export function normalCdf(z: number): number {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/** Standard normal PDF φ(z) — handy for greeks/diagnostics. */
export function normalPdf(z: number): number {
  return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
}
