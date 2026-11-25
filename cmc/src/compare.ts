// One call: stock ticker in, ranked wrappers out.

import type { CmcClient } from "./cmc.ts";
import { UnsupportedChainError, type RouteQuoter } from "./lifi.ts";
import { rankWrappers, type QuoteOutcome, type RankedWrapper } from "./rank.ts";
import { groupWrappers, type Wrapper } from "./wrappers.ts";

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
  /** How many route quotes to request at once. */
  concurrency?: number;
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
  rows: RankedWrapper[];
}

export async function compareWrappers(opts: CompareOptions): Promise<CompareResult> {
  const spendUsd = opts.spendUsd ?? 100;
  const now = opts.now ?? (() => new Date());

  const quotes = await opts.cmc.rwaQuotesLatest({ symbol: opts.symbol });
  const asset = quotes.data.rwa_assets.find((a) => a.symbol.toUpperCase() === opts.symbol.toUpperCase())
    ?? quotes.data.rwa_assets[0];
  if (!asset) throw new Error(`CoinMarketCap has no RWA asset for ${opts.symbol}`);

  const ids = [...new Set(asset.tokens.map((t) => t.crypto_id))];
  const info = ids.length ? (await opts.cmc.cryptoInfo(ids)).data : {};
  const wrappers = groupWrappers(asset, info);

  const reference = opts.referencePriceUsd ?? asset.average_tokenized_price;
  if (reference == null || !(reference > 0)) {
    throw new Error(`no reference price for ${asset.symbol}`);
  }

  const outcomes = await mapLimited(wrappers, opts.concurrency ?? 4, (w) => quoteOne(opts.quoter, w, spendUsd));

  return {
    asset: { rwaId: asset.rwa_id, symbol: asset.symbol, name: asset.name },
    spendUsd,
    referencePriceUsd: reference,
    referenceSource: opts.referencePriceUsd != null ? "given" : "cmc_average_tokenized_price",
    pricesAsOf: asset.last_updated,
    cmcRespondedAt: quotes.status.timestamp,
    quotedAt: now().toISOString(),
    rows: rankWrappers({ wrappers, outcomes, referencePriceUsd: reference, spendUsd }),
  };
}

async function quoteOne(quoter: RouteQuoter, w: Wrapper, spendUsd: number): Promise<QuoteOutcome> {
  if (!w.evm) return { ok: false, reason: "non_evm_chain" };
  if (w.chainId == null) return { ok: false, reason: "unsupported_chain" };
  try {
    return { ok: true, quote: await quoter({ chainId: w.chainId, tokenAddress: w.address, spendUsd }) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (err instanceof UnsupportedChainError) return { ok: false, reason: "unsupported_chain", detail };
    return { ok: false, reason: "no_route", detail };
  }
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}
