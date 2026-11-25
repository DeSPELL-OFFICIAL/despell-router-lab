// Pure ranking: given wrappers, their route quotes and a reference price for
// the underlying stock, work out what $spendUsd actually buys with each one.
//
//   premiumPct       = (wrapper CMC price / reference price - 1) * 100
//   marketValueUsd   = tokensOut * wrapper CMC price
//   routeCostUsd     = spendUsd - marketValueUsd + gasUsd
//   receivedValueUsd = tokensOut * reference price - gasUsd
//
// receivedValueUsd is the stock exposure you end up holding, net of gas, so it
// already folds in both the premium and the route cost. Rows are sorted by it.

import type { RouteQuote } from "./lifi.ts";
import type { Wrapper } from "./wrappers.ts";

export type Unavailable =
  | "non_evm_chain"
  | "unsupported_chain"
  | "no_route";

export interface RankedWrapper {
  wrapper: Wrapper;
  premiumPct: number | null;
  quote: RouteQuote | null;
  routeCostUsd: number | null;
  receivedValueUsd: number | null;
  /** Set when there is no quote; the row is listed after every quoted one. */
  unavailable: Unavailable | null;
  unavailableDetail?: string;
  /** True on the single row that receives the most. */
  best: boolean;
}

export type QuoteOutcome =
  | { ok: true; quote: RouteQuote }
  | { ok: false; reason: Unavailable; detail?: string };

export interface RankInput {
  wrappers: Wrapper[];
  /** Same order and length as `wrappers`. */
  outcomes: QuoteOutcome[];
  referencePriceUsd: number;
  spendUsd: number;
}

export function rankWrappers({ wrappers, outcomes, referencePriceUsd, spendUsd }: RankInput): RankedWrapper[] {
  if (wrappers.length !== outcomes.length) throw new Error("wrappers and outcomes differ in length");
  if (!(referencePriceUsd > 0)) throw new Error("reference price must be positive");

  const rows: RankedWrapper[] = wrappers.map((wrapper, i) => {
    const outcome = outcomes[i]!;
    const price = wrapper.cmcPriceUsd;
    const premiumPct = price != null && price > 0 ? (price / referencePriceUsd - 1) * 100 : null;
    if (!outcome.ok) {
      return {
        wrapper,
        premiumPct,
        quote: null,
        routeCostUsd: null,
        receivedValueUsd: null,
        unavailable: outcome.reason,
        ...(outcome.detail ? { unavailableDetail: outcome.detail } : {}),
        best: false,
      };
    }
    const { quote } = outcome;
    const routeCostUsd = price != null && price > 0 ? spendUsd - quote.tokensOut * price + quote.gasUsd : null;
    return {
      wrapper,
      premiumPct,
      quote,
      routeCostUsd,
      receivedValueUsd: quote.tokensOut * referencePriceUsd - quote.gasUsd,
      unavailable: null,
      best: false,
    };
  });

  rows.sort(compareRows);
  const top = rows[0];
  if (top && top.receivedValueUsd != null) top.best = true;
  return rows;
}

function compareRows(a: RankedWrapper, b: RankedWrapper): number {
  const av = a.receivedValueUsd;
  const bv = b.receivedValueUsd;
  if (av != null && bv != null && av !== bv) return bv - av;
  if (av != null && bv == null) return -1;
  if (av == null && bv != null) return 1;
  // Unquoted rows (or exact ties): larger CMC market cap first, then by name.
  const am = a.wrapper.cmcMarketCapUsd ?? -1;
  const bm = b.wrapper.cmcMarketCapUsd ?? -1;
  if (am !== bm) return bm - am;
  return `${a.wrapper.symbol} ${a.wrapper.chainName}`.localeCompare(`${b.wrapper.symbol} ${b.wrapper.chainName}`);
}
