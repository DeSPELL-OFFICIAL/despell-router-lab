// Cases the server's own comments describe, run through the rule function and through the circuit.

import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeOutput, encodeInput } from "../src/bits.ts";
import { buildJudgmentCircuit } from "../src/circuit.ts";
import { evaluate } from "../src/netlist.ts";
import { judge, type ChangeKind, type Judgment, type JudgmentInput } from "../src/rule.ts";

const circuit = buildJudgmentCircuit();

const passing = { lossUnderReflexLine: true, hiddenLossWithinOpenLimit: true, sellNotReverted: true, codeHashMatches: true };

/** A seeded uniswap_v3 pool on probation, fresh card, amount within cap, nothing changed, no AI decision. */
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

/** The rule function's answer, checked to be the circuit's answer too. */
function both(input: JudgmentInput): Judgment {
  const fromRule = judge(input);
  const fromCircuit = decodeOutput(evaluate(circuit, encodeInput(input)));
  assert.deepEqual(fromCircuit, fromRule, "circuit and rule differ");
  return fromRule;
}

test("a quiet probation pool keeps its stage and trades fast", () => {
  assert.deepEqual(both(pool()), { stage: "probation", lane: "fast" });
});

test("reflex: a fee change narrows, a code change or a reverted sell blocks", () => {
  assert.deepEqual(both(pool({ stage: "trusted", changes: ["fee_changed"] })), { stage: "restricted", lane: "standard" });
  assert.deepEqual(both(pool({ changes: ["code_changed"] })), { stage: "blocked", lane: "deep" });
  assert.deepEqual(both(pool({ changes: ["owner_changed", "sell_reverted"] })), { stage: "blocked", lane: "closed" });
});

test("reflex only tightens: a first-seen pool hit by a restrict stays unknown", () => {
  assert.deepEqual(both(pool({ stage: "unknown", changes: ["fee_changed"] })), { stage: "unknown", lane: "deep" });
});

test("a pause closes the lane and leaves the stage; stale sends the trade down the standard lane", () => {
  assert.deepEqual(both(pool({ changes: ["paused"] })), { stage: "probation", lane: "closed" });
  assert.deepEqual(both(pool({ changes: ["stale"] })), { stage: "probation", lane: "standard" });
});

test("an operator block closes the lane but does not change the stage", () => {
  assert.deepEqual(both(pool({ operatorBlocked: true })), { stage: "probation", lane: "closed" });
});

test("an AI allow opens a first-seen pool to probation only with passing probe facts", () => {
  assert.equal(both(pool({ stage: "unknown", decision: "allow" })).stage, "probation");
  for (const failing of ["lossUnderReflexLine", "hiddenLossWithinOpenLimit", "sellNotReverted", "codeHashMatches"] as const) {
    const probe = { ...passing, [failing]: false };
    assert.equal(both(pool({ stage: "unknown", decision: "allow", probe })).stage, "unknown", failing);
  }
  assert.equal(both(pool({ stage: "unknown", decision: "allow", tokenPermissionsClear: false })).stage, "unknown");
  assert.equal(both(pool({ stage: "unknown", decision: "allow", fullReview: false })).stage, "unknown");
});

test("a blocked pool reopens only through a full review, passing probe facts and an approved family", () => {
  assert.equal(both(pool({ stage: "blocked", decision: "allow" })).stage, "probation");
  assert.equal(both(pool({ stage: "blocked", decision: "allow", probe: { ...passing, sellNotReverted: false } })).stage, "blocked");
  assert.equal(both(pool({ stage: "blocked", decision: "allow", family: "pancake_infinity_cl" })).stage, "blocked");
  assert.equal(both(pool({ stage: "blocked", decision: "restrict" })).stage, "blocked");
});

test("allow never lifts probation to trusted; trusted stays trusted", () => {
  assert.equal(both(pool({ stage: "probation", decision: "allow" })).stage, "probation");
  assert.equal(both(pool({ stage: "trusted", decision: "allow" })).stage, "trusted");
});

test("the admin handle path takes a first-seen pool to restricted only with passing probe facts", () => {
  const handle = { stage: "unknown", decision: "restrict", adminHandleRestrict: true } as const;
  assert.equal(both(pool(handle)).stage, "restricted");
  assert.equal(both(pool({ ...handle, probe: { ...passing, codeHashMatches: false } })).stage, "unknown");
  assert.equal(both(pool({ ...handle, fullReview: false })).stage, "unknown");
  assert.equal(both(pool({ ...handle, stage: "probation" })).stage, "restricted");
});

test("an AI decision is applied after this step's reflex", () => {
  // A fee change narrows trusted to restricted first; the allow then needs probe facts to reopen to probation.
  assert.equal(both(pool({ stage: "trusted", changes: ["fee_changed"], decision: "allow" })).stage, "probation");
  assert.equal(
    both(pool({ stage: "trusted", changes: ["fee_changed"], decision: "allow", probe: { ...passing, codeHashMatches: false } })).stage,
    "restricted",
  );
});

test("a watch-only family never opens and always trades deep", () => {
  const watched = pool({ family: "pancake_infinity_cl" });
  assert.deepEqual(both(watched), { stage: "probation", lane: "deep" });
  assert.equal(both(pool({ family: "pancake_infinity_cl", stage: "unknown", decision: "allow" })).stage, "unknown");
  assert.equal(both(pool({ family: null, stage: "unknown", decision: "allow" })).stage, "unknown");
});

test("a stored stage outside the closed list becomes blocked and trades deep", () => {
  assert.deepEqual(both(pool({ stage: null })), { stage: "blocked", lane: "deep" });
  assert.deepEqual(both(pool({ stage: null, decision: "allow" })), { stage: "blocked", lane: "deep" });
});

test("an old card or an amount over the cap takes the standard lane", () => {
  assert.equal(both(pool({ cardFresh: false })).lane, "standard");
  assert.equal(both(pool({ amountWithinCap: false })).lane, "standard");
  assert.equal(both(pool({ stage: "restricted" })).lane, "standard");
});
