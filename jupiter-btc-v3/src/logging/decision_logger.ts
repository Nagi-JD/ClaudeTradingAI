// Decision logger. Appends every StrategyDecision to a dated JSONL file under a
// base directory. Replay/calibration tooling reads these files back.
//
//   {dir}/strategy_decisions-YYYY-MM-DD.jsonl
//
// Fail-safe: never throws (delegates to JsonlLogger).

import { join } from "node:path";
import type { StrategyDecision } from "../jupiter_prediction/models";
import { JsonlLogger } from "./jsonl_logger";

export class DecisionLogger {
  private readonly dir: string;
  private readonly loggers = new Map<string, JsonlLogger>();

  constructor(dir: string) {
    this.dir = typeof dir === "string" && dir.length > 0 ? dir : ".";
  }

  /** Append one strategy decision as a JSON line to today's file. */
  log(d: StrategyDecision): void {
    try {
      this.loggerFor().write(d);
    } catch {
      // never throw
    }
  }

  private loggerFor(): JsonlLogger {
    const date = DecisionLogger.dateStamp();
    let logger = this.loggers.get(date);
    if (!logger) {
      logger = new JsonlLogger(
        join(this.dir, `strategy_decisions-${date}.jsonl`),
      );
      this.loggers.set(date, logger);
    }
    return logger;
  }

  private static dateStamp(): string {
    try {
      return new Date().toISOString().slice(0, 10);
    } catch {
      return "unknown-date";
    }
  }
}
