import { describe, it, expect, vi } from "vitest";
import { newSmartWalletEmbed, paperFillEmbed, paperSummaryEmbed, topWalletsEmbed, Notifier } from "../src/notify.js";
import type { SmartWallet, PaperPosition } from "../src/types.js";

const wallet: SmartWallet = {
  ownerPubkey: "ABCDEFGHIJKLMNOP", pnl7dUsd: 420.5, totalVolumeUsd: 1000,
  winRatePct: 62.3, source: "btc", discoveredAt: 1, lastSeen: 1,
};
const pos: PaperPosition = {
  marketId: "m1", marketTitle: "BTC up?", side: "yes", filledContracts: 40, requestedUsd: 10,
  avgFillPriceUsd: 0.25, grossCostUsd: 10, feeUsd: 0.33, netCostUsd: 10.33, partial: false,
  openedFromWallet: "ABCDEFGHIJKLMNOP", openedAt: 1,
};

describe("discord embeds", () => {
  it("smart wallet embed has pnl field and link", () => {
    const e = newSmartWalletEmbed(wallet);
    expect(e.title).toContain("Smart Wallet");
    expect(e.fields?.some((f) => f.value.includes("420.50"))).toBe(true);
    expect(e.url).toContain("ABCDEFGHIJKLMNOP");
  });

  it("paper fill embed shows fee and net cost", () => {
    const e = paperFillEmbed(pos);
    expect(e.fields?.find((f) => f.name === "Fee")?.value).toBe("$0.33");
    expect(e.fields?.find((f) => f.name === "Net cost")?.value).toBe("$10.33");
  });

  it("summary embed colors loss red", () => {
    const e = paperSummaryEmbed({ openPositions: 1, trackedWallets: 2, totalNetCost: 100, totalValue: 80, unrealizedPnl: -20 });
    expect(e.color).toBe(0xed4245);
  });

  it("ranks verified wallets first with medals, unverified flagged", () => {
    const e = topWalletsEmbed([
      { ...wallet, ownerPubkey: "UNVER1111UNVER22", pnl7dUsd: 5000, verified: false, predictions: 2, winRatePct: 100 },
      { ...wallet, ownerPubkey: "VERIF1111VERIF22", pnl7dUsd: 999, verified: true, predictions: 219, winRatePct: 56 },
    ]);
    expect(e.title).toContain("Top Smart Wallets");
    // verified wallet ranks first despite lower pnl
    expect(e.description?.split("\n")[0]).toContain("🥇");
    expect(e.description?.split("\n")[0]).toContain("VERIF");
    expect(e.description?.split("\n")[0]).toContain("over 219");
    // unverified flagged with warning
    expect(e.description?.split("\n")[1]).toContain("⚠️");
  });

  it("top-wallets embed handles empty list", () => {
    const e = topWalletsEmbed([]);
    expect(e.description).toContain("No qualifying");
  });

  it("notifier posts JSON to webhook", async () => {
    const f = vi.fn(async () => ({ ok: true })) as unknown as typeof fetch;
    const n = new Notifier("https://discord/webhook", f);
    await n.send([paperFillEmbed(pos)]);
    const body = JSON.parse(((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit).body as string);
    expect(body.embeds).toHaveLength(1);
  });

  it("notifier no-ops without url", async () => {
    const f = vi.fn() as unknown as typeof fetch;
    await new Notifier("", f).send([paperFillEmbed(pos)]);
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });
});
