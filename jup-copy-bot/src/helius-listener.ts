import WebSocket from "ws";

// Jupiter prediction-market on-chain program. logsSubscribe(mentions=[wallet])
// fires for ALL of a wallet's txs (spot swaps, perps, transfers…); we only care
// when this program is invoked — everything else is noise that wastes polls.
export const PREDICTION_PROGRAM_ID = "3ZZuTbwC6aJbvteyVxXUS7gtFYdf7AuXeitx6VyvjvUp";

/**
 * Helius websocket listener: logsSubscribe on each watched wallet so we learn
 * about a leader's trade ~1s after it lands on-chain, instead of waiting for
 * the next 8s positions poll. On a hit we trigger an immediate targeted poll
 * (the existing diff logic stays the source of truth — this is just the bell).
 */
export class HeliusListener {
  private ws?: WebSocket;
  private pingTimer?: NodeJS.Timeout;
  private reconnectDelayMs = 1_000;
  private subIdToWallet = new Map<number, string>(); // server subscription id -> wallet
  private reqIdToWallet = new Map<number, string>(); // our request id -> wallet
  private nextReqId = 1;
  private stopped = false;

  private hadConnection = false;

  constructor(
    private url: string,
    private wallets: string[],
    private onActivity: (wallet: string) => void,
    private onReconnect?: () => void
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
  }

  private connect(): void {
    if (this.stopped) return;
    this.subIdToWallet.clear();
    this.reqIdToWallet.clear();
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectDelayMs = 1_000;
      if (this.hadConnection && this.onReconnect) {
        // catch up on anything missed while disconnected
        try { this.onReconnect(); } catch {}
      }
      this.hadConnection = true;
      for (const wallet of this.wallets) {
        const id = this.nextReqId++;
        this.reqIdToWallet.set(id, wallet);
        ws.send(JSON.stringify({
          jsonrpc: "2.0", id, method: "logsSubscribe",
          params: [{ mentions: [wallet] }, { commitment: "processed" }],
        }));
      }
      // Helius closes idle connections — keep it warm, and detect zombies:
      // if a ping gets no pong before the next tick, the link is dead.
      let alive = true;
      ws.on("pong", () => { alive = true; });
      this.pingTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (!alive) {
          console.error("[helius] pong timeout — terminating zombie ws");
          ws.terminate();
          return;
        }
        alive = false;
        ws.ping();
      }, 30_000);
      console.log(`[helius] ws connected, subscribing ${this.wallets.length} wallets`);
    });

    ws.on("message", (raw) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      // subscription confirmations: { id, result: <subId> }
      if (msg.id !== undefined && typeof msg.result === "number") {
        const wallet = this.reqIdToWallet.get(msg.id);
        if (wallet) this.subIdToWallet.set(msg.result, wallet);
        return;
      }
      // log notifications
      if (msg.method === "logsNotification") {
        const subId = msg.params?.subscription;
        const wallet = this.subIdToWallet.get(subId);
        if (!wallet) return;
        if (msg.params?.result?.value?.err) return; // failed tx — ignore
        const logs: string[] = msg.params?.result?.value?.logs ?? [];
        if (!logs.some((l) => l.includes(PREDICTION_PROGRAM_ID))) return; // not a prediction tx
        console.log(`[helius] prediction-tx ${wallet.slice(0, 6)}… sig ${String(msg.params.result.value.signature).slice(0, 12)}…`);
        this.onActivity(wallet);
      }
    });

    const retry = () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (this.stopped) return;
      console.log(`[helius] ws closed — reconnecting in ${this.reconnectDelayMs / 1000}s`);
      setTimeout(() => this.connect(), this.reconnectDelayMs);
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 10_000);
    };
    ws.on("close", retry);
    ws.on("error", (e) => { console.error(`[helius] ws error: ${(e as Error).message}`); ws.close(); });
  }
}
