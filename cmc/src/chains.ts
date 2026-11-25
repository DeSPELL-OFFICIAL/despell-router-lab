// CoinMarketCap names chains by platform name. Route quotes need EVM chain ids
// and a USDC to pay with on that chain.

export interface ChainInfo {
  /** EVM chain id, or null when the chain is not EVM or not known here. */
  chainId: number | null;
  evm: boolean;
}

// Keyed by CMC `contract_address[].platform.name`, as returned by
// /v2/cryptocurrency/info.
const PLATFORMS: Record<string, ChainInfo> = {
  "Ethereum": { chainId: 1, evm: true },
  "BNB Smart Chain (BEP20)": { chainId: 56, evm: true },
  "Arbitrum": { chainId: 42161, evm: true },
  "Base": { chainId: 8453, evm: true },
  "Polygon": { chainId: 137, evm: true },
  "Optimism": { chainId: 10, evm: true },
  "Avalanche C-Chain": { chainId: 43114, evm: true },
  "Ink": { chainId: 57073, evm: true },
  "X Layer": { chainId: 196, evm: true },
  "HyperEVM": { chainId: 999, evm: true },
  "Mantle": { chainId: 5000, evm: true },
  // EVM, but no public route quote source is wired for it yet.
  "Robinhood Chain": { chainId: null, evm: true },
  "Solana": { chainId: null, evm: false },
  "TON": { chainId: null, evm: false },
  "Tron20": { chainId: null, evm: false },
};

export function chainForPlatform(platformName: string): ChainInfo {
  const known = PLATFORMS[platformName];
  if (known) return known;
  // Unknown names are treated as unsupported rather than guessed.
  return { chainId: null, evm: false };
}

export interface PayToken {
  address: string;
  decimals: number;
}

/** Native USDC per chain, used as the "pay $100 with" token for quotes. */
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
