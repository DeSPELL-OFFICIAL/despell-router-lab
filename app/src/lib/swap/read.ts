import {
  decodeEventLog,
  encodeFunctionData,
  isAddressEqual,
  type Address,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { simulateCalls } from "viem/actions";
import { erc20Abi, mockMintAbi, permit2Abi, stateViewAbi, swapRouter02Abi, v4PoolManagerSwapEvent, v4QuoterAbi, wethWithdrawalEvent } from "./abi";
import type { SwapChain } from "./chains";
import { ROUTER_KEEPS_OUTPUT, type Quote, type Step, type SwapPlan, type WalletState } from "./plan";

/*
  Everything the card reads from a chain. Reads only: nothing here signs or
  sends. Quotes and simulations run on the chain's public RPC.
*/

/** Address that only ever appears in read-only simulations (no key exists for it). */
const PROBE: Address = "0x00000000000000000000000000000000DE5BE11a";

export async function readQuote(client: PublicClient, chain: SwapChain, amountIn: bigint): Promise<Quote> {
  const block = await client.getBlockNumber({ cacheTime: 0 });
  if (chain.dex === "uniswap-v4") {
    const [{ result }, slot0] = await Promise.all([
      client.simulateContract({
        address: chain.quoter,
        abi: v4QuoterAbi,
        functionName: "quoteExactInputSingle",
        args: [{ poolKey: chain.pool.key, zeroForOne: false, exactAmount: amountIn, hookData: "0x" }],
        blockNumber: block,
      }),
      client.readContract({ address: chain.stateView, abi: stateViewAbi, functionName: "getSlot0", args: [chain.pool.id], blockNumber: block }),
    ]);
    return { chainId: chain.id, amountIn, expectedOut: result[0], block, at: Date.now(), lpFee: slot0[3] };
  }
  // No Uniswap quoter on GIWA Sepolia points at this factory, so the quote is the swap itself, simulated:
  // a probe address mints the mock USDC (anyone can), approves the router and swaps. Nothing is sent.
  const sim = await simulateCalls(client, {
    account: PROBE,
    blockNumber: block,
    calls: [
      { to: chain.usdc.address, data: encodeFunctionData({ abi: mockMintAbi, functionName: "mint", args: [PROBE, amountIn] }) },
      { to: chain.usdc.address, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [chain.swapRouter02, amountIn] }) },
      {
        to: chain.swapRouter02,
        data: encodeFunctionData({
          abi: swapRouter02Abi,
          functionName: "exactInputSingle",
          args: [{ tokenIn: chain.usdc.address, tokenOut: chain.weth, fee: chain.pool.fee, recipient: ROUTER_KEEPS_OUTPUT, amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }],
        }),
      },
    ],
  });
  const swap = sim.results[2];
  if (!swap || swap.status !== "success") throw new Error("GIWA quote simulation reverted");
  const [expectedOut] = decodeUint256(swap.data);
  return { chainId: chain.id, amountIn, expectedOut, block, at: Date.now(), lpFee: chain.pool.fee };
}

function decodeUint256(data: `0x${string}`): [bigint] {
  if (data.length < 66) throw new Error("Short return data");
  return [BigInt(data.slice(0, 66))];
}

export async function readWallet(client: PublicClient, chain: SwapChain, account: Address): Promise<WalletState & { ethBalance: bigint }> {
  const spender = chain.dex === "uniswap-v4" ? chain.permit2 : chain.swapRouter02;
  const [usdcBalance, erc20Allowance, ethBalance, permit2] = await Promise.all([
    client.readContract({ address: chain.usdc.address, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
    client.readContract({ address: chain.usdc.address, abi: erc20Abi, functionName: "allowance", args: [account, spender] }),
    client.getBalance({ address: account }),
    chain.dex === "uniswap-v4"
      ? client.readContract({ address: chain.permit2, abi: permit2Abi, functionName: "allowance", args: [account, chain.usdc.address, chain.universalRouter] })
      : Promise.resolve(undefined),
  ]);
  return {
    account,
    usdcBalance,
    erc20Allowance,
    ethBalance,
    permit2: permit2 ? { amount: permit2[0], expiration: permit2[1] } : undefined,
  };
}

const STEP_NAME: Record<Step["kind"], string> = { approve: "approve", "permit2-approve": "Permit2 allowance", swap: "swap" };

export type Simulation =
  | {
      ok: true;
      planId: `0x${string}`;
      block: bigint;
      /** ETH the account ends with minus what it started with (gas is not charged in a simulation). */
      ethDelta: bigint;
      usdcDelta: bigint;
      gas: bigint;
      gasPrice: bigint;
    }
  | { ok: false; planId: `0x${string}`; block: bigint | null; reason: string };

/**
 * Runs the plan's remaining transactions, in order, from the signer's address on the latest block
 * (eth_simulateV1). Passes only when every call succeeds, exactly the swap amount of USDC leaves,
 * and at least the signed minimum of ETH arrives.
 *
 * `minBlock`: simulate no earlier than this block (the block of the approval just confirmed). Public
 * RPCs sit behind load balancers, and a node a block behind would not see that approval yet.
 */
export async function simulatePlan(client: PublicClient, chain: SwapChain, plan: SwapPlan, from = 0, minBlock?: bigint): Promise<Simulation> {
  const steps: readonly Step[] = plan.steps.slice(from);
  let block: bigint | null = null;
  try {
    const latest = await client.getBlockNumber({ cacheTime: 0 });
    block = minBlock !== undefined && minBlock > latest ? minBlock : latest;
    const [sim, gasPrice] = await Promise.all([
      simulateCalls(client, {
        account: plan.account,
        blockNumber: block,
        calls: steps.map((s) => ({ to: s.tx.to, data: s.tx.data, value: s.tx.value })),
        traceAssetChanges: true,
      }),
      client.getGasPrice(),
    ]);
    const failed = sim.results.findIndex((r) => r.status !== "success");
    if (failed !== -1) {
      const step = steps[failed];
      return { ok: false, planId: plan.id, block, reason: `Step ${from + failed + 1} of ${plan.steps.length} (${STEP_NAME[step.kind]}) would revert` };
    }
    const eth = sim.assetChanges.find((c) => isAddressEqual(c.token.address, "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"));
    const usdc = sim.assetChanges.find((c) => isAddressEqual(c.token.address, chain.usdc.address));
    const ethDelta = eth?.value.diff ?? 0n;
    const usdcDelta = usdc?.value.diff ?? 0n;
    if (usdcDelta !== -plan.amountIn) {
      return { ok: false, planId: plan.id, block, reason: `Simulation moved ${usdcDelta} USDC units, the card says ${-plan.amountIn}` };
    }
    if (ethDelta < plan.minOut) {
      return { ok: false, planId: plan.id, block, reason: "Simulation receives less ETH than the minimum on the card" };
    }
    const gas = sim.results.reduce((sum, r) => sum + r.gasUsed, 0n);
    return { ok: true, planId: plan.id, block, ethDelta, usdcDelta, gas, gasPrice };
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return { ok: false, planId: plan.id, block, reason: `Simulation could not run: ${message}` };
  }
}

/** ETH the swap paid out, read from the swap transaction's own logs. */
export function receivedFromReceipt(chain: SwapChain, receipt: TransactionReceipt): bigint | null {
  for (const log of receipt.logs) {
    try {
      if (chain.dex === "uniswap-v4") {
        const ev = decodeEventLog({ abi: v4PoolManagerSwapEvent, data: log.data, topics: log.topics });
        // amount0 is the ETH side of the swap; the PoolManager emits the swapper's delta (positive = paid out).
        if (ev.args.id === chain.pool.id) return ev.args.amount0 < 0n ? -ev.args.amount0 : ev.args.amount0;
      } else if (isAddressEqual(log.address, chain.weth)) {
        // unwrapWETH9 turns the router's WETH into the ETH it sends on, in one Withdrawal.
        const ev = decodeEventLog({ abi: wethWithdrawalEvent, data: log.data, topics: log.topics });
        if (isAddressEqual(ev.args.src, chain.swapRouter02)) return ev.args.wad;
      }
    } catch {
      // Not the event we look for.
    }
  }
  return null;
}
