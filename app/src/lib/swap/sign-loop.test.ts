import { getAddress, type Hex, type TransactionReceipt } from "viem";
import { describe, expect, it } from "vitest";
import { BASE_SEPOLIA } from "./chains";
import { buildPlan, type SwapPlan, type Tx } from "./plan";
import type { Simulation } from "./read";
import { LAG_RETRIES, runSigning, type SignDeps } from "./sign-loop";

const NOW = 1_795_700_000;
const plan: SwapPlan = buildPlan({
  chain: BASE_SEPOLIA,
  quote: { chainId: BASE_SEPOLIA.id, amountIn: 10_000_000n, expectedOut: 6_000_000_000_000_000n, block: 1n, at: NOW * 1000, lpFee: 500 },
  wallet: { account: getAddress("0x1111111111111111111111111111111111111111"), usdcBalance: 20_000_000n, erc20Allowance: 0n, permit2: { amount: 0n, expiration: 0 } },
  nowSec: NOW,
});

const ok = (): Simulation => ({ ok: true, planId: plan.id, block: 1n, ethDelta: plan.expectedOut, usdcDelta: -plan.amountIn, gas: 1n, gasPrice: 1n });
const bad = (reason = "Step 3 of 3 (swap) would revert"): Simulation => ({ ok: false, planId: plan.id, block: 1n, reason });
const hashOf = (i: number) => `0x${String(i + 1).padStart(64, "0")}` as Hex;

/** A wallet and chain that record what they were asked, with hooks to change the world between steps. */
function harness(over: Partial<SignDeps> & { afterConfirm?: (step: number) => void } = {}) {
  const sent: Tx[] = [];
  const simulatedFrom: Array<[number, bigint | undefined]> = [];
  let block = 100n;
  const deps: SignDeps = {
    simulate: async (from, minBlock) => {
      simulatedFrom.push([from, minBlock]);
      return ok();
    },
    send: async (tx) => {
      sent.push(tx);
      return hashOf(sent.length - 1);
    },
    wait: async (hash) => {
      block += 1n;
      const step = Number(BigInt(hash)) - 1;
      over.afterConfirm?.(step);
      return { status: "success", blockNumber: block, logs: [] } as unknown as TransactionReceipt;
    },
    stopReason: () => null,
    onPhase: () => {},
    nowMs: () => NOW * 1000,
    sleep: async () => {},
    ...over,
  };
  return { deps, sent, simulatedFrom };
}

describe("runSigning", () => {
  it("signs approve, Permit2 approve and swap in order, simulating the rest before each", async () => {
    const h = harness();
    const result = await runSigning(plan, h.deps);
    expect(result.kind).toBe("done");
    expect(h.sent.map((t) => t.to)).toEqual(plan.steps.map((s) => s.tx.to));
    expect(h.sent).toEqual(plan.steps.map((s) => s.tx));
    // Each simulation starts at the next unsigned step and no earlier than the last confirmation.
    expect(h.simulatedFrom).toEqual([
      [0, undefined],
      [1, 101n],
      [2, 102n],
    ]);
  });

  it("stops before the swap when a contest hold arrives after the first signature", async () => {
    let held: string | null = null;
    const h = harness({ afterConfirm: (step) => (step === 0 ? (held = "held: pool fee changed") : null), stopReason: () => held });
    const result = await runSigning(plan, h.deps);
    expect(result).toEqual({ kind: "stopped", step: 1, reason: "held: pool fee changed" });
    expect(h.sent).toHaveLength(1);
  });

  it("stops when the card goes away while a transaction confirms", async () => {
    let gone = false;
    const h = harness({ afterConfirm: () => (gone = true), stopReason: () => (gone ? "the card was closed" : null) });
    const result = await runSigning(plan, h.deps);
    expect(result.kind).toBe("stopped");
    expect(h.sent).toHaveLength(1);
  });

  it("checks the stop reason again after the pre-sign simulation", async () => {
    let calls = 0;
    const h = harness({ stopReason: () => (++calls === 2 ? "held: arrived during the simulation" : null) });
    const result = await runSigning(plan, h.deps);
    expect(result).toEqual({ kind: "stopped", step: 0, reason: "held: arrived during the simulation" });
    expect(h.sent).toHaveLength(0);
  });

  it("retries a simulation that lags a fresh confirmation, then goes on", async () => {
    let lagging = 2;
    const h = harness({
      simulate: async (from) => (from === 1 && lagging-- > 0 ? bad("Step 2 of 3 (Permit2 allowance) would revert") : ok()),
    });
    const result = await runSigning(plan, h.deps);
    expect(result.kind).toBe("done");
    expect(h.sent).toHaveLength(3);
  });

  it("stops when the remaining transactions keep failing simulation, before asking the wallet", async () => {
    let tries = 0;
    const h = harness({ simulate: async (from) => (from === 2 ? (tries++, bad()) : ok()) });
    const result = await runSigning(plan, h.deps);
    expect(result).toEqual({ kind: "stopped", step: 2, reason: "Step 3 of 3 (swap) would revert" });
    expect(tries).toBe(1 + LAG_RETRIES);
    expect(h.sent).toHaveLength(2);
  });

  it("does not retry the first simulation: nothing was confirmed yet", async () => {
    let tries = 0;
    const h = harness({ simulate: async () => (tries++, bad()) });
    expect((await runSigning(plan, h.deps)).kind).toBe("stopped");
    expect(tries).toBe(1);
    expect(h.sent).toHaveLength(0);
  });

  it("stops near the deadline", async () => {
    const h = harness({ nowMs: () => (plan.deadline - 30) * 1000 });
    expect(await runSigning(plan, h.deps)).toEqual({ kind: "stopped", step: 0, reason: "the quote is about to expire" });
    expect(h.sent).toHaveLength(0);
  });

  it("reports a wallet decline with the step it happened at", async () => {
    const decline = Object.assign(new Error("User rejected the request."), { code: 4001 });
    let n = 0;
    const h = harness({
      send: async () => {
        if (n++ === 1) throw decline;
        return hashOf(n - 1);
      },
    });
    expect(await runSigning(plan, h.deps)).toEqual({ kind: "error", step: 1, error: decline });
  });

  it("stops at a reverted transaction", async () => {
    const h = harness({ wait: async () => ({ status: "reverted", blockNumber: 1n, logs: [] }) as unknown as TransactionReceipt });
    expect(await runSigning(plan, h.deps)).toEqual({ kind: "reverted", step: 0, hash: hashOf(0) });
  });
});
