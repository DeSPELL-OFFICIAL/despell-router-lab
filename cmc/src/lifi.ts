// Route cost from LI.FI's public quote API (no key). We ask: "pay this much
// USDC on chain X, receive token T on chain X" and read how many tokens come
// out and what the route costs on top. Nothing is signed or sent; the
// fromAddress below is only a placeholder LI.FI requires to build a quote.
// Reference: https://docs.li.fi/api-reference/get-a-quote-for-a-token-transfer

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
  /** Network gas the sender pays on top, in USD. */
  gasUsd: number;
  /** Fees the sender pays on top of the spend (`included: false`), in USD. */
  extraFeeUsd: number;
  /** Fees already taken out of tokensOut (`included: true`), in USD. Display only. */
  feeUsd: number;
  /** Which DEX or aggregator LI.FI picked. */
  tool: string;
  source: "lifi";
}

export type RouteQuoter = (req: QuoteRequest) => Promise<RouteQuote>;

/** The quote source answered, and it has no route for this pair. */
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

/** The quote could not be fetched (rate limit, server error, network). Says nothing about the route. */
export class QuoteFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuoteFailedError";
  }
}

/** A quote came back, but without the cost fields needed to price it fully. */
export class QuoteIncompleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuoteIncompleteError";
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

/** A cost's USD amount, or null when it is missing, not a number, or negative. */
const usdOf = (c: LifiCost): number | null => {
  if (c.amountUSD == null || c.amountUSD === "") return null;
  const v = Number(c.amountUSD);
  return Number.isFinite(v) && v >= 0 ? v : null;
};

export function parseLifiQuote(body: LifiQuoteResponse): RouteQuote {
  const toAmount = body.estimate?.toAmount;
  const decimals = body.action?.toToken?.decimals;
  if (!toAmount || decimals == null) {
    throw new QuoteFailedError(body.message ?? "LI.FI returned no estimate");
  }

  // Missing cost fields must not quietly count as $0 or as "already included":
  // both would favour this route. Such a quote is incomplete instead.
  const gasCosts = body.estimate?.gasCosts ?? [];
  if (gasCosts.length === 0) throw new QuoteIncompleteError("quote has no gas cost");
  let gasUsd = 0;
  for (const g of gasCosts) {
    const v = usdOf(g);
    if (v == null) throw new QuoteIncompleteError("a gas cost has no valid USD amount");
    gasUsd += v;
  }
  let feeUsd = 0;
  let extraFeeUsd = 0;
  for (const f of body.estimate?.feeCosts ?? []) {
    const v = usdOf(f);
    if (v == null) throw new QuoteIncompleteError("a fee has no valid USD amount");
    // LI.FI: `included: true` is already in the quoted amounts; `false` is paid on top of fromAmount.
    if (f.included === true) feeUsd += v;
    else if (f.included === false) extraFeeUsd += v;
    else throw new QuoteIncompleteError("a fee does not say whether it is included");
  }

  return {
    tokensOut: fromBaseUnits(toAmount, decimals),
    gasUsd,
    extraFeeUsd,
    feeUsd,
    tool: body.tool ?? "unknown",
    source: "lifi",
  };
}

/** Longest wait honoured from a 429's Retry-After before the single retry. */
const MAX_RETRY_WAIT_MS = 5_000;
const DEFAULT_RETRY_WAIT_MS = 1_000;

function retryWaitMs(res: Response): number {
  const header = Number(res.headers.get("retry-after"));
  return Number.isFinite(header) && header >= 0 ? Math.min(header * 1000, MAX_RETRY_WAIT_MS) : DEFAULT_RETRY_WAIT_MS;
}

export function createLifiQuoter(
  options: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
): RouteQuoter {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return async ({ chainId, tokenAddress, spendUsd }) => {
    const pay = USDC[chainId];
    if (!pay) throw new UnsupportedChainError(`no USDC configured for chain ${chainId}`);
    const url = new URL(LIFI_QUOTE_URL);
    url.searchParams.set("fromChain", String(chainId));
    url.searchParams.set("toChain", String(chainId));
    url.searchParams.set("fromToken", pay.address);
    url.searchParams.set("toToken", tokenAddress);
    url.searchParams.set("fromAmount", toBaseUnits(spendUsd.toFixed(pay.decimals), pay.decimals));
    url.searchParams.set("fromAddress", QUOTE_ONLY_ADDRESS);

    const request = async (): Promise<Response> => {
      try {
        return await doFetch(url, { headers: { Accept: "application/json" } });
      } catch (err) {
        throw new QuoteFailedError(`LI.FI request failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    let res = await request();
    // Rate limited: wait as asked (capped) and try once more; a second 429 is a failed quote.
    if (res.status === 429) {
      await sleep(retryWaitMs(res));
      res = await request();
    }
    const body = (await res.json().catch(() => ({}))) as LifiQuoteResponse;
    // 404 is LI.FI's QuoteNotFound. Anything else that is not OK (429 rate
    // limit, 5xx, 400) tells us nothing about whether a route exists.
    if (res.status === 404) throw new NoRouteError(body.message ?? "LI.FI found no route");
    if (!res.ok) throw new QuoteFailedError(`LI.FI HTTP ${res.status}${body.message ? `: ${body.message}` : ""}`);
    return parseLifiQuote(body);
  };
}
