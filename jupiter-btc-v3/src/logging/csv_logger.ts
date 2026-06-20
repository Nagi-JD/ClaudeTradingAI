// CSV logger. Writes a header row once (on first write), then one row per
// call, projecting each row object onto the fixed header columns. Values are
// quoted/escaped per RFC 4180. Fail-safe: never throws in a hot path.

import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

export class CsvLogger {
  private readonly filePath: string;
  private readonly headers: string[];
  private dirEnsured = false;
  private headerWritten = false;

  constructor(filePath: string, headers: string[]) {
    this.filePath = typeof filePath === "string" ? filePath : "";
    this.headers = Array.isArray(headers)
      ? headers.filter((h) => typeof h === "string")
      : [];
  }

  /** Append one row, projected onto the configured headers. Never throws. */
  write(row: Record<string, unknown>): void {
    if (!this.filePath || this.headers.length === 0) return;
    try {
      this.ensureDir();
      this.ensureHeader();
      const r = row && typeof row === "object" ? row : {};
      const line = this.headers
        .map((h) => CsvLogger.escape(r[h]))
        .join(",");
      appendFileSync(this.filePath, line + "\n", "utf8");
    } catch {
      // Logging must never crash the caller.
    }
  }

  private ensureDir(): void {
    if (this.dirEnsured) return;
    try {
      const dir = dirname(this.filePath);
      if (dir) mkdirSync(dir, { recursive: true });
    } catch {
      // swallow
    }
    this.dirEnsured = true;
  }

  private ensureHeader(): void {
    if (this.headerWritten) return;
    // Only write the header if the file is empty/new — preserves an existing log.
    let needHeader = true;
    try {
      if (existsSync(this.filePath) && statSync(this.filePath).size > 0) {
        needHeader = false;
      }
    } catch {
      needHeader = true;
    }
    if (needHeader) {
      const headerLine = this.headers.map((h) => CsvLogger.escape(h)).join(",");
      appendFileSync(this.filePath, headerLine + "\n", "utf8");
    }
    this.headerWritten = true;
  }

  /** RFC-4180 style escaping: wrap in quotes if the value needs it. */
  private static escape(value: unknown): string {
    let s: string;
    if (value === null || value === undefined) {
      s = "";
    } else if (typeof value === "string") {
      s = value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      s = String(value);
    } else {
      try {
        s = JSON.stringify(value);
      } catch {
        s = "";
      }
    }
    if (/[",\r\n]/.test(s)) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }
}
