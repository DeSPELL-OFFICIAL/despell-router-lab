// Minimal CoinMarketCap Pro API client for the two calls this module needs.
// Shapes follow the official reference:
//   GET /v5/real-world-assets/quotes/latest
//   GET /v2/cryptocurrency/info
// The API key is read by the caller (from the CMC_PRO_API_KEY environment
// variable) and only ever travels in the X-CMC_PRO_API_KEY header.

export const CMC_BASE_URL = "https://pro-api.coinmarketcap.com";

export interface CmcStatus {
  timestamp: string;
  error_code: number | string;
  error_message: string | null;
  elapsed: number;
  credit_count: number;
  notice?: string | null;
}

export interface CmcEnvelope<T> {
  data: T | null;
  status: CmcStatus;
}

export interface RwaToken {
  crypto_id: number;
  symbol: string | null;
  name: string | null;
  issuer_id: string | null;
  issuer_name: string | null;
  price: number | null;
  market_cap: number | null;
  volume_24h: number | null;
}

export interface RwaAssetQuote {
  rwa_id: number;
  name: string;
  symbol: string;
  slug: string;
  asset_type: "stock" | "commodity" | "currency" | "government_security" | "etf" | "real_estate";
  rwa_rank: number;
  has_tokens: boolean;
  average_tokenized_price: number | null;
  tokenized_market_cap: number | null;
  tokenized_volume_24h: number | null;
  last_updated: string;
  tokens: RwaToken[];
}

export interface RwaQuotesLatestData {
  rwa_assets: RwaAssetQuote[];
}

export interface CryptoContractAddress {
  contract_address: string;
  platform: {
    name: string;
    coin: { id: string; name: string; symbol: string; slug: string };
  };
}

export interface CryptoInfo {
  id: number;
  name: string;
  symbol: string;
  slug: string;
  platform?: {
    id: number | string;
    name: string;
    symbol: string;
    slug: string;
    token_address: string;
  } | null;
  contract_address?: CryptoContractAddress[];
}

/** Requests by `id` are keyed by the cryptocurrency id as a string. */
export type CryptoInfoData = Record<string, CryptoInfo>;

export class CmcError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, message: string, httpStatus: number) {
    super(`CoinMarketCap error ${code}: ${message}`);
    this.name = "CmcError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export interface CmcClientOptions {
  apiKey: string;
  fetch?: typeof fetch;
  baseUrl?: string;
}

export interface CmcResult<T> {
  data: T;
  status: CmcStatus;
}

export interface CmcClient {
  rwaQuotesLatest(params: { symbol?: string; rwaId?: number; slug?: string }): Promise<CmcResult<RwaQuotesLatestData>>;
  cryptoInfo(ids: number[]): Promise<CmcResult<CryptoInfoData>>;
}

export function createCmcClient(options: CmcClientOptions): CmcClient {
  if (!options.apiKey) throw new Error("CoinMarketCap API key is missing (set CMC_PRO_API_KEY)");
  const doFetch = options.fetch ?? fetch;
  const baseUrl = options.baseUrl ?? CMC_BASE_URL;

  async function get<T>(path: string, params: Record<string, string>): Promise<CmcResult<T>> {
    const url = new URL(path, baseUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await doFetch(url, {
      headers: { "X-CMC_PRO_API_KEY": options.apiKey, Accept: "application/json" },
    });
    let body: CmcEnvelope<T> | undefined;
    try {
      body = (await res.json()) as CmcEnvelope<T>;
    } catch {
      throw new CmcError(String(res.status), `non-JSON response (HTTP ${res.status})`, res.status);
    }
    const code = String(body?.status?.error_code ?? res.status);
    if (!res.ok || code !== "0" || body.data == null) {
      throw new CmcError(code, body?.status?.error_message || `HTTP ${res.status}`, res.status);
    }
    return { data: body.data, status: body.status };
  }

  return {
    rwaQuotesLatest(params) {
      const q: Record<string, string> = {};
      if (params.rwaId != null) q.rwa_id = String(params.rwaId);
      else if (params.slug) q.rwa_slug = params.slug;
      else if (params.symbol) q.symbol = params.symbol;
      else throw new Error("rwaQuotesLatest needs symbol, rwaId or slug");
      return get<RwaQuotesLatestData>("/v5/real-world-assets/quotes/latest", q);
    },
    cryptoInfo(ids) {
      if (ids.length === 0) throw new Error("cryptoInfo needs at least one id");
      return get<CryptoInfoData>("/v2/cryptocurrency/info", {
        id: ids.join(","),
        aux: "platform",
        skip_invalid: "true",
      });
    },
  };
}
