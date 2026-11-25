import { getAddress, type Address, type Hex } from "viem";

/*
  The two test-network swaps the lab card runs, with every address it may
  send a transaction to. All values are public: contract addresses from
  Uniswap's deployment list and the explorers, and the test pools and
  PoolGuard recorded in reactive/deployments/.

  A plan may only target the addresses listed under `targets`, and on Base
  Sepolia only swap through a pool listed under `pools`; the plan builder,
  the decoder and the tests all check that.
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

/** A Uniswap v4 pool a Base Sepolia quote may route through. */
export type V4Pool = {
  id: Hex;
  /** Name on the card, e.g. "test pool A". */
  label: string;
  key: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
};

export type BaseSepoliaSwap = Common & {
  id: typeof BASE_SEPOLIA_ID;
  dex: "uniswap-v4";
  permit2: Address;
  universalRouter: Address;
  quoter: Address;
  stateView: Address;
  /** Every pool a quote may use. The quote takes the one that pays the most among those it is allowed. */
  pools: readonly V4Pool[];
  /** PoolGuard: read only. Reactive marks a pool here when its settings change (reactive/reflex). */
  poolGuard: Address;
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
const BASE_SEPOLIA_USDC = getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
/** The test pools' hook: it sets each pool's LP fee and emits FeeUpdated, which PoolReflex watches for every pool on it. */
const FEE_HOOK = getAddress("0x18813Bc0B1954490e751e6800Ae5E9d8C5D09000");
/** Uniswap v4's flag for a fee the hook sets (LPFeeLibrary.DYNAMIC_FEE_FLAG). */
const DYNAMIC_FEE = 0x800000;

export const BASE_SEPOLIA: BaseSepoliaSwap = {
  id: BASE_SEPOLIA_ID,
  name: "Base Sepolia",
  explorer: "https://sepolia.basescan.org",
  dex: "uniswap-v4",
  usdc: { address: BASE_SEPOLIA_USDC, symbol: "USDC", decimals: 6, label: "USDC" },
  faucet: { kind: "link", href: "https://faucet.circle.com", label: "Circle faucet" },
  // https://docs.uniswap.org/contracts/v4/deployments (Base Sepolia, Universal Router 2.1.2)
  permit2: getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3"),
  universalRouter: getAddress("0x8702463e73f74d0b6765aBceb314Ef07aCb92650"),
  quoter: getAddress("0x5e6B8B8AFA7e5CEF6C09dd2A67aBA9FB12C75623"),
  stateView: getAddress("0x571291b572ed32ce6751a2Cb2486EbEe8DEfB9B4"),
  // Two ETH/USDC test pools on the same hook, so PoolReflex watches both: A (reactive/deployments/base-sepolia.json)
  // and B, the quote's second route (reactive/script/LaunchSecondPool.s.sol). Ids are keccak256 of the keys (chains.test.ts).
  pools: [
    {
      id: "0xfbce48fa376e45019cf2c5d4afbe45e0fbf19dd3ad442162431aad7519adbbb4",
      label: "test pool A",
      key: { currency0: ETH, currency1: BASE_SEPOLIA_USDC, fee: DYNAMIC_FEE, tickSpacing: 10, hooks: FEE_HOOK },
    },
    {
      id: "0xa7692fed527766fb44a78fb84faffa4cc759bb29002969b87e571366db28efc2",
      label: "test pool B",
      key: { currency0: ETH, currency1: BASE_SEPOLIA_USDC, fee: DYNAMIC_FEE, tickSpacing: 60, hooks: FEE_HOOK },
    },
  ],
  // reactive/deployments/reflex.json
  poolGuard: getAddress("0xcF269776640D3D19C9c515f3eEAF1DaD53d88378"),
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

/** The listed Base Sepolia pool with this id, if any. */
export function v4Pool(chain: BaseSepoliaSwap, id: Hex | undefined): V4Pool | undefined {
  return id === undefined ? undefined : chain.pools.find((p) => p.id.toLowerCase() === id.toLowerCase());
}

export function txUrl(chain: SwapChain, hash: Hex): string {
  return `${chain.explorer}/tx/${hash}`;
}
