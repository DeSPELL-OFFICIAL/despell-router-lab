import type { SwapChain } from "./chains";
import type { SwapPlan } from "./plan";
import { receivedFromReceipt } from "./read";
import type { Rechecked, SignResult } from "./sign-loop";
import { confirmedApprovals, type Phase } from "./view";

/*
  What the card does after a signing run or a [Check again]: its next phase,
  whether the frozen plan is kept (the card goes on showing exactly what was
  signed, and nothing new can be prepared) or released, and the one-line
  notice under the card. Pure, so the wiring in useSwap is tested here.
*/

export type CardUpdate = {
  /** Null keeps the current phase. */
  phase: Phase | null;
  frozen: "keep" | "release";
  notice: string | null;
};

export function isUserRejection(error: unknown): boolean {
  for (let e: unknown = error; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    const { code, name, message } = e as { code?: unknown; name?: unknown; message?: unknown };
    if (code === 4001 || name === "UserRejectedRequestError") return true;
    if (typeof message === "string" && /user (rejected|denied)/iu.test(message)) return true;
  }
  return false;
}

export const firstLine = (error: unknown) =>
  (error instanceof Error ? ((error as { shortMessage?: string }).shortMessage ?? error.message) : String(error)).split("\n")[0];

const RELOAD = "Check the transaction on the explorer, then reload the page before signing again.";

function stillApproved(chain: SwapChain, plan: SwapPlan, confirmed: number): string {
  const lines = confirmedApprovals(chain, plan, confirmed);
  return lines.length > 0 ? ` Still approved: ${lines.join("; ")}. The next quote uses ${lines.length > 1 ? "them" : "it"}.` : "";
}

export function afterSigning(chain: SwapChain, plan: SwapPlan, result: SignResult, nowMs: number): CardUpdate {
  const total = plan.steps.length;
  switch (result.kind) {
    case "done":
      return {
        phase: { kind: "done", hash: result.hash, received: receivedFromReceipt(chain, result.receipt), block: result.receipt.blockNumber },
        frozen: "keep",
        // A note left by an earlier "not confirmed" no longer holds.
        notice: null,
      };
    case "reverted":
      return {
        phase: { kind: "failed", hash: result.hash, reason: `transaction ${result.step + 1} of ${total} reverted on chain` },
        frozen: "keep",
        notice: stillApproved(chain, plan, result.step).trim() || null,
      };
    case "unconfirmed":
      // Keep the plan frozen: the transaction may be on chain, and a new plan would offer to sign it again.
      return {
        phase: { kind: "unconfirmed", step: result.step, total, hash: result.hash, nonce: result.nonce },
        frozen: "keep",
        notice: `Transaction ${result.step + 1} of ${total} was sent, but its receipt could not be read (${firstLine(result.error)}). Check it before signing anything else.`,
      };
    case "stopped":
      return {
        phase: { kind: "blocked", reason: result.reason, at: nowMs },
        frozen: "release",
        notice: `Stopped before signing transaction ${result.step + 1}: ${result.reason}.${stillApproved(chain, plan, result.step)} Nothing else was sent.`,
      };
    case "error":
      // Blocked, not idle: the button stays off until a new plan has been simulated after this.
      return {
        phase: { kind: "blocked", reason: isUserRejection(result.error) ? "declined in your wallet" : "the wallet did not send it", at: nowMs },
        frozen: "release",
        notice:
          (isUserRejection(result.error) ? "Declined in your wallet." : `Not sent: ${firstLine(result.error)}.`) +
          (result.step === 0 ? " Nothing was sent." : `${stillApproved(chain, plan, result.step)} The swap was not sent.`),
      };
  }
}

/** After [Check again] on transaction `step`. */
export function afterRecheck(chain: SwapChain, plan: SwapPlan, step: number, r: Rechecked, nowMs: number): CardUpdate {
  const total = plan.steps.length;
  switch (r.kind) {
    case "pending":
      return {
        phase: null,
        frozen: "keep",
        notice: `Still not confirmed (${r.reason}). Check again in a moment, or check it on the explorer and reload the page; nothing new can be signed until then.`,
      };
    case "released":
      // No `at`: the card stays off until the page is reloaded. A sped-up copy of this very swap may be the one that
      // used the nonce, so offering a fresh plan here could sign the same swap twice.
      return {
        phase: { kind: "blocked", reason: r.reason },
        frozen: "release",
        notice: `Released: ${r.reason}.${stillApproved(chain, plan, step)} ${RELOAD}`,
      };
    case "stopped":
      return afterSigning(chain, plan, { kind: "stopped", step, reason: r.reason }, nowMs);
    case "reverted":
      return afterSigning(chain, plan, { kind: "reverted", step, hash: r.hash }, nowMs);
    case "confirmed":
      if (plan.steps[step].kind === "swap") return afterSigning(chain, plan, { kind: "done", step, hash: r.hash, receipt: r.receipt }, nowMs);
      // An approval confirmed: release the plan, blocked until a new plan (which skips this step) is simulated.
      return {
        phase: { kind: "blocked", reason: `transaction ${step + 1} of ${total} confirmed; preparing the rest`, at: nowMs },
        frozen: "release",
        notice: `Transaction ${step + 1} of ${total} is confirmed.${stillApproved(chain, plan, step + 1)} Nothing else was sent.`,
      };
  }
}
