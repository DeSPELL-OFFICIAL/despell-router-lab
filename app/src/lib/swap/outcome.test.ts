import { getAddress, type Hex, type TransactionReceipt } from "viem";
import { describe, expect, it } from "vitest";
import { BASE_SEPOLIA } from "./chains";
import { afterRecheck, afterSigning } from "./outcome";
import { buildPlan } from "./plan";
import { effectivePhase } from "./view";

/* The wiring from a signing run or [Check again] to what the card does next. */

const NOW = 1_795_700_000;
const plan = buildPlan({
  chain: BASE_SEPOLIA,
  quote: { chainId: BASE_SEPOLIA.id, amountIn: 10_000_000n, expectedOut: 6_000_000_000_000_000n, block: 1n, at: NOW * 1000, lpFee: 500 },
  wallet: { account: getAddress("0x1111111111111111111111111111111111111111"), usdcBalance: 20_000_000n, erc20Allowance: 0n, permit2: { amount: 0n, expiration: 0 } },
  nowSec: NOW,
});
const HASH = `0x${"ab".repeat(32)}` as Hex;
const receipt = { status: "success", blockNumber: 9n, transactionHash: HASH, logs: [] } as unknown as TransactionReceipt;
const T = 1_000_000;

describe("afterRecheck", () => {
  // A transaction released because its nonce was used stays off until reload: a sped-up copy of the same swap may have
  // used that nonce, so a fresh plan must not turn the button back on.
  it("keeps the card off after a release, even when a newer plan arrives", () => {
    const u = afterRecheck(BASE_SEPOLIA, plan, 2, { kind: "released", reason: "transaction 3 of 3 has no receipt" }, T);
    expect(u.frozen).toBe("release");
    expect(u.phase).toEqual({ kind: "blocked", reason: "transaction 3 of 3 has no receipt" });
    expect(effectivePhase(u.phase!, T + 60_000).kind).toBe("blocked");
    expect(u.notice).toContain("reload the page");
    // It names what stays approved: both approvals of this plan went through before the swap.
    expect(u.notice).toContain("Still approved: USDC.approve");
    expect(u.notice).toContain("Permit2.approve");
  });

  it("keeps the plan frozen and says how to get out while still pending", () => {
    const u = afterRecheck(BASE_SEPOLIA, plan, 2, { kind: "pending", reason: "HTTP request failed. Status: 429" }, T);
    expect(u).toMatchObject({ phase: null, frozen: "keep" });
    expect(u.notice).toContain("reload the page");
  });

  it("shows Received when the swap's receipt is read, and clears the earlier note", () => {
    const u = afterRecheck(BASE_SEPOLIA, plan, 2, { kind: "confirmed", hash: HASH, receipt }, T);
    expect(u.phase?.kind).toBe("done");
    expect(u.frozen).toBe("keep");
    expect(u.notice).toBeNull();
  });

  it("releases a confirmed approval, off until a newer plan is simulated", () => {
    const u = afterRecheck(BASE_SEPOLIA, plan, 0, { kind: "confirmed", hash: HASH, receipt }, T);
    expect(u.frozen).toBe("release");
    expect(effectivePhase(u.phase!, T).kind).toBe("blocked");
    expect(effectivePhase(u.phase!, T + 1).kind).toBe("idle");
    expect(u.notice).toContain("Still approved: USDC.approve");
  });
});

describe("afterSigning", () => {
  it("keeps an unconfirmed transaction frozen with its hash and nonce", () => {
    const u = afterSigning(BASE_SEPOLIA, plan, { kind: "unconfirmed", step: 2, hash: HASH, nonce: 7, error: new Error("429") }, T);
    expect(u.frozen).toBe("keep");
    expect(u.phase).toEqual({ kind: "unconfirmed", step: 2, total: 3, hash: HASH, nonce: 7 });
  });

  it("blocks after a wallet decline until a newer plan is simulated", () => {
    const u = afterSigning(BASE_SEPOLIA, plan, { kind: "error", step: 0, error: Object.assign(new Error("User rejected the request."), { code: 4001 }) }, T);
    expect(u.phase).toMatchObject({ kind: "blocked", at: T });
    expect(u.notice).toBe("Declined in your wallet. Nothing was sent.");
    expect(effectivePhase(u.phase!, T).kind).toBe("blocked");
    expect(effectivePhase(u.phase!, T + 1).kind).toBe("idle");
  });
});
