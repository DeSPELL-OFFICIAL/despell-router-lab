import { encodeAbiParameters, encodeEventTopics, parseAbiParameters, type Log, type TransactionReceipt } from "viem";
import { describe, expect, it } from "vitest";
import { v4PoolManagerSwapEvent, wethWithdrawalEvent } from "./abi";
import { BASE_SEPOLIA, GIWA_SEPOLIA } from "./chains";
import { receivedFromReceipt } from "./read";

const receipt = (logs: Partial<Log>[]) => ({ logs }) as unknown as TransactionReceipt;
const POOL_MANAGER = "0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408";

describe("receivedFromReceipt", () => {
  it("reads the ETH side of our v4 pool's Swap event", () => {
    const topics = encodeEventTopics({ abi: v4PoolManagerSwapEvent, eventName: "Swap", args: { id: BASE_SEPOLIA.pool.id, sender: BASE_SEPOLIA.universalRouter } });
    const data = encodeAbiParameters(parseAbiParameters("int128, int128, uint160, uint128, int24, uint24"), [6_045_433_325_479_375n, -10_000_000n, 1n, 1n, -202_200, 500]);
    expect(receivedFromReceipt(BASE_SEPOLIA, receipt([{ address: POOL_MANAGER, topics: topics as Log["topics"], data }]))).toBe(6_045_433_325_479_375n);
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
