import { encodeAbiParameters, keccak256, parseAbiParameters } from "viem";
import { describe, expect, it } from "vitest";
import { BASE_SEPOLIA, v4Pool } from "./chains";

describe("Base Sepolia pools", () => {
  it("lists each pool under the id Uniswap v4 gives its key", () => {
    for (const pool of BASE_SEPOLIA.pools) {
      const { currency0, currency1, fee, tickSpacing, hooks } = pool.key;
      const id = keccak256(encodeAbiParameters(parseAbiParameters("address, address, uint24, int24, address"), [currency0, currency1, fee, tickSpacing, hooks]));
      expect(id).toBe(pool.id);
    }
  });

  it("finds a pool by id in any letter case, and nothing for an unlisted id", () => {
    const [a] = BASE_SEPOLIA.pools;
    expect(v4Pool(BASE_SEPOLIA, a.id.toUpperCase().replace("0X", "0x") as `0x${string}`)).toBe(a);
    expect(v4Pool(BASE_SEPOLIA, `0x${"00".repeat(32)}`)).toBeUndefined();
    expect(v4Pool(BASE_SEPOLIA, undefined)).toBeUndefined();
  });
});
