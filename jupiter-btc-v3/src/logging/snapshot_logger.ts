// Snapshot logger. Persists market snapshots and strategy decisions to
// dated JSONL files under a base directory, so a research run can be replayed.
//
//   {dir}/markets-YYYY-MM-DD.jsonl     ← logMarket()
//   {dir}/decisions-YYYY-MM-DD.jsonl   ← logDecision()
//
// Fail-safe: never throws (delegates to JsonlLogger, which swallows errors).

import { join } from "node:path";
import type {
  NormalizedMarketSnapshot,
  StrategyDecision,
} from "../jupiter_prediction/models";
import { JsonlLogger } from "./jsonl_logger";

export class SnapshotLogger {
  private readonly dir: string;
  // One logger per (kind, date) so files roll over by day without reopening.
  private readonly loggers = new Map<string, JsonlLogger>();

  constructor(dir: string) {
    this.dir = typeof dir === "string" && dir.length > 0 ? dir : ".";
  }

  /** Append a normalized market snapshot to today's markets file. */
  logMarket(s: NormalizedMarketSnapshot): void {
    try {
      this.loggerFor("markets").write({
        loggedAt: new Date().toISOString(),
        kind: "market",
        snapshot: s,
      });
    } catch {
      // never throw
    }
  }

  /** Append a strategy decision to today's decisions file. */
  logDecision(d: StrategyDecision): void {
    try {
      this.loggerFor("decisions").write({
        loggedAt: new Date().toISOString(),
        kind: "decision",
        decision: d,
      });
    } catch {
      // never throw
    }
  }

  private loggerFor(kind: "markets" | "decisions"): JsonlLogger {
    const date = SnapshotLogger.dateStamp();
    const key = `${kind}:${date}`;
    let logger = this.loggers.get(key);
    if (!logger) {
      logger = new JsonlLogger(join(this.dir, `${kind}-${date}.jsonl`));
      this.loggers.set(key, logger);
    }
    return logger;
  }

  private static dateStamp(): string {
    try {
      // YYYY-MM-DD in UTC for stable, sortable file names.
      return new Date().toISOString().slice(0, 10);
    } catch {
      return "unknown-date";
    }
  }
}
