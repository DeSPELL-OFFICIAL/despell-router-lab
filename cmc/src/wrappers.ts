// Group the tokenized wrappers of one RWA asset. CMC lists one entry per token
// (issuer) in RWA quotes; each token can be deployed on several chains, which
// /v2/cryptocurrency/info lists under `contract_address`. A "wrapper" here is
// one token on one chain, because that is what a buyer actually routes into.

import { chainForPlatform } from "./chains.ts";
import type { CryptoInfoData, RwaAssetQuote } from "./cmc.ts";

export interface Wrapper {
  cryptoId: number;
  symbol: string;
  name: string;
  issuer: string | null;
  /** CMC price of the token in USD; null when CMC has none. */
  cmcPriceUsd: number | null;
  cmcMarketCapUsd: number | null;
  chainName: string;
  chainId: number | null;
  evm: boolean;
  address: string;
}

export function groupWrappers(asset: RwaAssetQuote, info: CryptoInfoData): Wrapper[] {
  const out: Wrapper[] = [];
  for (const token of asset.tokens) {
    const meta = info[String(token.crypto_id)];
    // Tokens without any contract address (for example CMC's derivatives
    // index entry) are not something a wallet can buy.
    const deployments = meta?.contract_address ?? [];
    for (const d of deployments) {
      const chain = chainForPlatform(d.platform.name);
      out.push({
        cryptoId: token.crypto_id,
        symbol: token.symbol ?? meta?.symbol ?? String(token.crypto_id),
        name: token.name ?? meta?.name ?? "",
        issuer: token.issuer_name,
        cmcPriceUsd: token.price,
        cmcMarketCapUsd: token.market_cap,
        chainName: d.platform.name,
        chainId: chain.chainId,
        evm: chain.evm,
        address: d.contract_address,
      });
    }
  }
  return out;
}
