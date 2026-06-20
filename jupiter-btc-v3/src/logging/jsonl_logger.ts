// JSONL logger. Appends one JSON-encoded object per line to a file, creating
// the parent directory on first write. Fail-safe: never throws in a hot path —
// a logging failure must never crash the strategy loop.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class JsonlLogger {
  private readonly filePath: string;
  private dirEnsured = false;
  private closed = false;

  constructor(filePath: string) {
    this.filePath = typeof filePath === "string" ? filePath : "";
  }

  /** Append one object as a single JSON line. Never throws. */
  write(obj: unknown): void {
    if (this.closed) return;
    if (!this.filePath) return;
    try {
      this.ensureDir();
      const line = this.serialize(obj);
      appendFileSync(this.filePath, line + "\n", "utf8");
    } catch {
      // Logging must never crash the caller.
    }
  }

  /** Mark the logger closed; subsequent writes are ignored. */
  close(): void {
    this.closed = true;
  }

  private ensureDir(): void {
    if (this.dirEnsured) return;
    try {
      const dir = dirname(this.filePath);
      if (dir) mkdirSync(dir, { recursive: true });
    } catch {
      // Best-effort; appendFileSync may still fail and be swallowed in write().
    }
    this.dirEnsured = true;
  }

  private serialize(obj: unknown): string {
    try {
      return JSON.stringify(obj ?? null);
    } catch {
      // Circular / non-serializable payload → record a safe placeholder.
      try {
        return JSON.stringify({
          _logError: "SERIALIZE_FAILED",
          _type: typeof obj,
        });
      } catch {
        return '{"_logError":"SERIALIZE_FAILED"}';
      }
    }
  }
}
