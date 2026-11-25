import { getAddress, type Hex, type TransactionReceipt } from "viem";
import { describe, expect, it } from "vitest";
import { BASE_SEPOLIA } from "./chains";
import { buildPlan, type SwapPlan, type Tx } from "./plan";
import type { Simulation } from "./read";
import { LAG_RETRIES, recheckUnconfirmed, runSigning, settle, type RecheckDeps, type Replacement, type SignDeps, type WaitResult } from "./sign-loop";
import { gateStopReason } from "./view";

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
const receiptOf = (hash: Hex, blockNumber: bigint, status: "success" | "reverted" = "success") =>
  ({ status, blockNumber, transactionHash: hash, logs: [] }) as unknown as TransactionReceipt;
const replacedBy = (hash: Hex, replacement: Replacement, blockNumber = 200n): WaitResult => ({ receipt: receiptOf(hash, blockNumber), replacement });
const OTHER = `0x${"ab".repeat(32)}` as Hex;

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
      return { receipt: receiptOf(hash, block), replacement: null };
    },
    nonceOf: async (hash) => Number(BigInt(hash)) + 40,
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
    const h = harness({ wait: async (hash) => ({ receipt: receiptOf(hash, 1n, "reverted"), replacement: null }) });
    expect(await runSigning(plan, h.deps)).toEqual({ kind: "reverted", step: 0, hash: hashOf(0) });
  });

  // A sent transaction whose receipt cannot be read is not "not sent".
  it("keeps the hash of a sent transaction whose receipt cannot be read, and sends nothing after it", async () => {
    const timeout = new Error("Timed out while waiting for transaction with hash");
    const h = harness({
      wait: async (hash) => {
        if (hash === hashOf(2)) throw timeout;
        return { receipt: receiptOf(hash, 101n), replacement: null };
      },
    });
    expect(await runSigning(plan, h.deps)).toEqual({ kind: "unconfirmed", step: 2, hash: hashOf(2), nonce: 43, error: timeout });
    expect(h.sent).toHaveLength(3);
  });

  it("tells a wallet that never returned a hash apart from one whose receipt is missing", async () => {
    const h = harness({
      send: async () => {
        throw new Error("HTTP request failed. Status: 429");
      },
    });
    expect((await runSigning(plan, h.deps)).kind).toBe("error");
  });

  // A cancelled or replaced transaction is not a confirmation.
  it("continues under the new hash when the wallet repriced the very same call", async () => {
    const swapTx = plan.steps[2].tx;
    const h = harness({
      wait: async (hash) =>
        hash === hashOf(2)
          ? replacedBy(OTHER, { reason: "repriced", to: swapTx.to, data: swapTx.data, value: swapTx.value })
          : { receipt: receiptOf(hash, 101n), replacement: null },
    });
    const result = await runSigning(plan, h.deps);
    expect(result).toMatchObject({ kind: "done", step: 2, hash: OTHER });
  });

  it("stops, and does not report Received, when the swap was cancelled in the wallet", async () => {
    const h = harness({
      wait: async (hash) =>
        hash === hashOf(2)
          ? replacedBy(OTHER, { reason: "cancelled", to: plan.account, data: "0x", value: 0n })
          : { receipt: receiptOf(hash, 101n), replacement: null },
    });
    const result = await runSigning(plan, h.deps);
    expect(result.kind).toBe("stopped");
    expect(result).toMatchObject({ step: 2, reason: expect.stringContaining("was cancelled in the wallet") });
  });

  it("stops when an approval was replaced by a different transaction, before asking for the next one", async () => {
    const h = harness({
      wait: async () => replacedBy(OTHER, { reason: "replaced", to: plan.account, data: "0x1234", value: 5n }),
    });
    expect(await runSigning(plan, h.deps)).toMatchObject({ kind: "stopped", step: 0 });
    expect(h.sent).toHaveLength(1);
  });

  it("does not take viem's 'repriced' label on trust: the call must be the same bytes", () => {
    const swapTx = plan.steps[2].tx;
    const lookalike = replacedBy(OTHER, { reason: "repriced", to: swapTx.to, data: `${swapTx.data.slice(0, -2)}${swapTx.data.endsWith("ff") ? "00" : "ff"}` as Hex, value: swapTx.value });
    expect(settle(plan, 2, hashOf(2), lookalike).kind).toBe("stopped");
    const otherTarget = replacedBy(OTHER, { reason: "repriced", to: plan.account, data: swapTx.data, value: swapTx.value });
    expect(settle(plan, 2, hashOf(2), otherTarget).kind).toBe("stopped");
  });

  // A contest gate is fail-closed.
  it("does not sign while a contest gate is pending or holding", async () => {
    for (const gate of [{ state: "pending", label: "the circuit check" }, { state: "hold", title: "Pool held" }] as const) {
      const h = harness({ stopReason: () => gateStopReason(gate) });
      const result = await runSigning(plan, h.deps);
      expect(result.kind).toBe("stopped");
      expect(h.sent).toHaveLength(0);
    }
  });
});

describe("recheckUnconfirmed", () => {
  const SWAP = 2;
  const hash = hashOf(SWAP);
  const timeout = () => Promise.reject(new Error("Timed out while waiting for transaction"));
  const deps = (over: Partial<RecheckDeps>): RecheckDeps => ({
    wait: timeout,
    nonceOf: async () => 12,
    latestNonce: async () => 12,
    receipt: async () => null,
    ...over,
  });

  it("settles once the receipt can be read", async () => {
    const r = await recheckUnconfirmed(plan, SWAP, hash, 12, deps({ wait: async (h) => ({ receipt: receiptOf(h, 300n), replacement: null }) }));
    expect(r.kind).toBe("confirmed");
  });

  it("stays pending while the account has not used the nonce yet", async () => {
    expect((await recheckUnconfirmed(plan, SWAP, hash, 12, deps({ latestNonce: async () => 12 }))).kind).toBe("pending");
  });

  it("stops when the nonce is used and there is still no receipt: the transaction was dropped or replaced", async () => {
    const r = await recheckUnconfirmed(plan, SWAP, hash, 12, deps({ latestNonce: async () => 13 }));
    expect(r).toMatchObject({ kind: "stopped", reason: expect.stringContaining("nonce 12") });
  });

  it("reads the receipt directly once more before giving up on a used nonce", async () => {
    const r = await recheckUnconfirmed(plan, SWAP, hash, 12, deps({ latestNonce: async () => 13, receipt: async (h) => receiptOf(h, 300n) }));
    expect(r.kind).toBe("confirmed");
  });

  it("looks the nonce up when it was not known, and stays pending when it cannot", async () => {
    expect((await recheckUnconfirmed(plan, SWAP, hash, null, deps({ nonceOf: async () => 5, latestNonce: async () => 6 }))).kind).toBe("stopped");
    expect((await recheckUnconfirmed(plan, SWAP, hash, null, deps({ nonceOf: async () => null, latestNonce: async () => 99 }))).kind).toBe("pending");
  });
});
