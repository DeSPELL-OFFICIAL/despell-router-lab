// Route cost from LI.FI's public quote API (no key). We ask: "pay this much
// USDC on chain X, receive token T on chain X" and read how many tokens come
// out and what gas the route needs. Nothing is signed or sent; the
// fromAddress below is only a placeholder LI.FI requires to build a quote.

import { USDC } from "./chains.ts";
import { fromBaseUnits, toBaseUnits } from "./units.ts";

export const LIFI_QUOTE_URL = "https://li.quest/v1/quote";
const QUOTE_ONLY_ADDRESS = "0x000000000000000000000000000000000000dEaD";

export interface QuoteRequest {
  chainId: number;
  tokenAddress: string;
  spendUsd: number;
}

export interface RouteQuote {
  /** Tokens received, after fees taken inside the route. */
  tokensOut: number;
  /** Gas paid on top, in USD. */
  gasUsd: number;
  /** Fees already taken out of tokensOut, in USD (for display only). */
  feeUsd: number;
  /** Which DEX or aggregator LI.FI picked. */
  tool: string;
  source: "lifi";
}

export type RouteQuoter = (req: QuoteRequest) => Promise<RouteQuote>;

export class NoRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoRouteError";
  }
}

/** The quote source cannot price this chain at all (no pay token wired). */
export class UnsupportedChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedChainError";
  }
}

interface LifiCost {
  amountUSD?: string;
  included?: boolean;
}

export interface LifiQuoteResponse {
  tool?: string;
  action?: { toToken?: { decimals?: number } };
  estimate?: {
    toAmount?: string;
    gasCosts?: LifiCost[];
    feeCosts?: LifiCost[];
  };
  message?: string;
}

function sumUsd(costs: LifiCost[] | undefined, pick: (c: LifiCost) => boolean): number {
  let total = 0;
  for (const c of costs ?? []) {
    if (!pick(c)) continue;
    const v = Number(c.amountUSD);
    if (Number.isFinite(v)) total += v;
  }
  return total;
}

export function parseLifiQuote(body: LifiQuoteResponse): RouteQuote {
  const toAmount = body.estimate?.toAmount;
  const decimals = body.action?.toToken?.decimals;
  if (!toAmount || decimals == null) {
    throw new NoRouteError(body.message ?? "LI.FI returned no estimate");
  }
  return {
    tokensOut: fromBaseUnits(toAmount, decimals),
    gasUsd: sumUsd(body.estimate?.gasCosts, () => true),
    feeUsd: sumUsd(body.estimate?.feeCosts, (c) => c.included !== false),
    tool: body.tool ?? "unknown",
    source: "lifi",
  };
}

export function createLifiQuoter(options: { fetch?: typeof fetch } = {}): RouteQuoter {
  const doFetch = options.fetch ?? fetch;
  return async ({ chainId, tokenAddress, spendUsd }) => {
    const pay = USDC[chainId];
    if (!pay) throw new UnsupportedChainError(`no USDC configured for chain ${chainId}`);
    const url = new URL(LIFI_QUOTE_URL);
    url.searchParams.set("fromChain", String(chainId));
    url.searchParams.set("toChain", String(chainId));
    url.searchParams.set("fromToken", pay.address);
    url.searchParams.set("toToken", tokenAddress);
    url.searchParams.set("fromAmount", toBaseUnits(String(spendUsd), pay.decimals));
    url.searchParams.set("fromAddress", QUOTE_ONLY_ADDRESS);
    const res = await doFetch(url, { headers: { Accept: "application/json" } });
    const body = (await res.json().catch(() => ({}))) as LifiQuoteResponse;
    if (!res.ok) throw new NoRouteError(body.message ?? `LI.FI HTTP ${res.status}`);
    return parseLifiQuote(body);
  };
}
