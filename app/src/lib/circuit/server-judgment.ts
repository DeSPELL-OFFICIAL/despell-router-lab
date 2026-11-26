import { getAddress, isAddressEqual, type Address } from "viem";
import type { Judgment, JudgmentInput, Lane } from "@despell-lab/xlayer/src/rule.ts";
import { GIWA_SEPOLIA } from "@/lib/swap/chains";

/*
  The server's judgment of a pool: the facts it judged on (as the circuit's
  input) and what it decided (stage written, lane for a trade).

  The app uses a recorded sample, and every screen that shows it says so.
  The router's journal lives in its private database and the site is given
  no address for it. Its past judgments are replayed through the circuit
  offline instead, from an export (xlayer/scripts/replay-journal.ts, DES-702).
*/

export type ServerJudgment = {
  chainId: number;
  pool: Address;
  label: string;
  input: JudgmentInput;
  judgment: Judgment;
  /** ISO time of the judgment. */
  at: string;
  source: "sample";
  /** Set when the judgment was altered on purpose to show what a mismatch does. */
  demo?: "mismatch";
};

/** The GIWA Sepolia WETH/USDC (Mock) 0.3% pool the GIWA swap card trades through. */
const GIWA_WETH_USDC: ServerJudgment = {
  chainId: GIWA_SEPOLIA.id,
  pool: GIWA_SEPOLIA.pool.address,
  label: "WETH/USDC (Mock) 0.3% · Uniswap v3",
  input: {
    stage: "probation",
    changes: new Set(),
    operatorBlocked: false,
    decision: null,
    fullReview: false,
    adminHandleRestrict: false,
    tokenPermissionsClear: true,
    family: "uniswap_v3",
    probe: { lossUnderReflexLine: true, hiddenLossWithinOpenLimit: true, sellNotReverted: true, codeHashMatches: true },
    cardFresh: true,
    amountWithinCap: true,
  },
  judgment: { stage: "probation", lane: "fast" },
  at: "2026-11-26T03:00:00Z",
  source: "sample",
};

const JUDGMENTS: readonly ServerJudgment[] = [GIWA_WETH_USDC];

/** A different lane than the server's, so the circuit's answer cannot match. */
function otherLane(lane: Lane): Lane {
  return lane === "fast" ? "standard" : "fast";
}

/**
 * The server's latest judgment of `pool` on `chainId`, or null when the server has none (no line on the card).
 * `demoMismatch` alters the server's lane on purpose: it can only make the card stop, never open it.
 */
export function serverJudgmentFor(chainId: number, pool: string, opts: { demoMismatch?: boolean } = {}): ServerJudgment | null {
  let address: Address;
  try {
    address = getAddress(pool);
  } catch {
    return null;
  }
  const found = JUDGMENTS.find((j) => j.chainId === chainId && isAddressEqual(j.pool, address));
  if (!found) return null;
  if (!opts.demoMismatch) return found;
  return { ...found, judgment: { stage: found.judgment.stage, lane: otherLane(found.judgment.lane) }, demo: "mismatch" };
}

/** The server's judgment of `pool` on whichever chain it was judged (the circuit page's route names the pool only). */
export function serverJudgmentForPool(pool: string, opts: { demoMismatch?: boolean } = {}): ServerJudgment | null {
  for (const j of JUDGMENTS) {
    const found = serverJudgmentFor(j.chainId, pool, opts);
    if (found) return found;
  }
  return null;
}
