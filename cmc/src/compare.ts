// One call: stock ticker in, ranked wrappers out.

import type { CmcClient } from "./cmc.ts";
import { NoRouteError, QuoteIncompleteError, UnsupportedChainError, type RouteQuoter } from "./lifi.ts";
import { rankWrappers, type QuoteOutcome, type RankedWrapper } from "./rank.ts";
import { groupWrappers, type Wrapper } from "./wrappers.ts";

/** Upper bound on the spend, so amounts stay exact when turned into base units. */
export const MAX_SPEND_USD = 1_000_000;

export interface CompareOptions {
  cmc: CmcClient;
  quoter: RouteQuoter;
  /** RWA ticker, for example "NVDA". */
  symbol: string;
  spendUsd?: number;
  /**
   * Price of the underlying stock. Defaults to CMC's average tokenized price,
   * because the RWA endpoints do not carry the exchange-listed price.
   */
  referencePriceUsd?: number;
  /** How many route quotes to request at once (whole number, at least 1). */
  concurrency?: number;
  /** Routes paying further than this from the stock price are not ranked. Default 3 (%). */
  maxPremiumPct?: number;
  /** Rows within this many dollars of the best are marked as tied. Default 0.05. */
  tieUsd?: number;
  now?: () => Date;
}

export interface CompareResult {
  asset: { rwaId: number; symbol: string; name: string };
  spendUsd: number;
  referencePriceUsd: number;
  referenceSource: "cmc_average_tokenized_price" | "given";
  /** CMC `last_updated` for the RWA asset. */
  pricesAsOf: string;
  /** CMC server time of the RWA quotes call. */
  cmcRespondedAt: string;
  /** When route quotes were finished. */
  quotedAt: string;
  /** Rows whose quote failed or was incomplete. When above 0, no row is marked best. */
  incomplete: number;
  rows: RankedWrapper[];
}

export async function compareWrappers(opts: CompareOptions): Promise<CompareResult> {
  const spendUsd = opts.spendUsd ?? 100;
  if (!Number.isFinite(spendUsd) || spendUsd <= 0 || spendUsd > MAX_SPEND_USD) {
    throw new Error(`spend must be a number above 0 and at most ${MAX_SPEND_USD}, got ${spendUsd}`);
  }
  const concurrency = opts.concurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`concurrency must be a whole number of at least 1, got ${concurrency}`);
  }
  if (opts.maxPremiumPct != null && !(opts.maxPremiumPct > 0 && opts.maxPremiumPct <= 20)) {
    throw new Error(`maxPremiumPct must be above 0 and at most 20, got ${opts.maxPremiumPct}`);
  }
  if (opts.tieUsd != null && !(opts.tieUsd >= 0)) throw new Error(`tieUsd must be 0 or more, got ${opts.tieUsd}`);
  if (opts.referencePriceUsd != null && !(opts.referencePriceUsd > 0)) {
    throw new Error(`reference price must be positive, got ${opts.referencePriceUsd}`);
  }
  const now = opts.now ?? (() => new Date());

  const quotes = await opts.cmc.rwaQuotesLatest({ symbol: opts.symbol });
  const wanted = opts.symbol.toUpperCase();
  const asset = quotes.data.rwa_assets.find((a) => a.symbol.toUpperCase() === wanted);
  if (!asset) {
    const got = quotes.data.rwa_assets.map((a) => a.symbol).join(", ") || "nothing";
    throw new Error(`CoinMarketCap has no RWA asset with symbol ${opts.symbol} (got ${got})`);
  }
  const tokens = asset.tokens ?? [];
  if (tokens.length === 0) throw new Error(`${asset.symbol} has no tokenized wrappers on CoinMarketCap`);

  const reference = opts.referencePriceUsd ?? asset.average_tokenized_price;
  if (reference == null || !(reference > 0)) throw new Error(`no reference price for ${asset.symbol}`);

  const ids = [...new Set(tokens.map((t) => t.crypto_id))];
  const info = (await opts.cmc.cryptoInfo(ids)).data;
  const wrappers = groupWrappers(asset, info);

  const outcomes = await mapLimited(wrappers, concurrency, (w) => quoteOne(opts.quoter, w, spendUsd));

  const ranked = rankWrappers({
    wrappers,
    outcomes,
    referencePriceUsd: reference,
    spendUsd,
    ...(opts.maxPremiumPct != null ? { maxPremiumPct: opts.maxPremiumPct } : {}),
    ...(opts.tieUsd != null ? { tieUsd: opts.tieUsd } : {}),
  });

  return {
    asset: { rwaId: asset.rwa_id, symbol: asset.symbol, name: asset.name },
    spendUsd,
    referencePriceUsd: reference,
    referenceSource: opts.referencePriceUsd != null ? "given" : "cmc_average_tokenized_price",
    pricesAsOf: asset.last_updated,
    cmcRespondedAt: quotes.status.timestamp,
    quotedAt: now().toISOString(),
    incomplete: ranked.incomplete,
    rows: ranked.rows,
  };
}

async function quoteOne(quoter: RouteQuoter, w: Wrapper, spendUsd: number): Promise<QuoteOutcome> {
  if (w.listing !== "deployed" || w.address == null) {
    return { ok: false, reason: "no_contract", detail: w.listing === "no_info" ? "CMC info has no entry for this token" : "CMC lists no contract address" };
  }
  if (w.chainKind === "non_evm") return { ok: false, reason: "non_evm_chain" };
  if (w.chainId == null) {
    return { ok: false, reason: "unsupported_chain", ...(w.chainKind === "unknown" ? { detail: `unknown chain ${w.chainName}` } : {}) };
  }
  try {
    return { ok: true, quote: await quoter({ chainId: w.chainId, tokenAddress: w.address, spendUsd }) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (err instanceof UnsupportedChainError) return { ok: false, reason: "unsupported_chain", detail };
    if (err instanceof NoRouteError) return { ok: false, reason: "no_route", detail };
    if (err instanceof QuoteIncompleteError) return { ok: false, reason: "quote_incomplete", detail };
    // Rate limits, server errors, network drops: not evidence that no route exists.
    return { ok: false, reason: "quote_failed", detail };
  }
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}
