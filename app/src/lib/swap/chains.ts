import { getAddress, type Address, type Hex } from "viem";

/*
  The two test-network swaps the lab card runs, with every address it may
  send a transaction to. All values are public: contract addresses from
  Uniswap's deployment list and the explorers, and the test pool DES-695
  launched (reactive/deployments/base-sepolia.json on that branch).

  A plan may only target the addresses listed under `targets`; the plan
  builder and the tests both check that.
*/

export const BASE_SEPOLIA_ID = 84532;
export const GIWA_SEPOLIA_ID = 91342;

export type SwapChainId = typeof BASE_SEPOLIA_ID | typeof GIWA_SEPOLIA_ID;

export type Token = { address: Address; symbol: string; decimals: number; label: string };

type Common = {
  id: SwapChainId;
  name: string;
  explorer: string;
  /** Token the user sends. */
  usdc: Token;
  /** Where to get test USDC on this chain. */
  faucet: { kind: "link"; href: string; label: string } | { kind: "mint"; label: string };
};

export type BaseSepoliaSwap = Common & {
  id: typeof BASE_SEPOLIA_ID;
  dex: "uniswap-v4";
  permit2: Address;
  universalRouter: Address;
  quoter: Address;
  stateView: Address;
  pool: {
    id: Hex;
    key: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
  };
};

export type GiwaSepoliaSwap = Common & {
  id: typeof GIWA_SEPOLIA_ID;
  dex: "uniswap-v3";
  weth: Address;
  swapRouter02: Address;
  pool: { address: Address; fee: number };
};

export type SwapChain = BaseSepoliaSwap | GiwaSepoliaSwap;

const ETH = "0x0000000000000000000000000000000000000000" as const;

export const BASE_SEPOLIA: BaseSepoliaSwap = {
  id: BASE_SEPOLIA_ID,
  name: "Base Sepolia",
  explorer: "https://sepolia.basescan.org",
  dex: "uniswap-v4",
  usdc: { address: getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e"), symbol: "USDC", decimals: 6, label: "USDC" },
  faucet: { kind: "link", href: "https://faucet.circle.com", label: "Circle faucet" },
  // https://docs.uniswap.org/contracts/v4/deployments (Base Sepolia, Universal Router 2.1.2)
  permit2: getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3"),
  universalRouter: getAddress("0x8702463e73f74d0b6765aBceb314Ef07aCb92650"),
  quoter: getAddress("0x5e6B8B8AFA7e5CEF6C09dd2A67aBA9FB12C75623"),
  stateView: getAddress("0x571291b572ed32ce6751a2Cb2486EbEe8DEfB9B4"),
  // The DES-695 test pool: ETH/USDC, dynamic LP fee set by our hook.
  pool: {
    id: "0xfbce48fa376e45019cf2c5d4afbe45e0fbf19dd3ad442162431aad7519adbbb4",
    key: {
      currency0: ETH,
      currency1: getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
      fee: 0x800000,
      tickSpacing: 10,
      hooks: getAddress("0x18813Bc0B1954490e751e6800Ae5E9d8C5D09000"),
    },
  },
};

export const GIWA_SEPOLIA: GiwaSepoliaSwap = {
  id: GIWA_SEPOLIA_ID,
  name: "GIWA Sepolia",
  explorer: "https://sepolia-explorer.giwa.io",
  dex: "uniswap-v3",
  // Test USDC on GIWA Sepolia is a mock token anyone can mint.
  usdc: { address: getAddress("0x0491d01B7baA35ACFD321ba73A2D4c713faE3865"), symbol: "USDC", decimals: 6, label: "USDC (Mock)" },
  faucet: { kind: "mint", label: "Mint test USDC" },
  // OP Stack predeploy WETH; the router's WETH9().
  weth: getAddress("0x4200000000000000000000000000000000000006"),
  // Uniswap V3 SwapRouter02 deployed by a GIWA launchpad (same bytecode as Uniswap's Base Sepolia deployment,
  // source verified on the GIWA explorer). Factory 0x05d2d644D2d1F2678f72cC3f6610444201CE09fc.
  swapRouter02: getAddress("0x3f3b2887f2cFA2626faea5233bBcb9Aa6F165B70"),
  pool: { address: getAddress("0xCd82487fE9943C063E3850fCEC41B9775c1017Bf"), fee: 3000 },
};

export const SWAP_CHAINS: readonly SwapChain[] = [BASE_SEPOLIA, GIWA_SEPOLIA];

export function swapChain(id: number): SwapChain {
  const chain = SWAP_CHAINS.find((c) => c.id === id);
  if (!chain) throw new Error(`Not a swap chain: ${id}`);
  return chain;
}

/** Every address a plan on this chain may send a transaction to. */
export function targets(chain: SwapChain): readonly Address[] {
  return chain.dex === "uniswap-v4"
    ? [chain.usdc.address, chain.permit2, chain.universalRouter]
    : [chain.usdc.address, chain.swapRouter02];
}

export function txUrl(chain: SwapChain, hash: Hex): string {
  return `${chain.explorer}/tx/${hash}`;
}
