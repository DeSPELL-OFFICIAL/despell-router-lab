import type { Hex, TransactionReceipt } from "viem";
import type { SwapPlan, Tx } from "./plan";
import type { Simulation } from "./read";
import type { Phase } from "./view";

/*
  Signs a plan's transactions one at a time. Before each one it checks that
  the card is still there and not held, that the deadline is not close, and
  simulates the remaining transactions again (no earlier than the block of the
  last confirmation). Any of those failing stops the loop before the wallet is
  asked again. The wallet, RPC and clock come in as `deps` so this is tested
  without a browser.
*/

export type SignDeps = {
  simulate: (from: number, minBlock: bigint | undefined) => Promise<Simulation>;
  send: (tx: Tx) => Promise<Hex>;
  wait: (hash: Hex) => Promise<TransactionReceipt>;
  /** Why signing must stop now (card closed, contest hold), or null to go on. Read between transactions. */
  stopReason: () => string | null;
  onPhase: (phase: Phase) => void;
  nowMs: () => number;
  sleep: (ms: number) => Promise<void>;
};

export type SignResult =
  | { kind: "done"; step: number; hash: Hex; receipt: TransactionReceipt }
  | { kind: "stopped"; step: number; reason: string }
  | { kind: "reverted"; step: number; hash: Hex }
  | { kind: "error"; step: number; error: unknown };

/** Retries for a simulation right after a confirmation, when a load-balanced RPC node may still be a block behind. */
export const LAG_RETRIES = 3;
export const LAG_RETRY_MS = 1500;

export async function runSigning(plan: SwapPlan, deps: SignDeps): Promise<SignResult> {
  const total = plan.steps.length;
  let minBlock: bigint | undefined;
  let step = 0;
  try {
    for (; step < total; step++) {
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
      // Checked again after the awaits above: the card may be gone or held by now.
      why = deps.stopReason();
      if (why) return { kind: "stopped", step, reason: why };
      deps.onPhase({ kind: "signing", step, total, waiting: "wallet" });
      const hash = await deps.send(plan.steps[step].tx);
      deps.onPhase({ kind: "signing", step, total, waiting: "chain" });
      const receipt = await deps.wait(hash);
      if (receipt.status !== "success") return { kind: "reverted", step, hash };
      minBlock = receipt.blockNumber;
      if (plan.steps[step].kind === "swap") return { kind: "done", step, hash, receipt };
    }
    return { kind: "stopped", step, reason: "the plan has no swap" };
  } catch (error) {
    return { kind: "error", step, error };
  }
}
