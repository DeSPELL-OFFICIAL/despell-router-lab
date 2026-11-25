import assert from "node:assert/strict";
import { test } from "node:test";
import { formatOkb, tapeoutCost } from "../src/cost.ts";
import { amountWithinCap, cardFresh, hiddenLossBps, poolCapRaw, probeFactsFrom, tokenPermissionsClear } from "../src/measure.ts";

test("probe facts: unmeasured is failed, the fee is taken off the loss only when known", () => {
  assert.deepEqual(probeFactsFrom({ roundTripLossBps: 189, roundTripFeeBps: 190, sellReverted: false, codeHashMatches: true }), {
    lossUnderReflexLine: true,
    hiddenLossWithinOpenLimit: true,
    sellNotReverted: true,
    codeHashMatches: true,
  });
  assert.deepEqual(probeFactsFrom({}), {
    lossUnderReflexLine: false,
    hiddenLossWithinOpenLimit: false,
    sellNotReverted: false,
    codeHashMatches: false,
  });
  assert.equal(hiddenLossBps(248, null), 248);
  assert.equal(hiddenLossBps(248, 190), 58);
  assert.equal(hiddenLossBps(100, 190), 0);
  assert.equal(hiddenLossBps(Number.NaN, 0), null);
  // 300bp is the reflex line itself: not under it.
  assert.equal(probeFactsFrom({ roundTripLossBps: 300, roundTripFeeBps: 250 }).lossUnderReflexLine, false);
  assert.equal(probeFactsFrom({ roundTripLossBps: 300, roundTripFeeBps: 250 }).hiddenLossWithinOpenLimit, true);
  assert.equal(probeFactsFrom({ sellReverted: null }).sellNotReverted, false);
});

test("token permissions are clear only when all eight flags read false", () => {
  const clear = { hasBlacklist: false, mintable: false, ownerCanModify: false, transferPausable: false };
  assert.equal(tokenPermissionsClear([clear, clear]), true);
  assert.equal(tokenPermissionsClear([clear, { ...clear, mintable: true }]), false);
  assert.equal(tokenPermissionsClear([clear, { ...clear, mintable: null }]), false);
  assert.equal(tokenPermissionsClear([clear]), false);
  assert.equal(tokenPermissionsClear(undefined), false);
});

test("a card is fresh for 26 hours and may be at most 5 minutes ahead", () => {
  const now = Date.UTC(2026, 10, 26);
  assert.equal(cardFresh(now, now - 26 * 3_600_000), true);
  assert.equal(cardFresh(now, now - 26 * 3_600_000 - 1), false);
  assert.equal(cardFresh(now, now + 5 * 60_000), true);
  assert.equal(cardFresh(now, now + 5 * 60_000 + 1), false);
  assert.equal(cardFresh(Number.NaN, now), false);
});

test("the amount must fit the base cap times the card multiplier, held to the stage ceiling", () => {
  const base = { baseCapRaw: 1_000_000n, origin: "seeded" as const };
  assert.equal(amountWithinCap({ ...base, amountRaw: 320_000n, capMultiplier: 1, stage: "probation" }), true);
  assert.equal(amountWithinCap({ ...base, amountRaw: 320_001n, capMultiplier: 1, stage: "probation" }), false);
  assert.equal(amountWithinCap({ ...base, amountRaw: 100_000n, capMultiplier: 1, stage: "probation", origin: "registered" }), true);
  assert.equal(amountWithinCap({ ...base, amountRaw: 100_001n, capMultiplier: 1, stage: "probation", origin: "registered" }), false);
  assert.equal(amountWithinCap({ ...base, amountRaw: 1n, capMultiplier: 1, stage: "unknown" }), false);
  assert.equal(amountWithinCap({ ...base, amountRaw: 0n, capMultiplier: 1, stage: "trusted" }), false);
  assert.equal(amountWithinCap({ ...base, amountRaw: 1n, baseCapRaw: null, capMultiplier: 1, stage: "trusted" }), false);
  assert.equal(amountWithinCap({ ...base, amountRaw: 1, capMultiplier: 1, stage: "trusted" }), false);
  assert.equal(amountWithinCap({ ...base, amountRaw: 1n, capMultiplier: 1, stage: "trusted" }), true);
});

test("the cap keeps the server's rounding, float error included", () => {
  // 0.57 × 10,000 is 5,699.999… in floating point; the server floors it to 5,699 steps.
  assert.equal(poolCapRaw(10_000n, 0.57), 5_699n);
  const trusted = { baseCapRaw: 10_000n, capMultiplier: 0.57, stage: "trusted" as const, origin: "seeded" as const };
  assert.equal(amountWithinCap({ ...trusted, amountRaw: 5_699n }), true);
  assert.equal(amountWithinCap({ ...trusted, amountRaw: 5_700n }), false);
  assert.equal(poolCapRaw(1_000_000n, Number.NaN), 0n);
  assert.equal(poolCapRaw(1_000_000n, 2), 1_000_000n);
});

test("tape-out cost: 0.0013 OKB plus 0.0001 OKB per NAND, plus one mint call's protocol fee", () => {
  const cost = tapeoutCost(157);
  assert.equal(formatOkb(cost.feesWei), "0.017");
  assert.equal(formatOkb(cost.totalWei), "0.01766");
  assert.equal(formatOkb(tapeoutCost(12).totalWei), "0.00316");
  assert.throws(() => tapeoutCost(0));
});
