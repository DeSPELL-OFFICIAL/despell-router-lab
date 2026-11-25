// Sample input vectors and the rule function's answers, for checking a taped-out circuit with `eval`.
//
// The tape-out script (contracts/script/TapeOut.s.sol) and the app read circuit/pool-judgment-samples.json: each
// vector, the bytes `eval` takes for it, and the output the rule function gives. Named scenarios come first, then
// pseudo-random vectors from a fixed seed, so the file is the same on every machine. Pure module.

import { decodeInput, encodeInput, encodeOutput, INPUT_COUNT, packPins } from "./bits.ts";
import { toHex } from "./netlist.ts";
import { judge, type ChangeKind, type JudgmentInput } from "./rule.ts";

export const SAMPLE_COUNT = 64;
const SEED = 696;

const passing = { lossUnderReflexLine: true, hiddenLossWithinOpenLimit: true, sellNotReverted: true, codeHashMatches: true };

function pool(overrides: Partial<Omit<JudgmentInput, "changes">> & { readonly changes?: readonly ChangeKind[] } = {}): JudgmentInput {
  const { changes, ...rest } = overrides;
  return {
    stage: "probation",
    operatorBlocked: false,
    decision: null,
    fullReview: true,
    adminHandleRestrict: false,
    tokenPermissionsClear: true,
    family: "uniswap_v3",
    probe: passing,
    cardFresh: true,
    amountWithinCap: true,
    ...rest,
    changes: new Set(changes ?? []),
  };
}

/** Scenarios a reader can follow, each with a short name. */
export const SCENARIOS: readonly { readonly name: string; readonly input: JudgmentInput }[] = [
  { name: "quiet probation pool", input: pool() },
  { name: "trusted pool, fee changed", input: pool({ stage: "trusted", changes: ["fee_changed"] }) },
  { name: "code changed", input: pool({ changes: ["code_changed"] }) },
  { name: "test sell reverted", input: pool({ changes: ["sell_reverted"] }) },
  { name: "first-seen pool, fee changed", input: pool({ stage: "unknown", changes: ["fee_changed"] }) },
  { name: "paused", input: pool({ changes: ["paused"] }) },
  { name: "operator block", input: pool({ operatorBlocked: true }) },
  { name: "first-seen pool, AI allow, probes pass", input: pool({ stage: "unknown", decision: "allow" }) },
  { name: "first-seen pool, AI allow, sell reverted in probe", input: pool({ stage: "unknown", decision: "allow", probe: { ...passing, sellNotReverted: false } }) },
  { name: "blocked pool, AI allow, probes pass", input: pool({ stage: "blocked", decision: "allow" }) },
  { name: "first-seen pool, admin handle restrict", input: pool({ stage: "unknown", decision: "restrict", adminHandleRestrict: true }) },
  { name: "watch-only family", input: pool({ family: "pancake_infinity_cl" }) },
  { name: "stored stage outside the list", input: pool({ stage: null }) },
  { name: "card older than 26 hours", input: pool({ cardFresh: false }) },
  { name: "trusted pool, AI block", input: pool({ stage: "trusted", decision: "block" }) },
  { name: "stale reading", input: pool({ changes: ["stale"] }) },
];

export type Sample = { readonly name: string; readonly vector: number; readonly inputs: string; readonly output: number };

export function samples(): Sample[] {
  const seen = new Set<number>();
  const list: Sample[] = [];
  const add = (name: string, vector: number) => {
    if (seen.has(vector)) return;
    seen.add(vector);
    list.push({ name, vector, inputs: toHex(packPins(vector, INPUT_COUNT)), output: encodeOutput(judge(decodeInput(vector))) });
  };
  add("all inputs 0", 0);
  add("all inputs 1", 2 ** INPUT_COUNT - 1);
  for (const scenario of SCENARIOS) add(scenario.name, encodeInput(scenario.input));
  let seed = SEED;
  while (list.length < SAMPLE_COUNT) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    add("pseudo-random", seed % 2 ** INPUT_COUNT);
  }
  return list;
}
