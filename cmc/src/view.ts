// What the wrapper list screen shows, worked out from a comparison and from
// whether DeSpell can buy each wrapper. Pure: no network, no React.
//
//   - "Receives the most" stays on the true best row, even when DeSpell cannot
//     buy it. That row's [Buy] is disabled with the reason.
//   - When the best row cannot be bought, the first row that could have been
//     best and can be bought gets "Most you can buy on DeSpell".
//   - When there is no best (a quote failed, or every candidate is blocked),
//     no row gets a badge and the screen says why.
//   - Rows that could not be ranked are folded away, with their reasons.

import type { Buyability } from "./despell.ts";
import type { CompareResult } from "./compare.ts";
import { BEST_MAX_DISCOUNT_PCT, type BestBlocked, type RankedWrapper, type Unavailable } from "./rank.ts";

export type Badge = "best" | "best_buyable" | "tied";

export type BuyState =
  | { kind: "enabled" }
  | { kind: "disabled"; reason: "not_on_despell" | "no_pay_token" | "check_failed" };

export interface RowView {
  key: string;
  symbol: string;
  issuer: string | null;
  chainName: string;
  chainId: number;
  address: string;
  cmcPriceUsd: number | null;
  volume24hUsd: number | null;
  receivedUsd: number;
  premiumPct: number;
  shortfallUsd: number;
  knownCostUsd: number;
  priceGapUsd: number;
  badges: Badge[];
  bestBlocked: BestBlocked | null;
  buy: BuyState;
}

export interface FoldedRowView {
  key: string;
  symbol: string;
  issuer: string | null;
  chainName: string | null;
  reason: Unavailable;
  detail?: string;
}

export type NoBestReason = "incomplete" | "all_blocked" | "nothing_ranked";

export interface WrapperScreen {
  asset: CompareResult["asset"];
  spendUsd: number;
  referencePriceUsd: number;
  pricesAsOf: string;
  quotedAt: string;
  incomplete: number;
  /** Set when no row is marked best. */
  noBest: NoBestReason | null;
  rows: RowView[];
  folded: FoldedRowView[];
}

export const rowKey = (chainId: number | null, address: string | null, symbol: string) =>
  `${chainId ?? "x"}:${(address ?? symbol).toLowerCase()}`;

function buyState(b: Buyability | undefined): BuyState {
  if (!b) return { kind: "disabled", reason: "check_failed" };
  return b.buyable ? { kind: "enabled" } : { kind: "disabled", reason: b.reason };
}

/**
 * @param buyability keyed by rowKey(chainId, address, symbol); rows missing from
 * the map are treated as "could not check" and cannot be bought.
 */
export function buildWrapperScreen(result: CompareResult, buyability: ReadonlyMap<string, Buyability>): WrapperScreen {
  const rows: RowView[] = [];
  const folded: FoldedRowView[] = [];

  for (const r of result.rows) {
    const w = r.wrapper;
    // A ranked row always has a chain and an address (it was quoted there).
    if (!isRanked(r) || w.chainId == null || w.address == null) {
      folded.push({
        key: rowKey(w.chainId, w.address, w.symbol),
        symbol: w.symbol,
        issuer: w.issuer,
        chainName: w.chainName,
        reason: r.unavailable ?? "no_contract",
        ...(r.unavailableDetail ? { detail: r.unavailableDetail } : {}),
      });
      continue;
    }
    const key = rowKey(w.chainId, w.address, w.symbol);
    const badges: Badge[] = [];
    if (r.best) badges.push("best");
    if (r.tiedWithBest) badges.push("tied");
    rows.push({
      key,
      symbol: w.symbol,
      issuer: w.issuer,
      chainName: w.chainName ?? `chain ${w.chainId}`,
      chainId: w.chainId,
      address: w.address,
      cmcPriceUsd: w.cmcPriceUsd,
      volume24hUsd: w.cmcVolume24hUsd,
      receivedUsd: r.receivedValueUsd,
      premiumPct: r.premiumPct,
      shortfallUsd: r.shortfallUsd,
      knownCostUsd: r.knownCostUsd,
      priceGapUsd: r.priceGapUsd,
      badges,
      bestBlocked: r.bestBlocked ?? null,
      buy: buyState(buyability.get(key)),
    });
  }

  const best = rows.find((r) => r.badges.includes("best"));
  let noBest: NoBestReason | null = null;
  if (!best) {
    noBest = rows.length === 0 ? "nothing_ranked" : result.incomplete > 0 ? "incomplete" : "all_blocked";
  } else if (best.buy.kind !== "enabled") {
    // The same tests the best had to pass. rankWrappers only marks rows
    // above the best, so rows below it are checked here.
    const fallback = rows.find(
      (r) =>
        r !== best &&
        r.bestBlocked == null &&
        r.premiumPct >= -BEST_MAX_DISCOUNT_PCT &&
        r.receivedUsd <= result.spendUsd &&
        r.buy.kind === "enabled",
    );
    if (fallback) fallback.badges.unshift("best_buyable");
  }

  return {
    asset: result.asset,
    spendUsd: result.spendUsd,
    referencePriceUsd: result.referencePriceUsd,
    pricesAsOf: result.pricesAsOf,
    quotedAt: result.quotedAt,
    incomplete: result.incomplete,
    noBest,
    rows,
    folded,
  };
}

type Ranked = RankedWrapper & {
  receivedValueUsd: number;
  premiumPct: number;
  shortfallUsd: number;
  knownCostUsd: number;
  priceGapUsd: number;
};

function isRanked(r: RankedWrapper): r is Ranked {
  return (
    r.receivedValueUsd != null && r.premiumPct != null && r.shortfallUsd != null && r.knownCostUsd != null && r.priceGapUsd != null
  );
}
