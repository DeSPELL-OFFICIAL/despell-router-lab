import { concatHex, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, numberToHex, stringToHex, type Address, type Hex } from "viem";
import {
  erc20Abi,
  permit2Abi,
  swapRouter02Abi,
  universalRouterAbi,
  v4ExactInSingle,
  v4SettleAll,
  v4SwapInput,
  v4Take,
} from "./abi";
import { targets, type BaseSepoliaSwap, type GiwaSepoliaSwap, type SwapChain } from "./chains";

/*
  The quote object. One plan holds the quote the card shows and the exact
  transactions the wallet will be asked to sign, built together from the
  same numbers. The card never formats a separate copy of these values: it
  decodes them back out of `steps[].tx` (see decode.ts), so what the card
  says is what the bytes say.

  Approvals cover this swap's amount only. A step is skipped when the
  wallet's current allowance already covers the amount; it is never raised
  above the amount.
*/

export type Tx = { to: Address; data: Hex; value: bigint };

export type StepKind = "approve" | "permit2-approve" | "swap";
export type Step = { kind: StepKind; tx: Tx };

export type Quote = {
  chainId: number;
  amountIn: bigint;
  /** Expected ETH out (wei) for amountIn, from the quoter or a simulation of the swap. */
  expectedOut: bigint;
  /** Block the quote was read at. */
  block: bigint;
  /** ms since epoch, client clock. */
  at: number;
  /** LP fee in hundredths of a bip (500 = 0.05%). */
  lpFee: number;
};

/** What the wallet holds right now, read just before building the plan. */
export type WalletState = {
  account: Address;
  usdcBalance: bigint;
  /** ERC-20 allowance from the account to Permit2 (v4) or to SwapRouter02 (v3). */
  erc20Allowance: bigint;
  /** v4 only: Permit2 allowance from the account to the Universal Router. */
  permit2?: { amount: bigint; expiration: number };
};

export type SwapPlan = {
  id: Hex;
  chainId: number;
  account: Address;
  amountIn: bigint;
  expectedOut: bigint;
  minOut: bigint;
  slippageBps: number;
  /** Unix seconds. The swap reverts after this. */
  deadline: number;
  quote: Quote;
  steps: readonly Step[];
};

export const SLIPPAGE_BPS = 50;
/** How long the swap transaction stays valid after the plan is built. */
export const DEADLINE_SECONDS = 15 * 60;
/** How long a fresh Permit2 allowance lasts. */
export const PERMIT2_EXPIRY_SECONDS = 30 * 60;

/** Universal Router command and V4Router action ids (Commands.sol, Actions.sol). */
export const V4_SWAP = 0x10;
export const ACTION = { SWAP_EXACT_IN_SINGLE: 0x06, SETTLE_ALL: 0x0c, TAKE: 0x0e } as const;
/** SwapRouter02 recipient flag: keep the output in the router (unwrapWETH9 pays it out). */
export const ROUTER_KEEPS_OUTPUT: Address = "0x0000000000000000000000000000000000000002";

export function minOutFor(expectedOut: bigint, slippageBps = SLIPPAGE_BPS): bigint {
  return (expectedOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

const approve = (token: Address, spender: Address, amount: bigint): Tx => ({
  to: token,
  data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
  value: 0n,
});

function v4Steps(chain: BaseSepoliaSwap, wallet: WalletState, amountIn: bigint, minOut: bigint, deadline: number, nowSec: number): Step[] {
  const steps: Step[] = [];
  if (wallet.erc20Allowance < amountIn) {
    steps.push({ kind: "approve", tx: approve(chain.usdc.address, chain.permit2, amountIn) });
  }
  const p2 = wallet.permit2;
  // A Permit2 allowance that runs out before the deadline is renewed, for this amount only.
  if (!p2 || p2.amount < amountIn || p2.expiration < deadline) {
    steps.push({
      kind: "permit2-approve",
      tx: {
        to: chain.permit2,
        data: encodeFunctionData({
          abi: permit2Abi,
          functionName: "approve",
          args: [chain.usdc.address, chain.universalRouter, amountIn, Math.max(deadline, nowSec + PERMIT2_EXPIRY_SECONDS)],
        }),
        value: 0n,
      },
    });
  }
  const { key } = chain.pool;
  // USDC is currency1 and ETH currency0, so selling USDC is one-for-zero.
  const actions = concatHex([numberToHex(ACTION.SWAP_EXACT_IN_SINGLE, { size: 1 }), numberToHex(ACTION.SETTLE_ALL, { size: 1 }), numberToHex(ACTION.TAKE, { size: 1 })]);
  const params = [
    encodeAbiParameters(v4ExactInSingle, [{ poolKey: key, zeroForOne: false, amountIn, amountOutMinimum: minOut, hookData: "0x" }]),
    encodeAbiParameters(v4SettleAll, [key.currency1, amountIn]),
    // Pay the ETH out to the signer by address, not by the router's msg.sender flag, so the
    // recipient is visible in the signed bytes.
    encodeAbiParameters(v4Take, [key.currency0, wallet.account, 0n]),
  ];
  steps.push({
    kind: "swap",
    tx: {
      to: chain.universalRouter,
      data: encodeFunctionData({
        abi: universalRouterAbi,
        functionName: "execute",
        args: [numberToHex(V4_SWAP, { size: 1 }), [encodeAbiParameters(v4SwapInput, [actions, params])], BigInt(deadline)],
      }),
      value: 0n,
    },
  });
  return steps;
}

function v3Steps(chain: GiwaSepoliaSwap, wallet: WalletState, amountIn: bigint, minOut: bigint, deadline: number): Step[] {
  const steps: Step[] = [];
  if (wallet.erc20Allowance < amountIn) {
    steps.push({ kind: "approve", tx: approve(chain.usdc.address, chain.swapRouter02, amountIn) });
  }
  const swap = encodeFunctionData({
    abi: swapRouter02Abi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: chain.usdc.address,
        tokenOut: chain.weth,
        fee: chain.pool.fee,
        recipient: ROUTER_KEEPS_OUTPUT,
        amountIn,
        amountOutMinimum: minOut,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  // The router holds the WETH for one call, then unwraps all of it to the signer's address.
  const unwrap = encodeFunctionData({ abi: swapRouter02Abi, functionName: "unwrapWETH9", args: [minOut, wallet.account] });
  steps.push({
    kind: "swap",
    tx: {
      to: chain.swapRouter02,
      data: encodeFunctionData({ abi: swapRouter02Abi, functionName: "multicall", args: [BigInt(deadline), [swap, unwrap]] }),
      value: 0n,
    },
  });
  return steps;
}

export type BuildPlanInput = {
  chain: SwapChain;
  quote: Quote;
  wallet: WalletState;
  /** Unix seconds. */
  nowSec: number;
  slippageBps?: number;
};

export function buildPlan({ chain, quote, wallet: given, nowSec, slippageBps = SLIPPAGE_BPS }: BuildPlanInput): SwapPlan {
  const wallet = { ...given, account: getAddress(given.account) };
  if (quote.chainId !== chain.id) throw new Error("Quote is for another chain");
  if (quote.amountIn <= 0n || quote.expectedOut <= 0n) throw new Error("Empty quote");
  const minOut = minOutFor(quote.expectedOut, slippageBps);
  if (minOut <= 0n) throw new Error("Minimum received rounds to zero");
  const deadline = nowSec + DEADLINE_SECONDS;
  const steps = chain.dex === "uniswap-v4" ? v4Steps(chain, wallet, quote.amountIn, minOut, deadline, nowSec) : v3Steps(chain, wallet, quote.amountIn, minOut, deadline);
  const allowed = new Set(targets(chain));
  for (const step of steps) {
    if (!allowed.has(step.tx.to)) throw new Error(`Plan targets an unlisted contract: ${step.tx.to}`);
    if (step.tx.value !== 0n) throw new Error("Plan sends ETH");
  }
  const id = keccak256(
    stringToHex(JSON.stringify([chain.id, wallet.account, steps.map((s) => [s.kind, s.tx.to, s.tx.data])])),
  );
  return { id, chainId: chain.id, account: wallet.account, amountIn: quote.amountIn, expectedOut: quote.expectedOut, minOut, slippageBps, deadline, quote, steps };
}
