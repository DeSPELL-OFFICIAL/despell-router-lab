// From readings to the circuit's fact bits.
//
// The circuit only takes yes/no facts. The comparisons that make them (a loss against 300bp, a card's age against
// 26 hours, an amount against a cap) stay outside the circuit. They are restated here from the server's rules, so
// anyone can turn the same readings into the same input bits. Pure module.

import type { ProbeFacts, Stage } from "./rule.ts";

/** A round trip loss at or above this fires the reflex and blocks opening (`POOL_ROUND_TRIP_LOSS_ABSOLUTE_BPS`). */
export const ROUND_TRIP_LOSS_ABSOLUTE_BPS = 300;
/** Opening needs the hidden loss at or below this (`POOL_OPEN_MAX_LOSS_BPS`). */
export const OPEN_MAX_HIDDEN_LOSS_BPS = 100;
/** A card older than this is stale (`POOL_STALE_AFTER_MS`). */
export const STALE_AFTER_MS = 26 * 60 * 60_000;
/** A card dated more than this ahead of now is not trusted (`POOL_FUTURE_SKEW_MS`). */
export const FUTURE_SKEW_MS = 5 * 60_000;
/** Cap multiplier ceiling per stage (`POOL_TRUST_CAP_MULTIPLIER`). */
export const CAP_CEILINGS: Readonly<Record<Stage, number>> = { unknown: 0, probation: 0.32, trusted: 1, restricted: 0.1, blocked: 0 };
/** A pool anyone registered gets this smaller ceiling while on probation. */
export const REGISTERED_PROBATION_CEILING = 0.1;
/** The token permission flags, per token. */
export const TOKEN_PERMISSION_FIELDS = ["hasBlacklist", "mintable", "ownerCanModify", "transferPausable"] as const;

/** A reading counts as measured when it is a number from 0 up, not NaN and not infinite. */
function measured(reading: unknown): reading is number {
  return typeof reading === "number" && reading >= 0 && reading !== Number.POSITIVE_INFINITY;
}

/**
 * The hidden loss (`poolOpeningHiddenLossBps`): the loss the pool's own round trip fee does not explain, never below 0.
 * null when the loss was not measured. A fee that was not measured is not taken off (closing side).
 */
export function hiddenLossBps(loss: unknown, fee: unknown): number | null {
  if (!measured(loss)) return null;
  const unexplained = measured(fee) ? loss - fee : loss;
  return unexplained < 0 ? 0 : unexplained;
}

export type ProbeReading = {
  readonly roundTripLossBps?: unknown;
  readonly roundTripFeeBps?: unknown;
  readonly sellReverted?: unknown;
  readonly codeHashMatches?: unknown;
};

/** The four probe fact bits (`probeFactsPass`). Anything not measured is false. */
export function probeFactsFrom(reading: ProbeReading): ProbeFacts {
  const loss = reading.roundTripLossBps;
  const hidden = hiddenLossBps(loss, reading.roundTripFeeBps);
  return {
    lossUnderReflexLine: measured(loss) && loss < ROUND_TRIP_LOSS_ABSOLUTE_BPS,
    hiddenLossWithinOpenLimit: hidden !== null && hidden <= OPEN_MAX_HIDDEN_LOSS_BPS,
    sellNotReverted: reading.sellReverted === false,
    codeHashMatches: reading.codeHashMatches === true,
  };
}

/**
 * True when both tokens read false on all four permission flags (`poolTokenPermissionStatus` is `clear`). A flag
 * that is missing or not a boolean counts as unread, and unread is not clear.
 */
export function tokenPermissionsClear(tokenPermissions: unknown): boolean {
  if (!Array.isArray(tokenPermissions) || tokenPermissions.length !== 2) return false;
  for (const token of tokenPermissions as unknown[]) {
    if (typeof token !== "object" || token === null) return false;
    const flags = token as Record<string, unknown>;
    if (TOKEN_PERMISSION_FIELDS.some((field) => flags[field] !== false)) return false;
  }
  return true;
}

/** The lane's time checks (`poolLane`): both clocks are real numbers, the card is at most 26 h old and 5 min ahead. */
export function cardFresh(nowMs: number, checkedAtMs: number): boolean {
  const age = nowMs - checkedAtMs;
  if (Number.isNaN(age) || !Number.isFinite(nowMs) || !Number.isFinite(checkedAtMs)) return false;
  return age <= STALE_AFTER_MS && -age <= FUTURE_SKEW_MS;
}

/** Highest cap multiplier a stage allows (`maxCapFor`). */
export function maxCapFor(stage: Stage, origin: "seeded" | "registered"): number {
  return stage === "probation" && origin === "registered" ? REGISTERED_PROBATION_CEILING : CAP_CEILINGS[stage];
}

/** The cap is counted in ten-thousandths of the base cap. */
const STEPS = 10_000;

/**
 * This pool's cap in raw units (`poolCapRaw`): whole ten-thousandths of the base cap, the multiplier held to 1.
 * A multiplier that is not a positive finite number gives no cap. The steps are floored from the floating-point
 * product exactly as the server does, float error included (0.57 gives 5,699 steps, not 5,700): the bit must match
 * what the server decided, not what the multiplier means.
 */
export function poolCapRaw(baseCapRaw: bigint, capMultiplier: number): bigint {
  if (!(capMultiplier > 0 && capMultiplier < Number.POSITIVE_INFINITY)) return 0n;
  const steps = Math.floor(STEPS * (capMultiplier > 1 ? 1 : capMultiplier));
  return (BigInt(steps) * baseCapRaw) / BigInt(STEPS);
}

/**
 * The lane's amount checks (`poolLane`): amount and base cap are positive bigints and the amount fits the base cap
 * times the card's multiplier, the multiplier first held to its stage's ceiling. A stage outside the closed list fits nothing.
 */
export function amountWithinCap(input: {
  readonly amountRaw: unknown;
  readonly baseCapRaw: unknown;
  readonly capMultiplier: number;
  readonly stage: Stage | null;
  readonly origin: "seeded" | "registered";
}): boolean {
  const { amountRaw, baseCapRaw, stage } = input;
  if (typeof amountRaw !== "bigint" || typeof baseCapRaw !== "bigint" || stage === null) return false;
  if (amountRaw <= 0n || baseCapRaw <= 0n) return false;
  const ceiling = maxCapFor(stage, input.origin);
  return amountRaw <= poolCapRaw(baseCapRaw, Math.min(input.capMultiplier, ceiling));
}
