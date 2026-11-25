// The pool judgment circuit, built gate by gate from the rule tables.
//
// The tables (which change blocks, which restricts, which families are approved, which changes are code changes)
// come from rule.ts. The control flow of rule.ts is written here a second time as Boolean equations, one group per
// server function, so the circuit and the rule function are two separate writings of the same rules.
// test/circuit.test.ts runs both on all 2^27 inputs.
//
// Pure module.

import { INPUT_COUNT, OUT, OUTPUT_COUNT, PIN } from "./bits.ts";
import { NandBuilder, type Netlist } from "./netlist.ts";
import { CHANGE_KINDS, CODE_CHANGE_KINDS, FAMILIES, OPENABLE_FAMILIES, REFLEX_BY_CHANGE, STAGES, type ChangeKind } from "./rule.ts";

export function buildJudgmentCircuit(): Netlist {
  const c = new NandBuilder(INPUT_COUNT);
  const pin = (n: number) => c.input(n);
  const change = (kind: ChangeKind) => pin(PIN.changes + CHANGE_KINDS.indexOf(kind));
  const changesWith = (action: string) => CHANGE_KINDS.filter((kind) => REFLEX_BY_CHANGE[kind] === action).map(change);

  // ── Stage code → one wire per stage. Codes 5–7 are "broken" (not a stage).
  const stageBits = [pin(PIN.stage), pin(PIN.stage + 1), pin(PIN.stage + 2)];
  const isStage = (name: (typeof STAGES)[number]) => {
    const code = STAGES.indexOf(name);
    return c.lookup(stageBits, (value) => value === code);
  };
  const isBlocked = isStage("blocked");
  const isUnknown = isStage("unknown");
  const isRestricted = isStage("restricted");
  const isProbation = isStage("probation");
  const isTrusted = isStage("trusted");
  const broken = c.lookup(stageBits, (value) => value >= STAGES.length);

  // ── Reflex (reflexFor · applyReflex): block wins over restrict, and the stage only moves down.
  const reflexBlock = c.orAll(changesWith("block"));
  const reflexRestrict = c.orAll(changesWith("restrict"));
  const notBlock = c.not(reflexBlock);
  const notRestrict = c.not(reflexRestrict);
  const afterBlocked = c.or(isBlocked, reflexBlock);
  const afterUnknown = c.and(isUnknown, notBlock);
  const afterRestricted = c.and(notBlock, c.or(isRestricted, c.and(reflexRestrict, c.or(isProbation, isTrusted))));
  const afterProbation = c.andAll([isProbation, notBlock, notRestrict]);
  const afterTrusted = c.andAll([isTrusted, notBlock, notRestrict]);

  // ── Decision code: 0 none, 1 allow, 2 restrict, 3 block.
  const decisionBits = [pin(PIN.decision), pin(PIN.decision + 1)];
  const none = c.lookup(decisionBits, (value) => value === 0);
  const allow = c.lookup(decisionBits, (value) => value === 1);
  const restrict = c.lookup(decisionBits, (value) => value === 2);
  const block = c.lookup(decisionBits, (value) => value === 3);

  // ── Opening needs an approved family and passing probe facts (poolFamilyOpenable · probeFactsPass).
  const familyBits = [pin(PIN.family), pin(PIN.family + 1)];
  const openable = c.lookup(familyBits, (value) => {
    const family = FAMILIES[value];
    return family !== undefined && OPENABLE_FAMILIES.has(family);
  });
  const clear = pin(PIN.tokenPermissionsClear);
  const pass = c.andAll([
    pin(PIN.lossUnderReflexLine),
    pin(PIN.hiddenLossWithinOpenLimit),
    pin(PIN.sellNotReverted),
    pin(PIN.codeHashMatches),
    clear,
  ]);
  const opens = c.and(openable, pass);
  const fullClear = c.and(pin(PIN.fullReview), clear);

  // ── Proposal (poolTrustProposal) and transition (nextTrustState), per decision:
  //   none     → the stage after the reflex.
  //   block    → blocked.
  //   restrict → restricted from probation or trusted; unknown and blocked stay. The admin handle path on unknown
  //              proposes restricted, which is an opening move: it needs `opens`.
  //   allow    → only a full review with clear permissions proposes above the stage: probation from blocked, unknown
  //              or restricted, which needs `opens`. Probation and trusted stay.
  const handlePath = c.andAll([restrict, pin(PIN.adminHandleRestrict), fullClear, afterUnknown]);
  const allowOpens = c.andAll([allow, fullClear, opens]);
  const noneOrAllow = c.or(none, allow);
  const belowProbation = c.orAll([afterBlocked, afterUnknown, afterRestricted]);

  const nextTrusted = c.and(afterTrusted, noneOrAllow);
  const nextProbation = c.or(c.and(allowOpens, belowProbation), c.and(afterProbation, noneOrAllow));
  const nextRestricted = c.orAll([
    c.and(none, afterRestricted),
    c.and(c.and(restrict, c.not(handlePath)), c.orAll([afterRestricted, afterProbation, afterTrusted])),
    c.and(handlePath, opens),
    c.andAll([allow, afterRestricted, c.not(c.and(fullClear, opens))]),
  ]);
  const nextUnknown = c.and(
    afterUnknown,
    c.orAll([none, c.and(restrict, c.not(c.and(handlePath, opens))), c.and(allow, c.not(c.and(fullClear, opens)))]),
  );
  // Blocked is what is left (block, or blocked staying blocked); it is code 0, so it needs no wire of its own.

  // A broken stage is lowered to blocked whatever else is true.
  const valid = c.not(broken);
  const stageCode = (wires: readonly number[]) => c.and(valid, c.orAll(wires));
  const codeOf = (name: (typeof STAGES)[number]) => STAGES.indexOf(name);
  const nextByCode: readonly [number, number][] = [
    [codeOf("unknown"), nextUnknown],
    [codeOf("restricted"), nextRestricted],
    [codeOf("probation"), nextProbation],
    [codeOf("trusted"), nextTrusted],
  ];
  const stageOut = [0, 1, 2].map((bitIndex) =>
    stageCode(nextByCode.filter(([code]) => (code >> bitIndex) & 1).map(([, wire]) => wire)),
  );

  // ── Lane (poolLane): closed, then deep, then standard, then fast.
  const closed = c.orAll([pin(PIN.operatorBlocked), change("paused"), isBlocked, change("sell_reverted")]);
  const deep = c.orAll([...CODE_CHANGE_KINDS.map(change), isUnknown, broken, c.not(openable)]);
  const standard = c.orAll([
    reflexRestrict,
    isRestricted,
    change("stale"),
    c.not(pin(PIN.cardFresh)),
    c.not(pin(PIN.amountWithinCap)),
  ]);
  // Lane code: fast 0, standard 1, deep 2, closed 3.
  const laneHigh = c.or(closed, deep);
  const laneLow = c.or(closed, c.and(c.not(deep), standard));

  const outputs: number[] = new Array<number>(OUTPUT_COUNT);
  stageOut.forEach((wire, index) => (outputs[OUT.stage + index] = wire));
  outputs[OUT.lane] = laneLow;
  outputs[OUT.lane + 1] = laneHigh;
  return c.finish(outputs);
}
