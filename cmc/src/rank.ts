// Pure ranking: given wrappers, their route quotes and a reference price for
// the underlying stock, work out what $spendUsd actually buys with each one.
//
// With ref = reference price, p = the wrapper's CMC price, and a quote that
// gives tokensOut for spendUsd, with fees inside the route (feeUsd) and costs
// paid on top (gasUsd + extraFeeUsd):
//
//   execPriceUsd     = (spendUsd - feeUsd) / tokensOut     price paid per token, fees aside
//   premiumPct       = (execPriceUsd / ref - 1) * 100      what this route pays over the stock
//   receivedValueUsd = tokensOut * ref - (gasUsd + extraFeeUsd)
//   shortfallUsd     = spendUsd - receivedValueUsd        always in ranking order
//                    = knownCostUsd + priceGapUsd
//   knownCostUsd     = gasUsd + extraFeeUsd + feeUsd
//   priceGapUsd      = tokensOut * (execPriceUsd - ref)   negative when the route pays below ref
//
// Rows are sorted by receivedValueUsd (equivalently, smallest shortfall).
// A route paying far from the stock price is not a cheaper share: it is a
// token that is not one share, a depeg, or a bad quote. Those rows are not
// ranked (maxPremiumPct). A row that receives more than it spent is ranked
// but never marked best.

import type { RouteQuote } from "./lifi.ts";
import type { Wrapper } from "./wrappers.ts";

export type Unavailable =
  /** The chain is not EVM (Solana, TON). */
  | "non_evm_chain"
  /** EVM or unknown chain with no quote source wired. */
  | "unsupported_chain"
  /** CMC lists the token but gives no contract address to buy. */
  | "no_contract"
  /** The quote source answered: no route. */
  | "no_route"
  /** The quote could not be fetched (rate limit, server, network). The wrapper may well be buyable. */
  | "quote_failed"
  /** The quote came back without the cost fields needed to price it fully. */
  | "quote_incomplete"
  /** The route pays more than maxPremiumPct away from the stock price. */
  | "premium_out_of_band";

/** Reasons that mean the ranking may be missing a wrapper that would have won. */
const INCOMPLETE_REASONS: ReadonlySet<Unavailable> = new Set(["quote_failed", "quote_incomplete"]);

export const DEFAULT_MAX_PREMIUM_PCT = 3;
export const DEFAULT_TIE_USD = 0.05;

export type BestBlocked =
  /** Some quotes failed or were incomplete, so no row can be called best. */
  | "ranking_incomplete"
  /** This row receives more than was spent; that is a pricing artefact, not a bargain. */
  | "receives_more_than_spent";

export interface RankedWrapper {
  wrapper: Wrapper;
  /** CMC price against the reference, for information. Not used for ranking. */
  cmcPremiumPct: number | null;
  quote: RouteQuote | null;
  execPriceUsd: number | null;
  premiumPct: number | null;
  receivedValueUsd: number | null;
  shortfallUsd: number | null;
  knownCostUsd: number | null;
  priceGapUsd: number | null;
  /** Set when the row is not ranked; such rows are listed after every ranked one. */
  unavailable: Unavailable | null;
  unavailableDetail?: string;
  /** True on at most one row: the one that receives the most, when it can be trusted. */
  best: boolean;
  /** Why this row is not best although it is ranked first or above the best row. */
  bestBlocked?: BestBlocked;
  /** Ranked row whose received value is within tieUsd of the best row's. */
  tiedWithBest: boolean;
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
  /** Routes paying further than this from the stock price are not ranked. Default 3. */
  maxPremiumPct?: number;
  /** Rows within this many dollars of the best are marked as tied. Default 0.05. */
  tieUsd?: number;
}

export interface RankOutput {
  rows: RankedWrapper[];
  /** Rows left out because their quote failed or was incomplete. When above 0, no row is best. */
  incomplete: number;
}

export function rankWrappers(input: RankInput): RankOutput {
  const { wrappers, outcomes, referencePriceUsd: ref, spendUsd } = input;
  const maxPremiumPct = input.maxPremiumPct ?? DEFAULT_MAX_PREMIUM_PCT;
  const tieUsd = input.tieUsd ?? DEFAULT_TIE_USD;
  if (wrappers.length !== outcomes.length) throw new Error("wrappers and outcomes differ in length");
  if (!(ref > 0)) throw new Error("reference price must be positive");
  if (!(spendUsd > 0)) throw new Error("spend must be positive");
  if (!(maxPremiumPct > 0 && maxPremiumPct <= 20)) throw new Error("maxPremiumPct must be above 0 and at most 20");
  if (!(tieUsd >= 0)) throw new Error("tieUsd must be 0 or more");

  const rows: RankedWrapper[] = wrappers.map((wrapper, i) => {
    const outcome = outcomes[i]!;
    const p = wrapper.cmcPriceUsd;
    const base: RankedWrapper = {
      wrapper,
      cmcPremiumPct: p != null && p > 0 ? (p / ref - 1) * 100 : null,
      quote: null,
      execPriceUsd: null,
      premiumPct: null,
      receivedValueUsd: null,
      shortfallUsd: null,
      knownCostUsd: null,
      priceGapUsd: null,
      unavailable: null,
      best: false,
      tiedWithBest: false,
    };
    if (!outcome.ok) {
      return { ...base, unavailable: outcome.reason, ...(outcome.detail ? { unavailableDetail: outcome.detail } : {}) };
    }

    const { quote } = outcome;
    const execPriceUsd = quote.tokensOut > 0 ? (spendUsd - quote.feeUsd) / quote.tokensOut : Number.POSITIVE_INFINITY;
    const premiumPct = (execPriceUsd / ref - 1) * 100;
    const priced = { ...base, quote, execPriceUsd, premiumPct };
    if (!Number.isFinite(premiumPct) || Math.abs(premiumPct) > maxPremiumPct) {
      return {
        ...priced,
        unavailable: "premium_out_of_band" as const,
        unavailableDetail: `pays ${Number.isFinite(premiumPct) ? premiumPct.toFixed(2) : "∞"}% against the stock (band ±${maxPremiumPct}%)`,
      };
    }

    const onTopUsd = quote.gasUsd + quote.extraFeeUsd;
    const receivedValueUsd = quote.tokensOut * ref - onTopUsd;
    const knownCostUsd = onTopUsd + quote.feeUsd;
    const shortfallUsd = spendUsd - receivedValueUsd;
    return {
      ...priced,
      receivedValueUsd,
      shortfallUsd,
      knownCostUsd,
      priceGapUsd: shortfallUsd - knownCostUsd,
    };
  });

  rows.sort(compareRows);

  const incomplete = rows.filter((r) => r.unavailable && INCOMPLETE_REASONS.has(r.unavailable)).length;
  const ranked = rows.filter((r) => r.receivedValueUsd != null);
  if (incomplete > 0) {
    // A failed quote might have been the winner; do not crown anyone.
    if (ranked[0]) ranked[0].bestBlocked = "ranking_incomplete";
  } else {
    for (const r of ranked) {
      if (r.receivedValueUsd! > spendUsd) {
        r.bestBlocked = "receives_more_than_spent";
        continue;
      }
      r.best = true;
      for (const other of ranked) {
        if (other !== r && Math.abs(other.receivedValueUsd! - r.receivedValueUsd!) <= tieUsd) other.tiedWithBest = true;
      }
      break;
    }
  }
  return { rows, incomplete };
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
  return `${a.wrapper.symbol} ${a.wrapper.chainName ?? ""}`.localeCompare(`${b.wrapper.symbol} ${b.wrapper.chainName ?? ""}`);
}
