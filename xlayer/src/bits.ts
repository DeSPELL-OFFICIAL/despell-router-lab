// The circuit's pins: which input bit means what, and how a judgment comes back out.
//
// A vector is a plain integer: bit i is input pin i. TapeOut's `eval(id, inputs)` takes the same bits packed little
// end first (pin 0 is bit 0 of byte 0, pin 8 is bit 0 of byte 1), and returns the outputs packed the same way.

import { CHANGE_KINDS, DECISIONS, FAMILIES, LANES, STAGES, type ChangeKind, type Judgment, type JudgmentInput } from "./rule.ts";

/** Input pin numbers. */
export const PIN = {
  /** Three bits, the stage code: the stage's index in `STAGES` (blocked 0 … trusted 4). Codes 5 to 7 are not a stage. */
  stage: 0,
  /** Ten bits, one per change kind in `CHANGE_KINDS` order. */
  changes: 3,
  operatorBlocked: 13,
  /** Two bits: 0 no decision, 1 allow, 2 restrict, 3 block. */
  decision: 14,
  fullReview: 16,
  adminHandleRestrict: 17,
  tokenPermissionsClear: 18,
  /** Two bits: the family's index in `FAMILIES`. Code 3 is not a family. */
  family: 19,
  lossUnderReflexLine: 21,
  hiddenLossWithinOpenLimit: 22,
  sellNotReverted: 23,
  codeHashMatches: 24,
  cardFresh: 25,
  amountWithinCap: 26,
} as const;

export const INPUT_COUNT = 27;

/** Output pin numbers. */
export const OUT = {
  /** Three bits, the next stage code (always 0 to 4). */
  stage: 0,
  /** Two bits, the lane's index in `LANES` (fast 0, standard 1, deep 2, closed 3). */
  lane: 3,
} as const;

export const OUTPUT_COUNT = 5;

/** The stage code written for a stored stage outside the closed list. Codes 5, 6 and 7 all mean that. */
export const BROKEN_STAGE_CODE = 5;
/** The family code written for a stored family outside the closed list. */
export const BROKEN_FAMILY_CODE = 3;

function bit(vector: number, pin: number): boolean {
  return ((vector >>> pin) & 1) === 1;
}

function field(vector: number, pin: number, width: number): number {
  return (vector >>> pin) & ((1 << width) - 1);
}

/** Read an input vector as the rule's input. */
export function decodeInput(vector: number): JudgmentInput {
  const stageCode = field(vector, PIN.stage, 3);
  const changes = new Set<ChangeKind>();
  CHANGE_KINDS.forEach((kind, index) => {
    if (bit(vector, PIN.changes + index)) changes.add(kind);
  });
  const decisionCode = field(vector, PIN.decision, 2);
  const familyCode = field(vector, PIN.family, 2);
  return {
    stage: STAGES[stageCode] ?? null,
    changes,
    operatorBlocked: bit(vector, PIN.operatorBlocked),
    decision: decisionCode === 0 ? null : DECISIONS[decisionCode - 1]!,
    fullReview: bit(vector, PIN.fullReview),
    adminHandleRestrict: bit(vector, PIN.adminHandleRestrict),
    tokenPermissionsClear: bit(vector, PIN.tokenPermissionsClear),
    family: FAMILIES[familyCode] ?? null,
    probe: {
      lossUnderReflexLine: bit(vector, PIN.lossUnderReflexLine),
      hiddenLossWithinOpenLimit: bit(vector, PIN.hiddenLossWithinOpenLimit),
      sellNotReverted: bit(vector, PIN.sellNotReverted),
      codeHashMatches: bit(vector, PIN.codeHashMatches),
    },
    cardFresh: bit(vector, PIN.cardFresh),
    amountWithinCap: bit(vector, PIN.amountWithinCap),
  };
}

/** Index in a closed list, or `broken` for null or a value outside it (a raw database value cast to the type). */
function codeIn(list: readonly string[], value: string | null, broken: number): number {
  const index = value === null ? -1 : list.indexOf(value);
  return index === -1 ? broken : index;
}

/** Write the rule's input as an input vector. A stage or family outside its list is written as the broken code. */
export function encodeInput(input: JudgmentInput): number {
  const flag = (value: boolean, pin: number) => (value === true ? 1 << pin : 0);
  let vector = codeIn(STAGES, input.stage, BROKEN_STAGE_CODE) << PIN.stage;
  CHANGE_KINDS.forEach((kind, index) => {
    vector |= flag(input.changes.has(kind), PIN.changes + index);
  });
  vector |= flag(input.operatorBlocked, PIN.operatorBlocked);
  if (input.decision !== null && !DECISIONS.includes(input.decision)) throw new RangeError(`not a decision: ${String(input.decision)}`);
  vector |= (input.decision === null ? 0 : DECISIONS.indexOf(input.decision) + 1) << PIN.decision;
  vector |= flag(input.fullReview, PIN.fullReview);
  vector |= flag(input.adminHandleRestrict, PIN.adminHandleRestrict);
  vector |= flag(input.tokenPermissionsClear, PIN.tokenPermissionsClear);
  vector |= codeIn(FAMILIES, input.family, BROKEN_FAMILY_CODE) << PIN.family;
  vector |= flag(input.probe.lossUnderReflexLine, PIN.lossUnderReflexLine);
  vector |= flag(input.probe.hiddenLossWithinOpenLimit, PIN.hiddenLossWithinOpenLimit);
  vector |= flag(input.probe.sellNotReverted, PIN.sellNotReverted);
  vector |= flag(input.probe.codeHashMatches, PIN.codeHashMatches);
  vector |= flag(input.cardFresh, PIN.cardFresh);
  vector |= flag(input.amountWithinCap, PIN.amountWithinCap);
  return vector >>> 0;
}

/** Write a judgment as an output vector. */
export function encodeOutput(judgment: Judgment): number {
  const stage = STAGES.indexOf(judgment.stage);
  const lane = LANES.indexOf(judgment.lane);
  if (stage === -1 || lane === -1) throw new RangeError(`not a judgment: ${judgment.stage}, ${judgment.lane}`);
  return (stage << OUT.stage) | (lane << OUT.lane);
}

/** Read an output vector. Throws on a stage code that is not a stage (the circuit never makes one). */
export function decodeOutput(vector: number): Judgment {
  const stage = STAGES[field(vector, OUT.stage, 3)];
  const lane = LANES[field(vector, OUT.lane, 2)];
  if (stage === undefined || lane === undefined) throw new RangeError(`not a judgment: ${vector}`);
  return { stage, lane };
}

/** Vectors are 32-bit integers, so helpers here take at most 32 pins. */
const MAX_PINS = 32;

function checkCount(count: number): void {
  if (!Number.isInteger(count) || count < 1 || count > MAX_PINS) throw new RangeError(`pin count ${count} is not 1 to ${MAX_PINS}`);
}

/** Pack pins into the bytes `eval` takes: pin i is bit (i % 8) of byte floor(i / 8). */
export function packPins(vector: number, count: number): Uint8Array {
  checkCount(count);
  const bytes = new Uint8Array(Math.ceil(count / 8));
  for (let pin = 0; pin < count; pin++) {
    if (bit(vector, pin)) bytes[pin >> 3]! |= 1 << (pin & 7);
  }
  return bytes;
}

/** Unpack the bytes `eval` returns into a vector of `count` pins. */
export function unpackPins(bytes: Uint8Array, count: number): number {
  checkCount(count);
  let vector = 0;
  for (let pin = 0; pin < count; pin++) {
    if (((bytes[pin >> 3] ?? 0) >> (pin & 7)) & 1) vector |= 1 << pin;
  }
  return vector >>> 0;
}
