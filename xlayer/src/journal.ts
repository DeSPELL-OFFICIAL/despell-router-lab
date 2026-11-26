// From the router's journal to the circuit's input bits, one patrol step at a time.
//
// The patrol writes every step for a pool as a few journal lines that share the pool, the time and the reading's
// fingerprint: one line per reflex, one probe line, the AI team's lines (the judge's line carries the proposal) and,
// when a judgment was applied, one trust transition line with the probe numbers. This module reads lines in a neutral
// export shape (`JournalExport`), groups them into steps and turns each step into a `JudgmentInput` and the stage the
// server wrote after it.
//
// What the journal records, and so what a replay can check:
//   - The stage before and after the reflex, the changes that tightened it, and the stage after the step.
//   - The judge's proposal (`proposedState`), not the AI's raw decision. The decision bits are read back the way the
//     server reads its own journal (`decisionOfProposedState`, scope from the line's reason), and a step whose bits do
//     not give back the recorded proposal is counted as not replayable instead of guessed.
//   - No lane. A lane is decided per trade and is not journaled, so a replay compares the stage only; the lane-only pins
//     (operator block, card age, amount) are fixed.
//
// Pure module: no I/O.

import { probeFactsFrom } from "./measure.ts";
import { CHANGE_KINDS, FAMILIES, proposedStage, STAGES, type ChangeKind, type Decision, type Family, type JudgmentInput, type Stage } from "./rule.ts";

/** The only chain the patrol judges: GIWA Sepolia. */
export const JOURNAL_CHAIN_ID = 91342;

export const ACTORS = ["reflex", "role", "operator", "probe", "trust_rule"] as const;
export type Actor = (typeof ACTORS)[number];

/** One journal line in the export shape. */
export type JournalLine = {
  /** Pool address, 0x and 40 lowercase hex digits. */
  readonly pool: string;
  /** When the step ran, ISO 8601 in UTC. */
  readonly at: string;
  /** Write order. Lines of one step are read in this order. */
  readonly seq: number;
  readonly actor: Actor;
  /** The change kind for a reflex line, the role for a role line, otherwise null. */
  readonly detail: string | null;
  readonly reason: string;
  readonly evidence: Readonly<Record<string, unknown>>;
  /** Stage before and after this line. */
  readonly before: string;
  readonly after: string;
  /** Fingerprint of the reading that produced the line; null for lines written without a reading (operator). */
  readonly fingerprint: string | null;
};

/** A pool's family, from its card. */
export type PoolFamily = { readonly pool: string; readonly family: string };

/** What a reader hands the replay: every line, and the family of every pool that has a card. */
export type JournalExport = {
  readonly chainId: number;
  readonly lines: readonly JournalLine[];
  readonly pools: readonly PoolFamily[];
};

const ADDRESS = /^0x[0-9a-f]{40}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

function fail(where: string, what: string): never {
  throw new Error(`journal export: ${where}: ${what}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks an export (parsed JSON) and returns it typed. Anything off shape throws with the line number, so a bad
 * export stops the replay instead of turning into wrong bits.
 */
export function parseJournalExport(raw: unknown): JournalExport {
  if (!isRecord(raw)) fail("root", "not an object");
  if (raw.chainId !== JOURNAL_CHAIN_ID) fail("chainId", `expected ${JOURNAL_CHAIN_ID}, got ${String(raw.chainId)}`);
  if (!Array.isArray(raw.lines)) fail("lines", "not an array");
  if (!Array.isArray(raw.pools)) fail("pools", "not an array");
  const lines = raw.lines.map((line: unknown, i: number): JournalLine => {
    const at = `lines[${i}]`;
    if (!isRecord(line)) fail(at, "not an object");
    const { pool, seq, actor, detail, reason, evidence, before, after, fingerprint } = line;
    if (typeof pool !== "string" || !ADDRESS.test(pool)) fail(at, "pool is not a lowercase address");
    if (typeof line.at !== "string" || !ISO_UTC.test(line.at)) fail(at, "at is not an ISO time in UTC");
    if (typeof seq !== "number" || !Number.isSafeInteger(seq)) fail(at, "seq is not an integer");
    if (!(ACTORS as readonly unknown[]).includes(actor)) fail(at, `unknown actor ${String(actor)}`);
    if (detail !== null && typeof detail !== "string") fail(at, "detail is not a string or null");
    if (typeof reason !== "string") fail(at, "reason is not a string");
    if (!isRecord(evidence)) fail(at, "evidence is not an object");
    if (typeof before !== "string" || typeof after !== "string") fail(at, "before/after are not strings");
    if (fingerprint !== null && typeof fingerprint !== "string") fail(at, "fingerprint is not a string or null");
    return { pool, at: line.at, seq, actor: actor as Actor, detail, reason, evidence, before, after, fingerprint };
  });
  const pools = raw.pools.map((entry: unknown, i: number): PoolFamily => {
    const at = `pools[${i}]`;
    if (!isRecord(entry)) fail(at, "not an object");
    if (typeof entry.pool !== "string" || !ADDRESS.test(entry.pool)) fail(at, "pool is not a lowercase address");
    if (typeof entry.family !== "string") fail(at, "family is not a string");
    return { pool: entry.pool, family: entry.family };
  });
  return { chainId: JOURNAL_CHAIN_ID, lines, pools };
}

/** One patrol step: the lines one reading of one pool wrote. */
export type PatrolStep = {
  readonly pool: string;
  readonly at: string;
  readonly fingerprint: string;
  readonly lines: readonly JournalLine[];
};

/**
 * Groups lines into patrol steps (same pool, time and fingerprint), oldest first. Operator lines and any other line
 * without a fingerprint are not patrol steps; they are returned apart and counted, not replayed.
 */
export function patrolSteps(journal: JournalExport): { readonly steps: readonly PatrolStep[]; readonly other: readonly JournalLine[] } {
  const sorted = [...journal.lines].sort((a, b) => a.seq - b.seq);
  const groups = new Map<string, { pool: string; at: string; fingerprint: string; seq: number; lines: JournalLine[] }>();
  const other: JournalLine[] = [];
  for (const line of sorted) {
    if (line.actor === "operator" || line.fingerprint === null) {
      other.push(line);
      continue;
    }
    const key = `${line.pool}|${line.at}|${line.fingerprint}`;
    const group = groups.get(key);
    if (group) group.lines.push(line);
    else groups.set(key, { pool: line.pool, at: line.at, fingerprint: line.fingerprint, seq: line.seq, lines: [line] });
  }
  const ordered = [...groups.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.seq - b.seq));
  const steps = ordered.map(({ pool, at, fingerprint, lines }): PatrolStep => ({ pool, at, fingerprint, lines }));
  return { steps, other };
}

const asStage = (value: unknown): Stage | null => ((STAGES as readonly unknown[]).includes(value) ? (value as Stage) : null);
const asFamily = (value: unknown): Family | null => ((FAMILIES as readonly unknown[]).includes(value) ? (value as Family) : null);
const asChange = (value: unknown): ChangeKind | null => ((CHANGE_KINDS as readonly unknown[]).includes(value) ? (value as ChangeKind) : null);

/** Reasons that mean the judgment came from a full review (the server's `scopeOfTrigger`): first seen, requested, or a code change. */
const FULL_REVIEW_REASONS: ReadonlySet<string> = new Set(["first_seen", "full_review_requested", "code_changed", "token_code_changed", "implementation_changed"]);

/**
 * A proposal read back as a decision (`decisionOfProposedState`): blocked is block, restricted or unknown is restrict,
 * probation or trusted is allow. A proposal that could not open anything was lowered to the current stage, so the read
 * back decision can be tighter than the one the AI gave; the stage it leads to is the same, and `encodeStep` checks it.
 */
export function decisionOfProposal(proposal: Stage): Decision {
  if (proposal === "blocked") return "block";
  if (proposal === "restricted" || proposal === "unknown") return "restrict";
  return "allow";
}

/** Why a step cannot be replayed. Each is counted apart; none is guessed. */
export const NOT_REPLAYABLE = {
  noProbeLine: "no probe line in the step",
  stageNotInList: "a stage outside the closed list",
  noJudgeLine: "a trust transition without the judge's line",
  proposalUnreadable: "the proposal is missing or outside the closed list",
  noFamily: "a judged pool with no card family",
  proposalNotRecovered: "the recorded decision does not give back the recorded proposal",
} as const;
export type NotReplayableReason = keyof typeof NOT_REPLAYABLE;

export type EncodedStep =
  | {
      readonly kind: "replayable";
      readonly step: PatrolStep;
      readonly input: JudgmentInput;
      /** The stage the server wrote after the step. */
      readonly serverStage: Stage;
    }
  | { readonly kind: "not_replayable"; readonly step: PatrolStep; readonly reason: NotReplayableReason };

/**
 * One patrol step → circuit input and the server's stage after it.
 *
 *   - stage: the stage before the step's reflex (the first reflex line's `before`, or the probe line's when no reflex fired).
 *   - changes: every reflex line's change, and the probe line's reason when it is a change (a change with no reflex,
 *     `stale`, writes no reflex line; it never moves the stage).
 *   - decision: null when the step has no trust transition line. That covers every step the AI did not judge: no change,
 *     a watch-only family, a deferred or cut review, a read that came back blocked. A pool under an operator block is
 *     not read at all and has no step.
 *   - decision, full review, admin handle restrict: read back from the judge's proposal and the line's reason, then
 *     checked: the rule's proposal from those bits must equal the recorded one, or the step is not replayable.
 *   - token permissions (pin 18): clear only when both the judge's reading and this step's reading are `clear`.
 *   - probe facts: the trust transition line's numbers, judged as the server judges them (`probeFactsFrom`).
 *   - family: the pool card's family.
 *   - operator block, card age, amount: lane-only pins, fixed (false, fresh, within cap). The journal has no lane.
 */
export function encodeStep(step: PatrolStep, families: ReadonlyMap<string, string>): EncodedStep {
  const notReplayable = (reason: NotReplayableReason): EncodedStep => ({ kind: "not_replayable", step, reason });
  const reflex = step.lines.filter((line) => line.actor === "reflex");
  const probe = step.lines.find((line) => line.actor === "probe");
  if (!probe) return notReplayable("noProbeLine");
  const judge = step.lines.filter((line) => line.actor === "role" && line.detail === "judge").at(-1) ?? null;
  const trust = step.lines.filter((line) => line.actor === "trust_rule").at(-1) ?? null;

  const stage = asStage((reflex[0] ?? probe).before);
  const serverStage = asStage(trust ? trust.after : probe.after);
  if (stage === null || serverStage === null) return notReplayable("stageNotInList");

  const changes = new Set<ChangeKind>();
  for (const line of reflex) {
    const kind = asChange(line.detail);
    if (kind) changes.add(kind);
  }
  const probeChange = asChange(probe.reason);
  if (probeChange) changes.add(probeChange);

  const family = asFamily(families.get(step.pool));
  const fixed = { operatorBlocked: false, cardFresh: true, amountWithinCap: true } as const;
  const noProbe = { lossUnderReflexLine: false, hiddenLossWithinOpenLimit: false, sellNotReverted: false, codeHashMatches: false };

  if (trust === null) {
    const input: JudgmentInput = {
      stage,
      changes,
      decision: null,
      fullReview: false,
      adminHandleRestrict: false,
      tokenPermissionsClear: false,
      family,
      probe: noProbe,
      ...fixed,
    };
    return { kind: "replayable", step, input, serverStage };
  }

  if (judge === null) return notReplayable("noJudgeLine");
  const proposal = asStage(trust.evidence.proposedState);
  const afterReflex = asStage(trust.before);
  if (proposal === null || afterReflex === null) return notReplayable("proposalUnreadable");
  if (families.get(step.pool) === undefined) return notReplayable("noFamily");

  const decision = decisionOfProposal(proposal);
  const fullReview = FULL_REVIEW_REASONS.has(judge.reason);
  const judgeClear = judge.evidence.tokenPermissionStatus === "clear";
  const liveClear = trust.evidence.tokenPermissionStatus === "clear";
  // The only way a restrict proposes `restricted` from `unknown` is the admin handle path.
  const adminHandleRestrict = decision === "restrict" && proposal === "restricted" && afterReflex === "unknown";
  // The server proposed with the judge's token reading; the rule must give back the same proposal from these bits.
  if (proposedStage(decision, afterReflex, fullReview, judgeClear, adminHandleRestrict) !== proposal) return notReplayable("proposalNotRecovered");

  const input: JudgmentInput = {
    stage,
    changes,
    decision,
    fullReview,
    adminHandleRestrict,
    tokenPermissionsClear: judgeClear && liveClear,
    family,
    probe: probeFactsFrom({
      roundTripLossBps: trust.evidence.lossBps,
      roundTripFeeBps: trust.evidence.feeBps,
      sellReverted: trust.evidence.sellReverted,
      codeHashMatches: trust.evidence.codeHashMatches,
    }),
    ...fixed,
  };
  return { kind: "replayable", step, input, serverStage };
}

/** Every step of an export, encoded, plus the lines that are not patrol steps. */
export function encodeJournal(journal: JournalExport): { readonly encoded: readonly EncodedStep[]; readonly other: readonly JournalLine[] } {
  const families = new Map(journal.pools.map((entry) => [entry.pool, entry.family] as const));
  const { steps, other } = patrolSteps(journal);
  return { encoded: steps.map((step) => encodeStep(step, families)), other };
}
