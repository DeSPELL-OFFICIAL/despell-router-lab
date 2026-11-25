import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  encodeAbiParameters,
  encodeEventTopics,
  parseAbiParameters,
  type Hex,
  type Log,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { describe, expect, it } from "vitest";
import { v4PoolManagerSwapEvent, v4QuoterAbi, wethWithdrawalEvent } from "./abi";
import { BASE_SEPOLIA, GIWA_SEPOLIA } from "./chains";
import { NoRouteError, readQuote, receivedFromReceipt } from "./read";

const receipt = (logs: Partial<Log>[]) => ({ logs }) as unknown as TransactionReceipt;
const POOL_MANAGER = "0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408";

describe("receivedFromReceipt", () => {
  it("reads the ETH side of our v4 pool's Swap event", () => {
    const topics = encodeEventTopics({ abi: v4PoolManagerSwapEvent, eventName: "Swap", args: { id: BASE_SEPOLIA.pools[0].id, sender: BASE_SEPOLIA.universalRouter } });
    const data = encodeAbiParameters(parseAbiParameters("int128, int128, uint160, uint128, int24, uint24"), [6_045_433_325_479_375n, -10_000_000n, 1n, 1n, -202_200, 500]);
    expect(receivedFromReceipt(BASE_SEPOLIA, receipt([{ address: POOL_MANAGER, topics: topics as Log["topics"], data }]))).toBe(6_045_433_325_479_375n);
  });

  it("reads the second pool's Swap event too", () => {
    const topics = encodeEventTopics({ abi: v4PoolManagerSwapEvent, eventName: "Swap", args: { id: BASE_SEPOLIA.pools[1].id, sender: BASE_SEPOLIA.universalRouter } });
    const data = encodeAbiParameters(parseAbiParameters("int128, int128, uint160, uint128, int24, uint24"), [5_957_655_435_845_387n, -10_000_000n, 1n, 1n, -202_140, 500]);
    expect(receivedFromReceipt(BASE_SEPOLIA, receipt([{ address: POOL_MANAGER, topics: topics as Log["topics"], data }]))).toBe(5_957_655_435_845_387n);
  });

  it("ignores a Swap event from another pool", () => {
    const topics = encodeEventTopics({ abi: v4PoolManagerSwapEvent, eventName: "Swap", args: { id: `0x${"11".repeat(32)}`, sender: BASE_SEPOLIA.universalRouter } });
    const data = encodeAbiParameters(parseAbiParameters("int128, int128, uint160, uint128, int24, uint24"), [5n, -5n, 1n, 1n, 0, 500]);
    expect(receivedFromReceipt(BASE_SEPOLIA, receipt([{ address: POOL_MANAGER, topics: topics as Log["topics"], data }]))).toBeNull();
  });

  it("reads the router's WETH unwrap on GIWA", () => {
    const topics = encodeEventTopics({ abi: wethWithdrawalEvent, eventName: "Withdrawal", args: { src: GIWA_SEPOLIA.swapRouter02 } });
    const data = encodeAbiParameters(parseAbiParameters("uint256"), [3_835_057_891_295_149n]);
    expect(receivedFromReceipt(GIWA_SEPOLIA, receipt([{ address: GIWA_SEPOLIA.weth, topics: topics as Log["topics"], data }]))).toBe(3_835_057_891_295_149n);
  });
});

describe("readQuote on Base Sepolia", () => {
  const [A, B] = BASE_SEPOLIA.pools;
  type Answer = bigint | "revert" | "rpc";

  function revert(): never {
    throw new ContractFunctionExecutionError(new ContractFunctionRevertedError({ abi: v4QuoterAbi, functionName: "quoteExactInputSingle", message: "NotEnoughLiquidity" }), {
      abi: v4QuoterAbi,
      functionName: "quoteExactInputSingle",
      args: [],
      contractAddress: BASE_SEPOLIA.quoter,
    });
  }

  /** A client whose quoter answers per pool (found by tick spacing), and whose StateView gives each pool's LP fee. */
  function client(answers: Record<string, Answer>, blocks: bigint[] = []) {
    const pool = (spacing: number) => BASE_SEPOLIA.pools.find((p) => p.key.tickSpacing === spacing)!;
    return {
      getBlockNumber: async () => 100n,
      simulateContract: async ({ args, blockNumber }: { args: [{ poolKey: { tickSpacing: number } }]; blockNumber: bigint }) => {
        blocks.push(blockNumber);
        const a = answers[pool(args[0].poolKey.tickSpacing).id];
        if (a === "revert") revert();
        if (a === "rpc" || a === undefined) throw new Error("fetch failed");
        return { result: [a, 1n] };
      },
      readContract: async ({ args, blockNumber }: { args: [Hex]; blockNumber: bigint }) => {
        blocks.push(blockNumber);
        return [1n, 0, 0, args[0] === A.id ? 500 : 3000];
      },
    } as unknown as PublicClient;
  }

  it("quotes every pool at one block and keeps the one that pays the most", async () => {
    const blocks: bigint[] = [];
    const q = await readQuote(client({ [A.id]: 6_009_206_251_882_248n, [B.id]: 5_957_655_435_845_387n }, blocks), BASE_SEPOLIA, 10_000_000n);
    expect(q).toMatchObject({ pool: A.id, expectedOut: 6_009_206_251_882_248n, lpFee: 500, block: 100n });
    expect(blocks).toEqual([100n, 100n, 100n, 100n]);
    const better = await readQuote(client({ [A.id]: 1n, [B.id]: 2n }), BASE_SEPOLIA, 10_000_000n);
    expect(better).toMatchObject({ pool: B.id, lpFee: 3000 });
  });

  it("leaves out the pools it is told to, in any letter case", async () => {
    const q = await readQuote(client({ [A.id]: 6n, [B.id]: 5n }), BASE_SEPOLIA, 10_000_000n, [A.id.toUpperCase().replace("0X", "0x") as Hex]);
    expect(q.pool).toBe(B.id);
  });

  it("drops a pool the quoter reverts on (not launched yet, too little liquidity)", async () => {
    const q = await readQuote(client({ [A.id]: 6n, [B.id]: "revert" }), BASE_SEPOLIA, 10_000_000n);
    expect(q.pool).toBe(A.id);
  });

  it("has no route when every pool is left out or none can fill", async () => {
    await expect(readQuote(client({ [A.id]: 6n, [B.id]: 5n }), BASE_SEPOLIA, 10_000_000n, [A.id, B.id])).rejects.toThrow(NoRouteError);
    await expect(readQuote(client({ [A.id]: "revert" }), BASE_SEPOLIA, 10_000_000n, [B.id])).rejects.toThrow("no pool left can fill");
  });

  // An RPC failure is not a pool that cannot fill: quietly routing around it would pick a pool for the wrong reason.
  it("fails the whole quote when a read fails", async () => {
    const err = await readQuote(client({ [A.id]: "rpc", [B.id]: 5n }), BASE_SEPOLIA, 10_000_000n).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NoRouteError);
  });
});
