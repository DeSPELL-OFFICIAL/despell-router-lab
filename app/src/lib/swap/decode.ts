import { decodeAbiParameters, decodeFunctionData, getAddress, isAddressEqual, numberToHex, type Address, type Hex } from "viem";
import { erc20Abi, permit2Abi, swapRouter02Abi, universalRouterAbi, v4ExactInSingle, v4SettleAll, v4SwapInput, v4Take } from "./abi";
import type { SwapChain } from "./chains";
import { ACTION, ROUTER_KEEPS_OUTPUT, V4_SWAP, type Step } from "./plan";

/*
  Reads a plan's transactions back from their bytes. The card shows only what
  this returns, so the sends, minimum received, recipient and approval
  amounts on screen are the ones the wallet will sign. Anything outside the
  exact shapes plan.ts builds throws instead of being shown.
*/

export type DecodedStep =
  | { kind: "approve"; to: Address; token: Address; spender: Address; amount: bigint; value: bigint }
  | { kind: "permit2-approve"; to: Address; token: Address; spender: Address; amount: bigint; expiration: number; value: bigint }
  | {
      kind: "swap";
      to: Address;
      tokenIn: Address;
      amountIn: bigint;
      /** Native ETH. */
      minOut: bigint;
      recipient: Address;
      deadline: number;
      value: bigint;
    };

export type DecodedSwap = Extract<DecodedStep, { kind: "swap" }>;

function fail(message: string): never {
  throw new Error(`Unexpected transaction: ${message}`);
}

function same(a: Address, b: Address, what: string) {
  if (!isAddressEqual(a, b)) fail(`${what} is ${a}`);
}

function decodeV4Swap(chain: Extract<SwapChain, { dex: "uniswap-v4" }>, step: Step): DecodedSwap {
  const call = decodeFunctionData({ abi: universalRouterAbi, data: step.tx.data });
  if (call.functionName !== "execute" || call.args.length !== 3) fail("not execute(commands, inputs, deadline)");
  const [commands, inputs, deadline] = call.args;
  if (commands !== numberToHex(V4_SWAP, { size: 1 }) || inputs.length !== 1) fail(`commands ${commands}`);
  const [actions, params] = decodeAbiParameters(v4SwapInput, inputs[0]);
  const expected = `0x${[ACTION.SWAP_EXACT_IN_SINGLE, ACTION.SETTLE_ALL, ACTION.TAKE].map((a) => a.toString(16).padStart(2, "0")).join("")}`;
  if (actions !== expected || params.length !== 3) fail(`actions ${actions}`);
  const [swap] = decodeAbiParameters(v4ExactInSingle, params[0]);
  const [settleCurrency, maxIn] = decodeAbiParameters(v4SettleAll, params[1]);
  const [takeCurrency, recipient, takeAmount] = decodeAbiParameters(v4Take, params[2]);
  const key = chain.pool.key;
  same(swap.poolKey.currency0, key.currency0, "pool currency0");
  same(swap.poolKey.currency1, key.currency1, "pool currency1");
  same(swap.poolKey.hooks, key.hooks, "pool hook");
  if (swap.poolKey.fee !== key.fee || swap.poolKey.tickSpacing !== key.tickSpacing) fail("pool fee or tick spacing");
  if (swap.zeroForOne !== false || swap.hookData !== "0x") fail("swap direction or hook data");
  same(settleCurrency, chain.usdc.address, "paid currency");
  if (maxIn !== swap.amountIn) fail("settle amount differs from swap amount");
  same(takeCurrency, key.currency0, "received currency");
  if (takeAmount !== 0n) fail("take amount is not the whole output");
  return {
    kind: "swap",
    to: step.tx.to,
    tokenIn: chain.usdc.address,
    amountIn: swap.amountIn,
    minOut: swap.amountOutMinimum,
    recipient: getAddress(recipient),
    deadline: Number(deadline),
    value: step.tx.value,
  };
}

function decodeV3Swap(chain: Extract<SwapChain, { dex: "uniswap-v3" }>, step: Step): DecodedSwap {
  const call = decodeFunctionData({ abi: swapRouter02Abi, data: step.tx.data });
  if (call.functionName !== "multicall" || call.args.length !== 2) fail("not multicall(deadline, data)");
  const [deadline, data] = call.args as readonly [bigint, readonly Hex[]];
  if (data.length !== 2) fail(`${data.length} inner calls`);
  const swap = decodeFunctionData({ abi: swapRouter02Abi, data: data[0] });
  const unwrap = decodeFunctionData({ abi: swapRouter02Abi, data: data[1] });
  if (swap.functionName !== "exactInputSingle") fail(`first call ${swap.functionName}`);
  if (unwrap.functionName !== "unwrapWETH9") fail(`second call ${unwrap.functionName}`);
  const [p] = swap.args;
  const [unwrapMin, recipient] = unwrap.args;
  same(p.tokenIn, chain.usdc.address, "token in");
  same(p.tokenOut, chain.weth, "token out");
  same(p.recipient, ROUTER_KEEPS_OUTPUT, "swap recipient");
  if (p.fee !== chain.pool.fee || p.sqrtPriceLimitX96 !== 0n) fail("pool fee or price limit");
  if (unwrapMin !== p.amountOutMinimum) fail("unwrap minimum differs from swap minimum");
  return {
    kind: "swap",
    to: step.tx.to,
    tokenIn: chain.usdc.address,
    amountIn: p.amountIn,
    minOut: unwrapMin,
    recipient: getAddress(recipient),
    deadline: Number(deadline),
    value: step.tx.value,
  };
}

export function decodeStep(chain: SwapChain, step: Step): DecodedStep {
  if (step.tx.value !== 0n) fail(`step sends ${step.tx.value} wei of ETH`);
  switch (step.kind) {
    case "approve": {
      const call = decodeFunctionData({ abi: erc20Abi, data: step.tx.data });
      if (call.functionName !== "approve") fail(call.functionName);
      const [spender, amount] = call.args;
      same(step.tx.to, chain.usdc.address, "approved token");
      return { kind: "approve", to: step.tx.to, token: step.tx.to, spender: getAddress(spender), amount, value: step.tx.value };
    }
    case "permit2-approve": {
      if (chain.dex !== "uniswap-v4") fail("Permit2 step on a v3 chain");
      same(step.tx.to, chain.permit2, "Permit2");
      const call = decodeFunctionData({ abi: permit2Abi, data: step.tx.data });
      if (call.functionName !== "approve") fail(call.functionName);
      const [token, spender, amount, expiration] = call.args;
      return { kind: "permit2-approve", to: step.tx.to, token: getAddress(token), spender: getAddress(spender), amount, expiration, value: step.tx.value };
    }
    case "swap":
      same(step.tx.to, chain.dex === "uniswap-v4" ? chain.universalRouter : chain.swapRouter02, "swap router");
      return chain.dex === "uniswap-v4" ? decodeV4Swap(chain, step) : decodeV3Swap(chain, step);
  }
}

export type DecodedPlan = { steps: readonly DecodedStep[]; swap: DecodedSwap };

export function decodePlan(chain: SwapChain, steps: readonly Step[]): DecodedPlan {
  const decoded = steps.map((s) => decodeStep(chain, s));
  const swaps = decoded.filter((d): d is DecodedSwap => d.kind === "swap");
  if (swaps.length !== 1 || decoded[decoded.length - 1].kind !== "swap") fail("a plan ends in exactly one swap");
  const swap = swaps[0];
  // Every approval is for this swap's token and amount, and goes to the contract the swap uses.
  for (const d of decoded) {
    if (d.kind === "approve") {
      same(d.token, swap.tokenIn, "approved token");
      if (d.amount !== swap.amountIn) fail(`approval of ${d.amount}, swap of ${swap.amountIn}`);
      same(d.spender, chain.dex === "uniswap-v4" ? chain.permit2 : chain.swapRouter02, "approval spender");
    }
    if (d.kind === "permit2-approve") {
      if (chain.dex !== "uniswap-v4") fail("Permit2 step on a v3 chain");
      same(d.token, swap.tokenIn, "Permit2 token");
      same(d.spender, chain.universalRouter, "Permit2 spender");
      if (d.amount !== swap.amountIn) fail(`Permit2 allowance of ${d.amount}, swap of ${swap.amountIn}`);
    }
  }
  return { steps: decoded, swap };
}
