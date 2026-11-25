// Pure ranking: given wrappers, their route quotes and a reference price for
// the underlying stock, work out what $spendUsd actually buys with each one.
//
//   onTopUsd         = gas + fees charged on top of the spend
//   premiumPct       = (wrapper CMC price / reference price - 1) * 100
//   routeCostUsd     = spendUsd - tokensOut * wrapper CMC price + onTopUsd
//   receivedValueUsd = tokensOut * reference price - onTopUsd
//
// receivedValueUsd is the stock exposure you end up holding, net of what the
// route charges on top, so it already folds in both the premium and the route
// cost. Rows are sorted by it.

import type { RouteQuote } from "./lifi.ts";
import type { Wrapper } from "./wrappers.ts";

export type Unavailable =
  /** The chain is not EVM (Solana, TON). */
  | "non_evm_chain"
  /** EVM or unknown chain with no quote source wired. */
  | "unsupported_chain"
  /** The quote source answered: no route. */
  | "no_route"
  /** The quote could not be fetched (rate limit, server, network). The wrapper may well be buyable. */
  | "quote_failed"
  /** The quote's token amount is far from what the price says $spend should buy (wrong decimals, not 1 token = 1 share). */
  | "implausible_quote";

/** A quote whose market value is off from the spend by more than this is not ranked. */
export const PLAUSIBLE_QUOTE_TOLERANCE = 0.2;

export interface RankedWrapper {
  wrapper: Wrapper;
  premiumPct: number | null;
  quote: RouteQuote | null;
  routeCostUsd: number | null;
  receivedValueUsd: number | null;
  /** Set when the row is not ranked; such rows are listed after every ranked one. */
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
  if (!(spendUsd > 0)) throw new Error("spend must be positive");

  const rows: RankedWrapper[] = wrappers.map((wrapper, i) => {
    const outcome = outcomes[i]!;
    const price = wrapper.cmcPriceUsd != null && wrapper.cmcPriceUsd > 0 ? wrapper.cmcPriceUsd : null;
    const premiumPct = price != null ? (price / referencePriceUsd - 1) * 100 : null;
    const unranked = (reason: Unavailable, detail?: string, quote: RouteQuote | null = null): RankedWrapper => ({
      wrapper,
      premiumPct,
      quote,
      routeCostUsd: null,
      receivedValueUsd: null,
      unavailable: reason,
      ...(detail ? { unavailableDetail: detail } : {}),
      best: false,
    });

    if (!outcome.ok) return unranked(outcome.reason, outcome.detail);
    const { quote } = outcome;

    // Ranking assumes 1 token = 1 share. A token priced far from the stock
    // (a fractional or multiplied wrapper) would be ranked on a wrong basis.
    if (premiumPct != null && Math.abs(premiumPct) / 100 > PLAUSIBLE_QUOTE_TOLERANCE) {
      return unranked("implausible_quote", `CMC price is ${premiumPct.toFixed(1)}% off the stock; not 1 token = 1 share`, quote);
    }

    // At the wrapper's own price (or the stock's, if CMC has none), the
    // tokens out should be worth roughly what was spent (catches bad decimals).
    const marketValue = quote.tokensOut * (price ?? referencePriceUsd);
    const drift = Math.abs(marketValue - spendUsd) / spendUsd;
    if (!Number.isFinite(drift) || drift > PLAUSIBLE_QUOTE_TOLERANCE) {
      return unranked(
        "implausible_quote",
        `${quote.tokensOut} tokens are worth $${marketValue.toFixed(2)} for a $${spendUsd} spend`,
        quote,
      );
    }

    const onTopUsd = quote.gasUsd + quote.extraFeeUsd;
    return {
      wrapper,
      premiumPct,
      quote,
      routeCostUsd: price != null ? spendUsd - quote.tokensOut * price + onTopUsd : null,
      receivedValueUsd: quote.tokensOut * referencePriceUsd - onTopUsd,
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
  // Unranked rows (or exact ties): larger CMC market cap first, then by name.
  const am = a.wrapper.cmcMarketCapUsd ?? -1;
  const bm = b.wrapper.cmcMarketCapUsd ?? -1;
  if (am !== bm) return bm - am;
  return `${a.wrapper.symbol} ${a.wrapper.chainName}`.localeCompare(`${b.wrapper.symbol} ${b.wrapper.chainName}`);
}
