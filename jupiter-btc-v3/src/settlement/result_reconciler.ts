// Result reconciler: reads a market's resolved outcome defensively from the
// Jupiter client and settles a paper trade against it. Pessimistic accounting:
// a winning $1 contract pays out $1 (minus entry cost); VOID returns 0 PnL.
// Never throws — on any ambiguity outcome is null and the trade is left open.

import type {
  NormalizedMarketSnapshot,
  PaperTrade,
} from "../jupiter_prediction/models";
import type { JupiterPredictionClient } from "../jupiter_prediction/client";

type Outcome = "YES" | "NO" | "VOID" | null;

function lc(v: unknown): string {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

/** Walk a shallow object tree looking for a status field. */
function readStatus(obj: Record<string, unknown>): string {
  const keys = ["status", "state", "marketStatus", "market_status", "phase"];
  for (const k of keys) {
    const s = lc(obj[k]);
    if (s) return s;
  }
  return "";
}

/** Read a yes/no resolution result defensively from common field shapes. */
function readResult(obj: Record<string, unknown>): Outcome {
  // Direct result fields.
  const resultKeys = ["result", "outcome", "winningOutcome", "winning_outcome", "resolution"];
  for (const k of resultKeys) {
    const v = obj[k];
    const s = lc(v);
    if (s === "yes" || s === "true" || s === "up" || s === "1") return "YES";
    if (s === "no" || s === "false" || s === "down" || s === "0") return "NO";
    if (s === "void" || s === "invalid" || s === "cancelled" || s === "canceled" || s === "tie")
      return "VOID";
    if (typeof v === "boolean") return v ? "YES" : "NO";
  }
  // Boolean flags.
  if (obj["resolvedYes"] === true || obj["yesWon"] === true) return "YES";
  if (obj["resolvedNo"] === true || obj["noWon"] === true) return "NO";
  if (obj["voided"] === true || obj["isVoid"] === true) return "VOID";
  return null;
}

function isResolvedStatus(status: string): boolean {
  return (
    status === "settled" ||
    status === "resolved" ||
    status === "closed" ||
    status === "finalized" ||
    status === "complete" ||
    status === "completed"
  );
}

/**
 * Read the resolved status/outcome of a market. Returns outcome null when the
 * market is not (yet) resolved or the shape is unrecognized.
 */
export async function reconcileResult(
  client: JupiterPredictionClient,
  market: NormalizedMarketSnapshot,
): Promise<{ outcome: Outcome; raw: unknown }> {
  let raw: unknown = undefined;
  try {
    const eventId = market?.eventId ?? "";
    const marketId = market?.marketId ?? "";
    const resp = await client.getMarketDetails(eventId, marketId);
    raw = resp?.raw ?? resp;

    // Build a flat candidate set of objects to inspect: data + raw + nested.
    const candidates: Record<string, unknown>[] = [];
    const push = (v: unknown) => {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        candidates.push(v as Record<string, unknown>);
      }
    };
    push(resp?.data);
    push(raw);
    // Common nesting.
    if (resp?.data && typeof resp.data === "object") {
      const d = resp.data as Record<string, unknown>;
      push(d["market"]);
      push(d["result"]);
    }
    if (raw && typeof raw === "object") {
      const r = raw as Record<string, unknown>;
      push(r["market"]);
      push(r["data"]);
      push(r["result"]);
    }

    let status = "";
    let outcome: Outcome = null;
    for (const c of candidates) {
      if (!status) status = readStatus(c);
      if (outcome === null) outcome = readResult(c);
    }

    // Only trust an outcome if the market actually appears resolved.
    if (outcome !== null) {
      if (status === "" || isResolvedStatus(status)) {
        return { outcome, raw };
      }
      // Outcome present but status says active/open → not yet settled.
      return { outcome: null, raw };
    }

    // No explicit outcome. If status is resolved but no result decoded → VOID
    // is too aggressive; leave null so a human/later pass can reconcile.
    return { outcome: null, raw };
  } catch (err) {
    return { outcome: null, raw: { error: String(err), raw } };
  }
}

/**
 * Settle a paper trade against a known outcome. Pessimistic:
 *   - winning side  → realized = sizeUsd * (1 - effectiveFillPrice)   ($1 contract)
 *   - losing side   → realized = -sizeUsd * effectiveFillPrice
 *   - VOID          → realized = 0 (return of stake assumed, no PnL credited)
 *   - null/unknown  → left open (outcome null, realizedPnlUsd null)
 *
 * sizeUsd is interpreted as the notional staked; a $1 settled contract bought
 * at price p returns $1 per contract. PnL per dollar of notional = (1 - p) on a
 * win, -p on a loss.
 */
export function reconcilePaperTrade(
  trade: PaperTrade,
  outcome: Outcome,
): PaperTrade {
  const out: PaperTrade = { ...trade, outcome };

  try {
    if (outcome === null || outcome === undefined) {
      out.realizedPnlUsd = null;
      return out;
    }

    if (outcome === "VOID") {
      // Pessimistic: no PnL credited on void (stake returned, costs ignored
      // here to avoid over-crediting). realized = 0.
      out.realizedPnlUsd = 0;
      return out;
    }

    const sizeUsd =
      typeof trade?.sizeUsd === "number" && Number.isFinite(trade.sizeUsd)
        ? trade.sizeUsd
        : 0;
    const fill =
      typeof trade?.effectiveFillPrice === "number" &&
      Number.isFinite(trade.effectiveFillPrice)
        ? Math.max(0, Math.min(1, trade.effectiveFillPrice))
        : null;

    if (fill === null || sizeUsd <= 0) {
      out.realizedPnlUsd = null;
      return out;
    }

    const won = trade?.side === outcome; // side is "YES" | "NO"
    out.realizedPnlUsd = won
      ? sizeUsd * (1 - fill) // $1 settled value per contract notional
      : -sizeUsd * fill;
    return out;
  } catch {
    out.realizedPnlUsd = null;
    return out;
  }
}
