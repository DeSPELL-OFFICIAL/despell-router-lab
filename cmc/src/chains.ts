// CoinMarketCap names chains by platform name. Route quotes need EVM chain ids
// and a USDC to pay with on that chain.

export type ChainKind = "evm" | "non_evm" | "unknown";

export interface ChainInfo {
  /** EVM chain id, or null when the chain is not EVM or not wired here. */
  chainId: number | null;
  kind: ChainKind;
}

// Keyed by CMC `contract_address[].platform.name`, as returned by
// /v2/cryptocurrency/info.
const PLATFORMS: Record<string, ChainInfo> = {
  "Ethereum": { chainId: 1, kind: "evm" },
  "BNB Smart Chain (BEP20)": { chainId: 56, kind: "evm" },
  "Arbitrum": { chainId: 42161, kind: "evm" },
  "Base": { chainId: 8453, kind: "evm" },
  "Polygon": { chainId: 137, kind: "evm" },
  "Optimism": { chainId: 10, kind: "evm" },
  "Avalanche C-Chain": { chainId: 43114, kind: "evm" },
  "Ink": { chainId: 57073, kind: "evm" },
  "X Layer": { chainId: 196, kind: "evm" },
  "HyperEVM": { chainId: 999, kind: "evm" },
  // EVM, but no public route quote source is wired for it yet.
  "Robinhood Chain": { chainId: null, kind: "evm" },
  "Solana": { chainId: null, kind: "non_evm" },
  "TON": { chainId: null, kind: "non_evm" },
  "Tron20": { chainId: null, kind: "non_evm" },
};

export function chainForPlatform(platformName: string): ChainInfo {
  // Names not listed are not guessed as EVM or non-EVM; they are reported as
  // an unsupported chain until someone adds them here.
  return PLATFORMS[platformName] ?? { chainId: null, kind: "unknown" };
}

export interface PayToken {
  address: string;
  decimals: number;
}

/**
 * The USDC used as "pay $100 with" on each chain. Circle-native USDC where it
 * exists; on BNB Smart Chain it is Binance-Peg USDC (18 decimals), and on
 * X Layer a bridged USDC, so the spend there is only as good as that peg.
 */
export const USDC: Record<number, PayToken> = {
  1: { address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", decimals: 6 },
  56: { address: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", decimals: 18 },
  42161: { address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", decimals: 6 },
  8453: { address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6 },
  137: { address: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", decimals: 6 },
  10: { address: "0x0b2c639c533813f4aa9d7837caf62653d097ff85", decimals: 6 },
  43114: { address: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", decimals: 6 },
  57073: { address: "0x2d270e6886d130d724215a266106e6832161eaed", decimals: 6 },
  196: { address: "0x74b7f16337b8972027f6196a17a631ac6de26d22", decimals: 6 },
  999: { address: "0xb88339cb7199b77e23db6e890353e22632ba630f", decimals: 6 },
};
