// Reliability / calibration primitives. Pure, defensive, fail-safe.
// These measure whether predicted probabilities match realized outcomes.
// No profitability is ever assumed here — these are honesty metrics only.

export interface ProbSample {
  p: number;
  outcome: 0 | 1;
}

const EPS = 1e-12;

/** Clamp a probability into (eps, 1-eps) to avoid log(0)/log(1) blowups. */
function clampProb(p: number): number {
  if (!Number.isFinite(p)) return 0.5;
  if (p < EPS) return EPS;
  if (p > 1 - EPS) return 1 - EPS;
  return p;
}

/** Keep only structurally valid samples (finite p, outcome strictly 0|1). */
function sanitizeSamples(samples: ProbSample[]): ProbSample[] {
  if (!Array.isArray(samples)) return [];
  const out: ProbSample[] = [];
  for (const s of samples) {
    if (!s || typeof s !== "object") continue;
    const p = (s as ProbSample).p;
    const outcome = (s as ProbSample).outcome;
    if (typeof p !== "number" || !Number.isFinite(p)) continue;
    if (outcome !== 0 && outcome !== 1) continue;
    out.push({ p, outcome });
  }
  return out;
}

/**
 * Brier score = mean( (p - outcome)^2 ). Lower is better. Range [0,1].
 * Empty/invalid input → 0 (neutral, never throws).
 */
export function brierScore(samples: ProbSample[]): number {
  const clean = sanitizeSamples(samples);
  if (clean.length === 0) return 0;
  let sum = 0;
  for (const s of clean) {
    const p = clampProb(s.p);
    const diff = p - s.outcome;
    sum += diff * diff;
  }
  return sum / clean.length;
}

/**
 * Log loss (cross-entropy). Lower is better. p is clamped to avoid log(0).
 * Empty/invalid input → 0 (neutral, never throws).
 */
export function logLoss(samples: ProbSample[]): number {
  const clean = sanitizeSamples(samples);
  if (clean.length === 0) return 0;
  let sum = 0;
  for (const s of clean) {
    const p = clampProb(s.p);
    sum += s.outcome === 1 ? -Math.log(p) : -Math.log(1 - p);
  }
  return sum / clean.length;
}

export interface ReliabilityBucket {
  bucket: number;
  predicted: number;
  observed: number;
  n: number;
}

/**
 * Reliability (calibration) curve. Partitions [0,1] into `buckets` equal-width
 * bins; for each bin reports mean predicted p and observed outcome frequency.
 * Buckets with no samples are still emitted (n=0, predicted/observed=0) so the
 * curve has a fixed shape regardless of data sparsity.
 */
export function reliabilityCurve(
  samples: ProbSample[],
  buckets: number,
): ReliabilityBucket[] {
  const clean = sanitizeSamples(samples);
  const nBuckets =
    Number.isFinite(buckets) && buckets >= 1 ? Math.floor(buckets) : 1;

  const sumP = new Array<number>(nBuckets).fill(0);
  const sumOutcome = new Array<number>(nBuckets).fill(0);
  const count = new Array<number>(nBuckets).fill(0);

  for (const s of clean) {
    const p = clampProb(s.p);
    let idx = Math.floor(p * nBuckets);
    if (idx >= nBuckets) idx = nBuckets - 1; // p === 1 edge
    if (idx < 0) idx = 0;
    sumP[idx] += p;
    sumOutcome[idx] += s.outcome;
    count[idx] += 1;
  }

  const out: ReliabilityBucket[] = [];
  for (let i = 0; i < nBuckets; i++) {
    const n = count[i];
    out.push({
      bucket: i,
      predicted: n > 0 ? sumP[i] / n : 0,
      observed: n > 0 ? sumOutcome[i] / n : 0,
      n,
    });
  }
  return out;
}
