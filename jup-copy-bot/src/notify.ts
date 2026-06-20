import type { SmartWallet, PaperPosition } from "./types.js";
import { fmtUsd } from "./money.js";

// Discord embed colors
const COLOR_BRAIN = 0x5865f2; // blurple
const COLOR_FILL = 0x57f287; // green
const COLOR_SUMMARY = 0xfee75c; // yellow
const COLOR_LOSS = 0xed4245; // red

interface Embed {
  title: string;
  color: number;
  description?: string;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
  timestamp?: string;
  url?: string;
}

const short = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;
const solscan = (k: string) => `https://solscan.io/account/${k}`;

export function newSmartWalletEmbed(w: SmartWallet): Embed {
  return {
    title: "🧠 New Smart Wallet Tracked",
    color: COLOR_BRAIN,
    url: solscan(w.ownerPubkey),
    description: `[\`${short(w.ownerPubkey)}\`](${solscan(w.ownerPubkey)}) qualified via **${w.source}** scanner.`,
    fields: [
      { name: "7d P&L", value: fmtUsd(w.pnl7dUsd), inline: true },
      { name: "Win rate", value: w.winRatePct ? `${w.winRatePct.toFixed(1)}%` : "—", inline: true },
      { name: "Source", value: w.source, inline: true },
    ],
    footer: { text: "Jupiter Smart-Money Scanner" },
    timestamp: new Date().toISOString(),
  };
}

export function paperFillEmbed(p: PaperPosition): Embed {
  const sideEmoji = p.side === "yes" ? "🟢 YES" : "🔴 NO";
  return {
    title: "📥 Paper Fill (simulated)",
    color: COLOR_FILL,
    description: `Copied **${short(p.openedFromWallet)}** → *${p.marketTitle}*`,
    fields: [
      { name: "Side", value: sideEmoji, inline: true },
      { name: "Contracts", value: p.filledContracts.toFixed(2) + (p.partial ? " (partial)" : ""), inline: true },
      { name: "Avg fill", value: `$${p.avgFillPriceUsd.toFixed(3)}`, inline: true },
      { name: "Gross", value: fmtUsd(p.grossCostUsd), inline: true },
      { name: "Fee", value: fmtUsd(p.feeUsd), inline: true },
      { name: "Net cost", value: fmtUsd(p.netCostUsd), inline: true },
    ],
    footer: { text: "PAPER MODE · no funds at risk" },
    timestamp: new Date().toISOString(),
  };
}

export interface PaperSummary {
  openPositions: number;
  trackedWallets: number;
  totalNetCost: number;
  totalValue: number;
  unrealizedPnl: number;
  realizedPnl?: number; // running total from resolved/closed positions
  closedCount?: number;
  realizedClean?: number;   // realized P&L excluding toxic patterns (filtered strategy)
  closedCleanCount?: number;
}

export function paperSummaryEmbed(s: PaperSummary): Embed {
  const up = s.unrealizedPnl >= 0;
  const realized = s.realizedPnl ?? 0;
  const rUp = realized >= 0;
  return {
    title: "📊 Paper P&L Summary",
    color: up ? COLOR_SUMMARY : COLOR_LOSS,
    fields: [
      { name: "Tracked wallets", value: String(s.trackedWallets), inline: true },
      { name: "Open positions", value: String(s.openPositions), inline: true },
      { name: "Cost basis", value: fmtUsd(s.totalNetCost), inline: true },
      { name: "Mark value", value: fmtUsd(s.totalValue), inline: true },
      { name: "Unrealized P&L", value: `${up ? "🟢 +" : "🔴 "}${fmtUsd(s.unrealizedPnl)}`, inline: true },
      { name: "Return", value: s.totalNetCost > 0 ? `${((s.unrealizedPnl / s.totalNetCost) * 100).toFixed(1)}%` : "—", inline: true },
      { name: "Realized P&L (brut)", value: `${rUp ? "🟢 +" : "🔴 "}${fmtUsd(realized)} (${s.closedCount ?? 0} closed)`, inline: true },
      { name: "Realized P&L (clean)", value: `${(s.realizedClean ?? 0) >= 0 ? "🟢 +" : "🔴 "}${fmtUsd(s.realizedClean ?? 0)} (${s.closedCleanCount ?? 0} filtered)`, inline: true },
    ],
    footer: { text: "Jupiter Smart-Money Scanner · PAPER" },
    timestamp: new Date().toISOString(),
  };
}

const SRC_EMOJI: Record<SmartWallet["source"], string> = {
  btc: "₿",
  trending: "🔥",
  leaderboard: "🏆",
};

/**
 * Hourly ranked leaderboard. Verified (copy-eligible) wallets are ranked first,
 * then by 7d P&L. Each row shows win-rate, sample size, and a quality verdict.
 */
export function topWalletsEmbed(wallets: SmartWallet[], topN = 12): Embed {
  const rows = [...wallets]
    .sort((a, b) => Number(b.verified) - Number(a.verified) || b.pnl7dUsd - a.pnl7dUsd)
    .slice(0, topN);
  const medals = ["🥇", "🥈", "🥉"];
  const lines = rows.map((w, i) => {
    const rank = w.verified ? (medals[i] ?? "✅") : "⚠️";
    const wr = w.predictions ? ` · ${w.winRatePct.toFixed(0)}% over ${w.predictions}` : "";
    const at = w.allTimePnlUsd !== undefined ? ` · all-time ${fmtUsd(w.allTimePnlUsd)}` : "";
    return `${rank} [\`${short(w.ownerPubkey)}\`](${solscan(w.ownerPubkey)}) — 7d **${fmtUsd(w.pnl7dUsd)}**${wr}${at} ${SRC_EMOJI[w.source]}`;
  });
  const verified = wallets.filter((w) => w.verified).length;
  return {
    title: "🏆 Top Smart Wallets — judged on resolved data",
    color: COLOR_BRAIN,
    description: lines.length ? lines.join("\n") : "_No qualifying wallets discovered yet._",
    footer: {
      text: `${verified} verified / ${wallets.length} tracked · ✅ copy-eligible · ⚠️ unproven`,
    },
    timestamp: new Date().toISOString(),
  };
}

export class Notifier {
  constructor(private webhookUrl: string, private f: typeof fetch = fetch) {}

  async send(embeds: Embed[]): Promise<void> {
    if (!this.webhookUrl || embeds.length === 0) return;
    try {
      await this.f(this.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "Jup Smart-Money", embeds: embeds.slice(0, 10) }),
      });
    } catch (e) {
      console.warn("[discord] webhook failed:", (e as Error).message);
    }
  }
}

// ---- Console rendering ----

export function renderLeaderboard(wallets: SmartWallet[]): string {
  if (wallets.length === 0) return "(no smart wallets yet)";
  const rows = [...wallets].sort((a, b) => b.pnl7dUsd - a.pnl7dUsd).slice(0, 20);
  const lines = rows.map(
    (w, i) =>
      `${String(i + 1).padStart(2)}. ${short(w.ownerPubkey).padEnd(11)} 7dP&L ${fmtUsd(w.pnl7dUsd).padStart(10)}  [${w.source}]`
  );
  return ["🧠 Smart-Money Leaderboard", ...lines].join("\n");
}
