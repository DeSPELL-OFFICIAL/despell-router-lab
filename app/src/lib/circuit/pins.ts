import { OUT, PIN } from "@despell-lab/xlayer/src/bits.ts";
import { CHANGE_KINDS, DECISIONS, FAMILIES, LANES, STAGES } from "@despell-lab/xlayer/src/rule.ts";

/*
  The circuit's pins as rows for the circuit page: which pins, the name in
  xlayer/README.md, the value read from the very vector sent to `eval`, and
  what that value means.
*/

export type PinRow = { pins: string; name: string; bits: string; value: string; meaning: string };

const field = (vector: number, pin: number, width: number) => (vector >>> pin) & ((1 << width) - 1);
const bits = (vector: number, pin: number, width: number) => field(vector, pin, width).toString(2).padStart(width, "0");
const range = (pin: number, width: number) => (width === 1 ? String(pin) : `${pin}–${pin + width - 1}`);

const CHANGE_MEANING: Record<(typeof CHANGE_KINDS)[number], string> = {
  code_changed: "The pool's code changed",
  token_code_changed: "A token's code or proxy implementation changed",
  implementation_changed: "The pool's proxy implementation changed",
  owner_changed: "The pool's owner changed",
  paused: "The pool is paused now",
  fee_changed: "The pool's fee changed",
  reserve_below_band: "A reserve fell below its usual band or fixed floor",
  round_trip_loss_up: "The virtual round trip loss rose",
  sell_reverted: "A test sell reverted",
  stale: "The card is old, or a field could not be read",
};

type Flag = { pin: number; name: string; meaning: string };

const FLAGS_AFTER_DECISION: readonly Flag[] = [
  { pin: PIN.fullReview, name: "full_review", meaning: "The judgment came from a full review, not a partial one" },
  { pin: PIN.adminHandleRestrict, name: "admin_handle_restrict", meaning: "The restrict met every condition of the admin handle path" },
  { pin: PIN.tokenPermissionsClear, name: "token_permissions_clear", meaning: "Both tokens read false on blacklist, mint, owner-modify and transfer-pause" },
];

const PROBE_FLAGS: readonly Flag[] = [
  { pin: PIN.lossUnderReflexLine, name: "loss_under_reflex_line", meaning: "Round trip loss measured and under 300bp" },
  { pin: PIN.hiddenLossWithinOpenLimit, name: "hidden_loss_within_open_limit", meaning: "Loss minus the pool's own round trip fee measured and at most 100bp" },
  { pin: PIN.sellNotReverted, name: "sell_not_reverted", meaning: "The probe sold back and the sell did not revert" },
  { pin: PIN.codeHashMatches, name: "code_hash_matches", meaning: "Code fingerprints read now match the card" },
  { pin: PIN.cardFresh, name: "card_fresh", meaning: "Card checked within 26 h and at most 5 min ahead of now" },
  { pin: PIN.amountWithinCap, name: "amount_within_cap", meaning: "Amount and base cap positive, amount within the stage's cap" },
];

function flagRow(vector: number, f: Flag): PinRow {
  const on = field(vector, f.pin, 1) === 1;
  return { pins: String(f.pin), name: f.name, bits: on ? "1" : "0", value: on ? "yes" : "no", meaning: f.meaning };
}

/** One row per input field, read from `vector` (pin i = bit i). */
export function inputRows(vector: number): PinRow[] {
  const stage = field(vector, PIN.stage, 3);
  const decision = field(vector, PIN.decision, 2);
  const family = field(vector, PIN.family, 2);
  return [
    {
      pins: range(PIN.stage, 3),
      name: "stage",
      bits: bits(vector, PIN.stage, 3),
      value: `${stage} · ${STAGES[stage] ?? "not a stage"}`,
      meaning: "Stage code on the card: 0 blocked, 1 unknown, 2 restricted, 3 probation, 4 trusted",
    },
    ...CHANGE_KINDS.map((kind, i) => flagRow(vector, { pin: PIN.changes + i, name: kind, meaning: CHANGE_MEANING[kind] })),
    flagRow(vector, { pin: PIN.operatorBlocked, name: "operator_blocked", meaning: "An operator block covers the pool, a token, the deployer or the code family" }),
    {
      pins: range(PIN.decision, 2),
      name: "decision",
      bits: bits(vector, PIN.decision, 2),
      value: `${decision} · ${decision === 0 ? "none" : DECISIONS[decision - 1]}`,
      meaning: "AI decision applied this step: 0 none, 1 allow, 2 restrict, 3 block",
    },
    ...FLAGS_AFTER_DECISION.map((f) => flagRow(vector, f)),
    {
      pins: range(PIN.family, 2),
      name: "family",
      bits: bits(vector, PIN.family, 2),
      value: `${family} · ${FAMILIES[family] ?? "not a family"}`,
      meaning: "0 ammora_curve, 1 uniswap_v3, 2 pancake_infinity_cl",
    },
    ...PROBE_FLAGS.map((f) => flagRow(vector, f)),
  ];
}

/** The two output fields, read from `outputs` (pin k = bit k). */
export function outputRows(outputs: number): PinRow[] {
  const stage = field(outputs, OUT.stage, 3);
  const lane = field(outputs, OUT.lane, 2);
  return [
    { pins: range(OUT.stage, 3), name: "next_stage", bits: bits(outputs, OUT.stage, 3), value: `${stage} · ${STAGES[stage] ?? "?"}`, meaning: "Stage the patrol writes after this step" },
    { pins: range(OUT.lane, 2), name: "lane", bits: bits(outputs, OUT.lane, 2), value: `${lane} · ${LANES[lane] ?? "?"}`, meaning: "0 fast, 1 standard, 2 deep, 3 closed" },
  ];
}
