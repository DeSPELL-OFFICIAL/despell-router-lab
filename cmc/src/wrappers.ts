// Group the tokenized wrappers of one RWA asset. CMC lists one entry per token
// (issuer) in RWA quotes; each token can be deployed on several chains, which
// /v2/cryptocurrency/info lists under `contract_address`. A "wrapper" here is
// one token on one chain, because that is what a buyer actually routes into.
// Tokens CMC gives no contract for are kept as a single row, so nothing listed
// by CMC silently disappears.

import { chainForPlatform, type ChainKind } from "./chains.ts";
import type { CryptoInfoData, RwaAssetQuote } from "./cmc.ts";

export type Listing =
  /** Deployed on `chainName` at `address`. */
  | "deployed"
  /** /v2/cryptocurrency/info returned nothing for this token. */
  | "no_info"
  /** Info exists but lists no contract address (for example CMC's derivatives index entry). */
  | "no_contract";

export interface Wrapper {
  cryptoId: number;
  symbol: string;
  name: string;
  issuer: string | null;
  /** CMC price of the token in USD; null when CMC has none. */
  cmcPriceUsd: number | null;
  cmcMarketCapUsd: number | null;
  cmcVolume24hUsd: number | null;
  listing: Listing;
  /** Null unless listing is "deployed". */
  chainName: string | null;
  chainId: number | null;
  chainKind: ChainKind;
  address: string | null;
}

export function groupWrappers(asset: RwaAssetQuote, info: CryptoInfoData): Wrapper[] {
  const out: Wrapper[] = [];
  for (const token of asset.tokens ?? []) {
    const meta = info[String(token.crypto_id)];
    const common = {
      cryptoId: token.crypto_id,
      symbol: token.symbol ?? meta?.symbol ?? String(token.crypto_id),
      name: token.name ?? meta?.name ?? "",
      issuer: token.issuer_name,
      cmcPriceUsd: token.price,
      cmcMarketCapUsd: token.market_cap,
      cmcVolume24hUsd: token.volume_24h,
    };
    const deployments = meta?.contract_address ?? [];
    if (deployments.length === 0) {
      out.push({
        ...common,
        listing: meta ? "no_contract" : "no_info",
        chainName: null,
        chainId: null,
        chainKind: "unknown",
        address: null,
      });
      continue;
    }
    for (const d of deployments) {
      const chain = chainForPlatform(d.platform.name);
      out.push({
        ...common,
        listing: "deployed",
        chainName: d.platform.name,
        chainId: chain.chainId,
        chainKind: chain.kind,
        address: d.contract_address,
      });
    }
  }
  return out;
}
