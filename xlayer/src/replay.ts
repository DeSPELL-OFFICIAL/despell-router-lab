// Replaying the router's past judgments through the circuit.
//
// Every patrol step the journal records is encoded (journal.ts) and its input bits are given to the circuit: the
// committed netlist evaluated here, or `eval` on X Layer. The circuit's stage is compared with the stage the server
// wrote. The lane is not compared: the journal has none (journal.ts says why).
//
// The count that matters is on judged steps, where the AI's judgment was applied: there the circuit has to rebuild the
// whole transition. Steps with only a reflex, or with nothing that moves the stage, are counted on their own lines so
// they do not swell it.

import { decodeOutput, encodeInput } from "./bits.ts";
import { encodeJournal, NOT_REPLAYABLE, STEP_KINDS, type JournalExport, type NotReplayableReason, type StepKind } from "./journal.ts";
import type { Stage } from "./rule.ts";

/** Gives the circuit's output bits for an input vector. Called once per distinct vector. */
export type CircuitJudge = (vector: number) => Promise<number> | number;

/**
 * Why a replayed step differs:
 *   - stage: the circuit's stage is not the server's;
 *   - proposal_outside_rules: the recorded proposal is not one the circuit's rules give from the journal's facts (a
 *     line written under an older rule, for instance). Counted as a difference whatever the circuit answers.
 */
export const DIFFERENCE_REASONS = ["stage", "proposal_outside_rules"] as const;
export type DifferenceReason = (typeof DIFFERENCE_REASONS)[number];

export type Difference = {
  readonly pool: string;
  readonly at: string;
  readonly stepKind: StepKind;
  readonly reason: DifferenceReason;
  readonly server: Stage;
  readonly circuit: Stage;
  readonly vector: number;
  /** For `proposal_outside_rules`: the proposal the journal records and the one the circuit's rules give. */
  readonly proposal: { readonly recorded: Stage; readonly rules: Stage } | null;
};

export type Tally = { readonly replayed: number; readonly same: number };

export type ReplayReport = {
  /** Journal lines read. */
  readonly lines: number;
  /** Lines that are not part of a patrol step (operator lines, trade checks). */
  readonly otherLines: number;
  /** The same lines by actor and reason, such as `probe trade_check` or `operator operator_blocked`. */
  readonly otherByReason: Readonly<Record<string, number>>;
  /** Patrol steps found. */
  readonly steps: number;
  /** Steps whose input bits could be built and were given to the circuit, all kinds together. */
  readonly replayed: number;
  /** Replayed steps where the circuit agrees with the server's stage, all kinds together. */
  readonly same: number;
  /** The same two counts per kind of step. `judged` is the headline. */
  readonly byKind: Readonly<Record<StepKind, Tally>>;
  readonly differences: readonly Difference[];
  readonly notReplayable: Readonly<Record<NotReplayableReason, number>>;
  readonly notReplayableSteps: readonly { readonly pool: string; readonly at: string; readonly reason: NotReplayableReason }[];
  /** Steps of pools whose family the circuit does not know: judged by a server rule newer than the circuit. */
  readonly newerRule: readonly { readonly pool: string; readonly at: string; readonly family: string }[];
  /** Distinct input vectors the circuit was asked about. */
  readonly vectors: number;
};

export async function replayJournal(journal: JournalExport, circuit: CircuitJudge): Promise<ReplayReport> {
  const { encoded, other } = encodeJournal(journal);
  const notReplayable = Object.fromEntries(Object.keys(NOT_REPLAYABLE).map((key) => [key, 0])) as Record<NotReplayableReason, number>;
  const notReplayableSteps: { pool: string; at: string; reason: NotReplayableReason }[] = [];
  const newerRule: { pool: string; at: string; family: string }[] = [];
  const replayable: {
    pool: string;
    at: string;
    stepKind: StepKind;
    vector: number;
    server: Stage;
    proposal: { recorded: Stage; rules: Stage } | null;
  }[] = [];
  for (const item of encoded) {
    if (item.kind === "not_replayable") {
      notReplayable[item.reason] += 1;
      notReplayableSteps.push({ pool: item.step.pool, at: item.step.at, reason: item.reason });
    } else if (item.kind === "newer_rule") {
      newerRule.push({ pool: item.step.pool, at: item.step.at, family: item.family });
    } else {
      replayable.push({
        pool: item.step.pool,
        at: item.step.at,
        stepKind: item.stepKind,
        vector: encodeInput(item.input),
        server: item.serverStage,
        proposal: item.proposalOutsideRules,
      });
    }
  }

  const outputs = new Map<number, Stage>();
  for (const vector of new Set(replayable.map((item) => item.vector))) {
    outputs.set(vector, decodeOutput(await circuit(vector)).stage);
  }

  const differences: Difference[] = [];
  const byKind = Object.fromEntries(STEP_KINDS.map((kind) => [kind, { replayed: 0, same: 0 }])) as Record<StepKind, { replayed: number; same: number }>;
  for (const item of replayable) {
    const circuitStage = outputs.get(item.vector) as Stage;
    byKind[item.stepKind].replayed += 1;
    const reason: DifferenceReason | null = item.proposal ? "proposal_outside_rules" : circuitStage !== item.server ? "stage" : null;
    if (reason === null) byKind[item.stepKind].same += 1;
    else differences.push({ pool: item.pool, at: item.at, stepKind: item.stepKind, reason, server: item.server, circuit: circuitStage, vector: item.vector, proposal: item.proposal });
  }
  const otherByReason: Record<string, number> = {};
  for (const line of other) otherByReason[`${line.actor} ${line.reason}`] = (otherByReason[`${line.actor} ${line.reason}`] ?? 0) + 1;
  return {
    lines: journal.lines.length,
    otherLines: other.length,
    otherByReason,
    steps: encoded.length,
    replayed: replayable.length,
    same: replayable.length - differences.length,
    byKind,
    differences,
    notReplayable,
    notReplayableSteps,
    newerRule,
    vectors: outputs.size,
  };
}

const KIND_LABEL: Readonly<Record<StepKind, string>> = { judged: "judged", reflex_only: "reflex only", unchanged: "unchanged" };

/** The report as plain text: the judged-step count first, then the other kinds, then every listed step. */
export function formatReplay(report: ReplayReport): string {
  const out: string[] = [];
  const { judged } = report.byKind;
  out.push(`${judged.same} of ${judged.replayed} judged patrol steps agree: the circuit gives the stage the server wrote`);
  out.push(
    `by kind: ${STEP_KINDS.map((kind) => `${KIND_LABEL[kind]} ${report.byKind[kind].same} of ${report.byKind[kind].replayed}`).join(" · ")} · all ${report.same} of ${report.replayed}`,
  );
  out.push(
    `journal lines ${report.lines} · patrol steps ${report.steps} · replayed ${report.replayed} · not replayable ${report.notReplayableSteps.length} · newer rule than the circuit ${report.newerRule.length} · lines outside patrol steps ${report.otherLines} · distinct inputs ${report.vectors}`,
  );
  if (report.otherLines > 0) {
    const reasons = Object.entries(report.otherByReason).sort(([a], [b]) => (a < b ? -1 : 1));
    out.push(`  lines outside patrol steps: ${reasons.map(([reason, count]) => `${reason} ${count}`).join(" · ")}`);
  }
  if (report.differences.length > 0) {
    const count = (reason: DifferenceReason) => report.differences.filter((d) => d.reason === reason).length;
    out.push(`  differences ${report.differences.length}: the circuit's stage ${count("stage")} · a recorded proposal outside the circuit's rules ${count("proposal_outside_rules")}`);
  }
  for (const [reason, count] of Object.entries(report.notReplayable)) {
    if (count > 0) out.push(`  not replayable, ${NOT_REPLAYABLE[reason as NotReplayableReason]}: ${count}`);
  }
  if (report.newerRule.length > 0) {
    const families = [...new Set(report.newerRule.map((s) => s.family))].sort();
    out.push(`  newer rule than the circuit, a family the circuit does not know (${families.join(", ")}): ${report.newerRule.length}`);
  }
  if (report.differences.length > 0) {
    out.push("differences (pool, time UTC, kind, reason, server stage, circuit stage):");
    for (const d of report.differences) {
      const why = d.proposal
        ? `proposal outside the rules: recorded ${d.proposal.recorded}, the circuit's rules give ${d.proposal.rules} from the journal's facts`
        : "stage";
      out.push(`  ${d.pool}  ${d.at}  ${KIND_LABEL[d.stepKind]}  ${why}  server ${d.server}  circuit ${d.circuit}  (vector ${d.vector})`);
    }
  }
  if (report.notReplayableSteps.length > 0) {
    out.push("not replayable (pool, time UTC, reason):");
    for (const s of report.notReplayableSteps) out.push(`  ${s.pool}  ${s.at}  ${NOT_REPLAYABLE[s.reason]}`);
  }
  if (report.newerRule.length > 0) {
    out.push("newer rule than the circuit (pool, time UTC, family):");
    for (const s of report.newerRule) out.push(`  ${s.pool}  ${s.at}  ${s.family}`);
  }
  return out.join("\n");
}
