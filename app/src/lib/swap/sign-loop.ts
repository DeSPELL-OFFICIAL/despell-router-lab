import { isAddressEqual, type Address, type Hex, type TransactionReceipt } from "viem";
import type { SwapPlan, Tx } from "./plan";
import type { Simulation } from "./read";
import type { Phase } from "./view";

/*
  Signs a plan's transactions one at a time. Before each one it checks that
  the card is still there and its contest gate is open, that the deadline is
  not close, and simulates the remaining transactions again (no earlier than
  the block of the last confirmation). Any of those failing stops the loop
  before the wallet is asked again.

  After the wallet returns a hash, three things can happen, kept apart:
  - the receipt cannot be read (RPC error, timeout): "unconfirmed". The
    transaction may well be on chain, so the caller must not offer a new
    signature until the receipt is read again;
  - the transaction was replaced in the wallet: only a repricing of the very
    same call (same to, data, value) continues, under its new hash; a
    cancellation or any other transaction stops;
  - it confirms or reverts.

  The wallet, RPC and clock come in as `deps` so this is tested without a
  browser.
*/

/** What the wallet's transaction was replaced with, as seen by the receipt wait (viem `onReplaced`). */
export type Replacement = { reason: "cancelled" | "replaced" | "repriced"; to: Address | null; data: Hex; value: bigint };
export type WaitResult = { receipt: TransactionReceipt; replacement: Replacement | null };

export type SignDeps = {
  simulate: (from: number, minBlock: bigint | undefined) => Promise<Simulation>;
  send: (tx: Tx) => Promise<Hex>;
  wait: (hash: Hex) => Promise<WaitResult>;
  /** The nonce of a sent transaction, or null if the RPC cannot find it. Read only when its receipt cannot be. */
  nonceOf: (hash: Hex) => Promise<number | null>;
  /** Why signing must stop now (card closed, contest gate not open), or null to go on. Read between transactions. */
  stopReason: () => string | null;
  onPhase: (phase: Phase) => void;
  nowMs: () => number;
  sleep: (ms: number) => Promise<void>;
};

export type SignResult =
  | { kind: "done"; step: number; hash: Hex; receipt: TransactionReceipt }
  /** Stopped before sending transaction `step`; the first `step` transactions are confirmed. */
  | { kind: "stopped"; step: number; reason: string }
  | { kind: "reverted"; step: number; hash: Hex }
  /** Transaction `step` was sent as `hash` but no receipt could be read. `nonce` lets a later check tell "dropped" from "pending". */
  | { kind: "unconfirmed"; step: number; hash: Hex; nonce: number | null; error: unknown }
  /** The wallet did not send transaction `step` (declined, or failed before returning a hash). */
  | { kind: "error"; step: number; error: unknown };

export type Settled = { kind: "confirmed"; hash: Hex; receipt: TransactionReceipt } | { kind: "reverted"; hash: Hex } | { kind: "stopped"; reason: string };

/** Judges the receipt the wait returned for transaction `step`, sent as `sentHash`. */
export function settle(plan: SwapPlan, step: number, sentHash: Hex, { receipt, replacement }: WaitResult): Settled {
  const tx = plan.steps[step].tx;
  let hash = sentHash;
  if (receipt.transactionHash.toLowerCase() !== sentHash.toLowerCase()) {
    // Trust viem's label only when the replacement is visibly the same call.
    const sameCall =
      replacement?.reason === "repriced" &&
      replacement.to !== null &&
      isAddressEqual(replacement.to, tx.to) &&
      replacement.data.toLowerCase() === tx.data.toLowerCase() &&
      replacement.value === tx.value;
    if (!sameCall) {
      const how = replacement?.reason === "cancelled" ? "cancelled" : "replaced by another transaction";
      return { kind: "stopped", reason: `transaction ${step + 1} of ${plan.steps.length} was ${how} in the wallet (${receipt.transactionHash.slice(0, 10)}…)` };
    }
    hash = receipt.transactionHash;
  }
  if (receipt.status !== "success") return { kind: "reverted", hash };
  return { kind: "confirmed", hash, receipt };
}

/** Retries for a simulation right after a confirmation, when a load-balanced RPC node may still be a block behind. */
export const LAG_RETRIES = 3;
export const LAG_RETRY_MS = 1500;

export async function runSigning(plan: SwapPlan, deps: SignDeps): Promise<SignResult> {
  const total = plan.steps.length;
  let minBlock: bigint | undefined;
  for (let step = 0; step < total; step++) {
    let why = deps.stopReason();
    if (why) return { kind: "stopped", step, reason: why };
    deps.onPhase({ kind: "signing", step, total, waiting: "simulating" });
    if (deps.nowMs() / 1000 > plan.deadline - 60) return { kind: "stopped", step, reason: "the quote is about to expire" };
    let sim = await deps.simulate(step, minBlock);
    for (let retry = 0; !sim.ok && minBlock !== undefined && retry < LAG_RETRIES; retry++) {
      await deps.sleep(LAG_RETRY_MS);
      sim = await deps.simulate(step, minBlock);
    }
    if (!sim.ok) return { kind: "stopped", step, reason: sim.reason };
    // Checked again after the awaits above: the card may be gone or its gate closed by now.
    why = deps.stopReason();
    if (why) return { kind: "stopped", step, reason: why };

    deps.onPhase({ kind: "signing", step, total, waiting: "wallet" });
    let hash: Hex;
    try {
      hash = await deps.send(plan.steps[step].tx);
    } catch (error) {
      return { kind: "error", step, error };
    }
    deps.onPhase({ kind: "signing", step, total, waiting: "chain" });
    let waited: WaitResult;
    try {
      waited = await deps.wait(hash);
    } catch (error) {
      const nonce = await deps.nonceOf(hash).catch(() => null);
      return { kind: "unconfirmed", step, hash, nonce, error };
    }
    const settled = settle(plan, step, hash, waited);
    if (settled.kind === "stopped") return { kind: "stopped", step, reason: settled.reason };
    if (settled.kind === "reverted") return { kind: "reverted", step, hash: settled.hash };
    minBlock = settled.receipt.blockNumber;
    if (plan.steps[step].kind === "swap") return { kind: "done", step, hash: settled.hash, receipt: settled.receipt };
  }
  return { kind: "stopped", step: total, reason: "the plan has no swap" };
}

export type RecheckDeps = {
  /** A short receipt wait (it may time out). */
  wait: (hash: Hex) => Promise<WaitResult>;
  nonceOf: (hash: Hex) => Promise<number | null>;
  /** The account's nonce at the latest block: transactions below it are final, one way or another. */
  latestNonce: () => Promise<number>;
  /** One direct receipt read, null when there is none. */
  receipt: (hash: Hex) => Promise<TransactionReceipt | null>;
};

export type Rechecked = Settled | { kind: "pending"; reason: string };

/**
 * [Check again] for an unconfirmed transaction. Settles it when its receipt can be read. When it
 * cannot, and the account has already used the transaction's nonce at the latest block, that
 * transaction will never confirm (dropped, or replaced by one we cannot see): stop, so the card can
 * be released. Otherwise it is still pending and the card stays locked.
 */
export async function recheckUnconfirmed(plan: SwapPlan, step: number, hash: Hex, knownNonce: number | null, deps: RecheckDeps): Promise<Rechecked> {
  try {
    return settle(plan, step, hash, await deps.wait(hash));
  } catch (error) {
    const why = (error instanceof Error ? error.message : String(error)).split("\n")[0];
    const nonce = knownNonce ?? (await deps.nonceOf(hash).catch(() => null));
    if (nonce === null) return { kind: "pending", reason: why };
    const latest = await deps.latestNonce().catch(() => null);
    if (latest === null || latest <= nonce) return { kind: "pending", reason: why };
    // The nonce is used. One direct read before calling it gone: a lagging node may have missed the receipt.
    const receipt = await deps.receipt(hash).catch(() => null);
    if (receipt) return settle(plan, step, hash, { receipt, replacement: null });
    return {
      kind: "stopped",
      reason: `transaction ${step + 1} of ${plan.steps.length} has no receipt and the account has already used its nonce ${nonce}, so it was dropped or replaced`,
    };
  }
}
