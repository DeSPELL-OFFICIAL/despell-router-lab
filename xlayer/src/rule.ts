// The DeSpell router's pool judgment rules, written out as plain functions.
//
// The router's code is private. This file restates the part of it that decides, for one pool on GIWA Sepolia,
// (1) which stage the patrol writes next and (2) which lane a trade gets right now. Each function names the server
// function it restates; README.md has the rule-by-rule table.
//
// Inputs here are already facts (bits): "the fee changed", "the probe's round trip loss is under 300bp". Turning raw
// readings into those facts lives in measure.ts. The circuit (circuit.ts) is built separately from the same rules,
// and test/circuit.test.ts checks that the two agree on every input combination.
//
// Pure module: no I/O, no clock, no randomness.

/** Pool stages in the server's rank order (`POOL_TRUST_RANK`): a lower index is a tighter stage. */
export const STAGES = ["blocked", "unknown", "restricted", "probation", "trusted"] as const;
export type Stage = (typeof STAGES)[number];

const RANK: Readonly<Record<Stage, number>> = { blocked: 0, unknown: 1, restricted: 2, probation: 3, trusted: 4 };

export function stageRank(stage: Stage): number {
  return RANK[stage];
}

/** The ten changes the patrol detects between a pool's card and a fresh reading, in the server's order (`POOL_CHANGE_KINDS`). */
export const CHANGE_KINDS = [
  "code_changed",
  "token_code_changed",
  "implementation_changed",
  "owner_changed",
  "paused",
  "fee_changed",
  "reserve_below_band",
  "round_trip_loss_up",
  "sell_reverted",
  "stale",
] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/**
 * The reflex for each change (`POOL_REFLEX_BY_CHANGE`). `block` and `restrict` tighten the stage at once, without
 * waiting for the AI. `close` leaves the stage alone and closes the lane. `none` leaves the stage alone.
 */
export const REFLEX_BY_CHANGE: Readonly<Record<ChangeKind, "block" | "restrict" | "close" | "none">> = {
  code_changed: "block",
  token_code_changed: "block",
  implementation_changed: "block",
  owner_changed: "restrict",
  paused: "close",
  fee_changed: "restrict",
  reserve_below_band: "restrict",
  round_trip_loss_up: "restrict",
  sell_reverted: "block",
  stale: "none",
};

/** Changes that send a trade down the deep lane (`POOL_CODE_CHANGE_KINDS`). */
export const CODE_CHANGE_KINDS: readonly ChangeKind[] = ["code_changed", "token_code_changed", "implementation_changed"];

/** Pool families the patrol knew as of 2026-11-25 UTC (`POOL_FAMILIES`). Families added later are outside this list (README). */
export const FAMILIES = ["ammora_curve", "uniswap_v3", "pancake_infinity_cl"] as const;
export type Family = (typeof FAMILIES)[number];

/**
 * Families a person has approved for execution (`POOL_OPENABLE_FAMILIES`). Any other family is watch-only: nothing
 * opens it, and a trade through it always takes the deep lane.
 */
export const OPENABLE_FAMILIES: ReadonlySet<Family> = new Set<Family>(["uniswap_v3", "ammora_curve"]);

/** What the AI team decided after the code's floor rules (`POOL_TEAM_DECISIONS`). */
export const DECISIONS = ["allow", "restrict", "block"] as const;
export type Decision = (typeof DECISIONS)[number];

/** Trade lanes, from fastest to most careful (`POOL_LANES`). */
export const LANES = ["fast", "standard", "deep", "closed"] as const;
export type Lane = (typeof LANES)[number];

/**
 * The probe facts an opening move needs (`PoolTrustProbeFacts`, judged by `probeFactsPass`). Each one is true only when
 * it was measured and passed: unmeasured counts as failed. measure.ts derives them from the probe's numbers.
 */
export type ProbeFacts = {
  /** The raw round trip loss was measured and is under the reflex line (300bp). */
  readonly lossUnderReflexLine: boolean;
  /** The hidden loss (raw loss minus the pool's own round trip fee) was measured and is at most 100bp. */
  readonly hiddenLossWithinOpenLimit: boolean;
  /** The probe sold back and the sell did not revert (`sellReverted === false`). */
  readonly sellNotReverted: boolean;
  /** The pool and token code fingerprints read now match the card (`codeHashMatches === true`). */
  readonly codeHashMatches: boolean;
};

export type JudgmentInput = {
  /**
   * The stage on the pool's card. null stands for a stored stage outside the closed list. The database's check
   * constraint keeps that from being stored; the rule still answers for it (blocked, closing side).
   * A pool seen for the first time has no card; the patrol starts it as `unknown` with no changes.
   */
  readonly stage: Stage | null;
  /** The changes found in this reading (`diffPoolCard`). */
  readonly changes: ReadonlySet<ChangeKind>;
  /** An operator block covers this pool, its tokens, its deployer or its code family (`isOperatorBlocked`). */
  readonly operatorBlocked: boolean;
  /** The AI team's decision applied in this patrol step, or null when no judgment was applied (no change, skipped, deferred). */
  readonly decision: Decision | null;
  /** The judgment came from a full review (`scope === "full"`), not a partial one. */
  readonly fullReview: boolean;
  /** The decision is a `restrict` that met every condition of the admin handle path (`adminHandleRestrict`). */
  readonly adminHandleRestrict: boolean;
  /** Both tokens read clear of blacklist, mint, owner-modify and transfer-pause powers (`poolTokenPermissionStatus === "clear"`). */
  readonly tokenPermissionsClear: boolean;
  /** The pool's family, or null for a stored family outside the closed list. */
  readonly family: Family | null;
  readonly probe: ProbeFacts;
  /** The card was checked within 26 hours and is not more than 5 minutes in the future (`poolLane` time checks). */
  readonly cardFresh: boolean;
  /** The trade amount and the base cap are positive and the amount fits this pool's cap (`poolLane` amount checks). */
  readonly amountWithinCap: boolean;
};

export type Judgment = {
  /** The stage the patrol writes after this step. */
  readonly stage: Stage;
  /** The lane a trade gets right now, on the card as it stands. */
  readonly lane: Lane;
};

// ── Reflex (server: reflexFor, applyReflex) ──────────────────────────────────────────────────────────────────────────

/** `reflexFor`: the tightest stage the reflex asks for, or null when no change tightens the stage. */
export function reflexStage(changes: ReadonlySet<ChangeKind>): "blocked" | "restricted" | null {
  let restrict = false;
  for (const kind of changes) {
    const action = REFLEX_BY_CHANGE[kind];
    if (action === "block") return "blocked";
    if (action === "restrict") restrict = true;
  }
  return restrict ? "restricted" : null;
}

/** `applyReflex`: the reflex only tightens, so the stage becomes the lower of the two. */
export function applyReflex(stage: Stage, reflex: "blocked" | "restricted" | null): Stage {
  return reflex !== null && RANK[reflex] < RANK[stage] ? reflex : stage;
}

// ── AI decision → proposed stage (server: poolTrustProposal) ─────────────────────────────────────────────────────────

/** The lower of two stages (`holdingProposal`): a proposal that cannot open anything. */
function lower(a: Stage, b: Stage): Stage {
  return RANK[a] < RANK[b] ? a : b;
}

/**
 * `poolTrustProposal`, stage part. `stage` is the ledger after this step's reflex.
 *   - block: blocked.
 *   - restrict: never above the current stage, except the admin handle path on a first-seen pool, which proposes restricted.
 *   - allow: probation (trusted stays trusted), but only from a full review with clear token permissions; otherwise never
 *     above the current stage.
 */
export function proposedStage(
  decision: Decision,
  stage: Stage,
  fullReview: boolean,
  tokenPermissionsClear: boolean,
  adminHandleRestrict: boolean,
): Stage {
  switch (decision) {
    case "block":
      return "blocked";
    case "restrict":
      if (adminHandleRestrict && tokenPermissionsClear && fullReview && stage === "unknown") return "restricted";
      return lower("restricted", stage);
    case "allow": {
      const target: Stage = stage === "trusted" ? "trusted" : "probation";
      return fullReview && tokenPermissionsClear ? target : lower(target, stage);
    }
  }
}

// ── Trust transition (server: nextTrustState) ──────────────────────────────────────────────────────────────────────

/** `probeFactsPass`: an opening move needs every probe fact measured and passing, and clear token permissions. */
export function probePass(probe: ProbeFacts, tokenPermissionsClear: boolean): boolean {
  return (
    probe.lossUnderReflexLine &&
    probe.hiddenLossWithinOpenLimit &&
    probe.sellNotReverted &&
    probe.codeHashMatches &&
    tokenPermissionsClear
  );
}

/** `poolFamilyOpenable`. */
export function familyOpenable(family: Family | null): boolean {
  return family !== null && OPENABLE_FAMILIES.has(family);
}

/**
 * `nextTrustState`, stage part. Moving down is always accepted. Moving up (opening) needs an approved family and
 * passing probe facts; otherwise the stage stays. Trusted is reached only from probation. The cap multiplier never
 * changes the stage, so it is left out (README, "What the circuit leaves out").
 */
export function nextStage(stage: Stage, proposed: Stage, openable: boolean, pass: boolean): Stage {
  const target: Stage = proposed === "trusted" && RANK[stage] < RANK.probation ? "probation" : proposed;
  if (RANK[target] < RANK[stage]) return target;
  if (RANK[target] > RANK[stage]) return openable && pass ? target : stage;
  return stage;
}

/**
 * One patrol step for one pool (`poolLedgerAfterReflex`, then `patrolTrustStep`): reflex first, then the AI decision
 * on the ledger after the reflex. An operator block does not touch the stage: the block stands beside it and only the
 * lane closes.
 */
export function patrolStage(input: JudgmentInput): Stage {
  // A ledger outside the closed list opens nothing and is lowered to blocked (`nextTrustState`, first line).
  if (input.stage === null) return "blocked";
  const afterReflex = applyReflex(input.stage, reflexStage(input.changes));
  if (input.decision === null) return afterReflex;
  const proposed = proposedStage(input.decision, afterReflex, input.fullReview, input.tokenPermissionsClear, input.adminHandleRestrict);
  return nextStage(afterReflex, proposed, familyOpenable(input.family), probePass(input.probe, input.tokenPermissionsClear));
}

// ── Lane (server: poolLane) ───────────────────────────────────────────────────────────────────────────────────

/**
 * `poolLane`: the lane for a trade right now, from the card and this reading. The first rule that matches wins.
 * The server's "no card" case (a pool never seen) is a card at `unknown` with no changes here; both give the deep lane.
 */
export function tradeLane(input: JudgmentInput): Lane {
  const changes = input.changes;
  if (input.operatorBlocked) return "closed";
  if (changes.has("paused")) return "closed";
  if (input.stage === "blocked" || changes.has("sell_reverted")) return "closed";
  if (CODE_CHANGE_KINDS.some((kind) => changes.has(kind))) return "deep";
  const reflex = reflexStage(changes);
  if (reflex === "blocked") return "closed";
  if (input.stage === null || input.stage === "unknown" || !familyOpenable(input.family)) return "deep";
  if (reflex === "restricted" || input.stage === "restricted" || changes.has("stale")) return "standard";
  if (!input.cardFresh || !input.amountWithinCap) return "standard";
  return "fast";
}

/** The whole judgment the circuit reproduces. */
export function judge(input: JudgmentInput): Judgment {
  return { stage: patrolStage(input), lane: tradeLane(input) };
}
