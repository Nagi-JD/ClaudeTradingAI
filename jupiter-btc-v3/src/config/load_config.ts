// Config loader: YAML + .env, validated with zod, fail-safe defaults.
// Safety flags from env OVERRIDE the YAML. The effective live gate requires the
// full unsafe combination; anything ambiguous resolves to the safe value.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

const ConfigSchema = z.object({
  readOnly: z.boolean().default(true),
  dryRun: z.boolean().default(true),
  enableLiveTrading: z.boolean().default(false),
  jupiter: z.object({
    baseUrl: z.string().url(),
    providerDefault: z.string().default("polymarket"),
    category: z.string().default("crypto"),
    includeMarkets: z.boolean().default(true),
    requestTimeoutMs: z.number().int().positive().default(3000),
    maxRetries: z.number().int().nonnegative().default(3),
  }),
  refresh: z.object({
    marketMs: z.number().int().positive(),
    orderbookMs: z.number().int().positive(),
    settlementIndexMs: z.number().int().positive(),
    btcContextMs: z.number().int().positive(),
  }),
  settlement: z.object({
    minRuleConfidence: z.number().min(0).max(1),
    requireExactSettlementIndex: z.boolean(),
    blockIfIndexUnknown: z.boolean(),
    blockIfRuleUnclear: z.boolean(),
  }),
  basis: z.object({
    maxBasisBps: z.number(),
    maxBasisVolBps: z.number(),
    blockOnDivergence: z.boolean(),
    blockIfSettlementIndexStale: z.boolean(),
  }),
  vol: z.object({
    ewmaLambda: z.number().min(0).max(1),
    minSamples: z.number().int().positive(),
    jumpZThreshold: z.number(),
    jumpRegimeMultiplier: z.number(),
    lowConfidencePenalty: z.number(),
  }),
  binaryPricing: z.object({
    minExpectedMoveUsd: z.number(),
    clampMin: z.number(),
    clampMax: z.number(),
  }),
  dangerZone: z.object({
    expectedMoveMultiplier: z.number(),
  }),
  tilts: z.object({
    enabled: z.boolean(),
    cvdAdjustmentMax: z.number(),
    liquidationAdjustmentMax: z.number(),
    momentumAdjustmentMax: z.number(),
    disableIfNoOutOfSampleImprovement: z.boolean(),
  }),
  costs: z.object({
    neverFillAtMid: z.boolean(),
    baseSlippage: z.number(),
    marketOrderSlippageMultiplier: z.number(),
    latencyPenaltyMultiplier: z.number(),
    failedFillPenalty: z.number(),
  }),
  orderbook: z.object({
    maxWalkSlippage: z.number(),
    minFillRatio: z.number(),
    neverFillAtMid: z.boolean(),
  }),
  latency: z.object({
    maxAbsoluteMs: z.number(),
    maxFractionOfTimeLeft: z.number(),
    blockUnderSecondsLeft: z.number(),
    useP95: z.boolean(),
  }),
  risk: z.object({
    minTimeLeftSeconds: z.number(),
    maxTimeLeftSeconds: z.number(),
    minEdgeNet: z.number(),
    minConfidence: z.number(),
    maxSpread: z.number(),
    maxDataAgeMs: z.number(),
    maxPositionUsd: z.number(),
    maxDailyLossUsd: z.number(),
  }),
  correlation: z.object({
    maxCorrelatedExposureUsd: z.number(),
    overlapWindowSeconds: z.number(),
  }),
  calibration: z.object({
    enableAblation: z.boolean(),
    minOutOfSampleTrades: z.number().int(),
    disableTiltIfNoImprovement: z.boolean(),
    brierBuckets: z.number().int().positive(),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

export interface AppFlags {
  readOnly: boolean;
  dryRun: boolean;
  enableLiveTrading: boolean;
  /** True ONLY when the full unsafe combination is set. */
  liveTradingPermitted: boolean;
  allowCexResearchFallback: boolean;
  /** Use the free Pyth BTC/USD proxy as a LOW-confidence research index. */
  allowProxyIndex: boolean;
}

export interface LoadedConfig {
  config: Config;
  flags: AppFlags;
  env: {
    jupiterApiKey: string;
    moondevApiKey: string;
  };
  configPath: string;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v.trim().toLowerCase() === "true" || v.trim() === "1";
}

export function loadConfig(pathOverride?: string): LoadedConfig {
  const configPath = resolve(
    pathOverride ??
      process.env.JUPITER_CONFIG_PATH ??
      "config/jupiter_prediction.yaml",
  );
  const raw = yaml.load(readFileSync(configPath, "utf8"));
  const config = ConfigSchema.parse(raw);

  // Env overrides for the safety flags. Default to the SAFE value when unset.
  const readOnly = envBool("READ_ONLY", config.readOnly ?? true);
  const dryRun = envBool("DRY_RUN", config.dryRun ?? true);
  const enableLiveTrading = envBool(
    "ENABLE_LIVE_TRADING",
    config.enableLiveTrading ?? false,
  );

  // Live trading is permitted ONLY with the full unsafe combination.
  const liveTradingPermitted =
    enableLiveTrading === true && dryRun === false && readOnly === false;

  const flags: AppFlags = {
    readOnly,
    dryRun,
    enableLiveTrading,
    liveTradingPermitted,
    allowCexResearchFallback: envBool("ALLOW_CEX_RESEARCH_FALLBACK", false),
    allowProxyIndex: envBool("ALLOW_PROXY_INDEX", false),
  };

  return {
    config,
    flags,
    env: {
      jupiterApiKey: process.env.JUPITER_API_KEY ?? "",
      moondevApiKey: process.env.MOONDEV_API_KEY ?? "",
    },
    configPath,
  };
}
