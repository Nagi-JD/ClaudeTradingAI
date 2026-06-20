import { promises as fs } from "node:fs";
import path from "node:path";
import type { BotState, SmartWallet, PaperPosition } from "./types.js";

const SEEN_CAP = 5000;

export function emptyState(): BotState {
  return {
    candidates: {},
    smartWallets: {},
    seenTrades: [],
    paperPositions: [],
    closedPositions: [],
    realizedPnlUsd: 0,
    lastLoggedTradeId: 0,
    spentTodayUsd: 0,
    spentDay: today(),
  };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const TRADE_BUFFER_CAP = 5000;

export class Store {
  state: BotState;
  private file: string;
  private seenSet: Set<number>;
  /** Rolling buffer of recently-seen trades (in-memory, for discovery accumulation). */
  private tradeBuf = new Map<number, import("./types.js").Trade>();

  constructor(file: string, state: BotState = emptyState()) {
    this.file = file;
    this.state = state;
    this.seenSet = new Set(state.seenTrades);
    this.rolloverDay();
  }

  /** Add trades to the rolling discovery buffer (deduped by id, capped). */
  accumulateTrades(trades: import("./types.js").Trade[]): void {
    for (const t of trades) this.tradeBuf.set(t.id, t);
    if (this.tradeBuf.size > TRADE_BUFFER_CAP) {
      const ids = [...this.tradeBuf.keys()].sort((a, b) => a - b);
      for (const id of ids.slice(0, this.tradeBuf.size - TRADE_BUFFER_CAP)) this.tradeBuf.delete(id);
    }
  }

  recentTrades(): import("./types.js").Trade[] {
    return [...this.tradeBuf.values()];
  }

  static async load(file: string): Promise<Store> {
    try {
      const raw = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(raw) as BotState;
      return new Store(file, { ...emptyState(), ...parsed });
    } catch {
      return new Store(file);
    }
  }

  async save(): Promise<void> {
    this.state.seenTrades = [...this.seenSet];
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    // atomic: a crash mid-write must never corrupt the only copy of the data
    const tmp = this.file + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(this.state, null, 2));
    await fs.rename(tmp, this.file);
  }

  hasSeen(id: number): boolean {
    return this.seenSet.has(id);
  }

  markSeen(id: number): void {
    this.seenSet.add(id);
    if (this.seenSet.size > SEEN_CAP) {
      // drop oldest (lowest ids) — trade ids are monotonic
      const sorted = [...this.seenSet].sort((a, b) => a - b);
      this.seenSet = new Set(sorted.slice(sorted.length - SEEN_CAP));
    }
  }

  addCandidate(ownerPubkey: string, source: SmartWallet["source"]): void {
    if (!this.state.candidates[ownerPubkey]) {
      this.state.candidates[ownerPubkey] = { source, firstSeen: Date.now() };
    }
  }

  /** Promote a smart wallet; returns true if newly added. */
  promote(w: SmartWallet): boolean {
    const isNew = !this.state.smartWallets[w.ownerPubkey];
    const prev = this.state.smartWallets[w.ownerPubkey];
    this.state.smartWallets[w.ownerPubkey] = { ...w, discoveredAt: prev?.discoveredAt ?? w.discoveredAt };
    delete this.state.candidates[w.ownerPubkey];
    return isNew;
  }

  isTracked(ownerPubkey: string): boolean {
    return !!this.state.smartWallets[ownerPubkey];
  }

  /** Copy-eligible only if the wallet passed the quality gate. */
  isVerified(ownerPubkey: string): boolean {
    return this.state.smartWallets[ownerPubkey]?.verified === true;
  }

  rolloverDay(): void {
    const d = today();
    if (this.state.spentDay !== d) {
      this.state.spentDay = d;
      this.state.spentTodayUsd = 0;
    }
  }

  addPosition(p: PaperPosition): void {
    this.state.paperPositions.push(p);
    this.rolloverDay();
    this.state.spentTodayUsd += p.netCostUsd;
  }

  openPositionCount(): number {
    return this.state.paperPositions.length;
  }

  /**
   * Replace the open set with `stillOpen` and archive `newlyClosed` (realized at
   * resolution), accumulating their realized P&L into the running total.
   */
  settle(stillOpen: PaperPosition[], newlyClosed: PaperPosition[]): void {
    // Merge, don't blind-replace: keep positions added after the caller took its
    // snapshot (mark-to-market awaits one API call per position — plenty of time
    // for the watch-copy loop to open something new).
    const key = (p: PaperPosition) => `${p.marketId}|${p.side}|${p.openedFromWallet}|${p.openedAt}`;
    const processed = new Set([...stillOpen, ...newlyClosed].map(key));
    const addedMeanwhile = this.state.paperPositions.filter((p) => !processed.has(key(p)));
    this.state.paperPositions = [...stillOpen, ...addedMeanwhile];
    for (const c of newlyClosed) {
      this.state.closedPositions.push(c);
      this.state.realizedPnlUsd += c.realizedPnlUsd ?? 0;
    }
  }
}
