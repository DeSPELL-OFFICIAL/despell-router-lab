// Replaying the router's past judgments through the circuit.
//
// Every patrol step the journal records is encoded (journal.ts) and its input bits are given to the circuit: the
// committed netlist evaluated here, or `eval` on X Layer. The circuit's stage is compared with the stage the server
// wrote. The lane is not compared: the journal has none (journal.ts says why).

import { decodeOutput, encodeInput } from "./bits.ts";
import { encodeJournal, NOT_REPLAYABLE, type JournalExport, type NotReplayableReason } from "./journal.ts";
import type { Stage } from "./rule.ts";

/** Gives the circuit's output bits for an input vector. Called once per distinct vector. */
export type CircuitJudge = (vector: number) => Promise<number> | number;

export type Difference = {
  readonly pool: string;
  readonly at: string;
  readonly server: Stage;
  readonly circuit: Stage;
  readonly vector: number;
};

export type ReplayReport = {
  /** Journal lines read. */
  readonly lines: number;
  /** Lines that are not part of a patrol step (operator lines). */
  readonly otherLines: number;
  /** Patrol steps found. */
  readonly steps: number;
  /** Steps whose input bits could be built and were given to the circuit. */
  readonly replayed: number;
  /** Replayed steps where the circuit's stage equals the server's. */
  readonly same: number;
  readonly differences: readonly Difference[];
  readonly notReplayable: Readonly<Record<NotReplayableReason, number>>;
  readonly notReplayableSteps: readonly { readonly pool: string; readonly at: string; readonly reason: NotReplayableReason }[];
  /** Distinct input vectors the circuit was asked about. */
  readonly vectors: number;
};

export async function replayJournal(journal: JournalExport, circuit: CircuitJudge): Promise<ReplayReport> {
  const { encoded, other } = encodeJournal(journal);
  const notReplayable = Object.fromEntries(Object.keys(NOT_REPLAYABLE).map((key) => [key, 0])) as Record<NotReplayableReason, number>;
  const notReplayableSteps: { pool: string; at: string; reason: NotReplayableReason }[] = [];
  const replayable: { pool: string; at: string; vector: number; server: Stage }[] = [];
  for (const item of encoded) {
    if (item.kind === "not_replayable") {
      notReplayable[item.reason] += 1;
      notReplayableSteps.push({ pool: item.step.pool, at: item.step.at, reason: item.reason });
    } else {
      replayable.push({ pool: item.step.pool, at: item.step.at, vector: encodeInput(item.input), server: item.serverStage });
    }
  }

  const outputs = new Map<number, Stage>();
  for (const vector of new Set(replayable.map((item) => item.vector))) {
    outputs.set(vector, decodeOutput(await circuit(vector)).stage);
  }

  const differences: Difference[] = [];
  for (const item of replayable) {
    const circuitStage = outputs.get(item.vector) as Stage;
    if (circuitStage !== item.server) differences.push({ pool: item.pool, at: item.at, server: item.server, circuit: circuitStage, vector: item.vector });
  }
  return {
    lines: journal.lines.length,
    otherLines: other.length,
    steps: encoded.length,
    replayed: replayable.length,
    same: replayable.length - differences.length,
    differences,
    notReplayable,
    notReplayableSteps,
    vectors: outputs.size,
  };
}

/** The report as plain text: the count line first, then every difference and every step that could not be replayed. */
export function formatReplay(report: ReplayReport): string {
  const out: string[] = [];
  out.push(`${report.same} of ${report.replayed} replayed patrol steps: the circuit's stage equals the server's`);
  out.push(
    `${report.lines} journal lines · ${report.steps} patrol steps · ${report.replayed} replayed · ${report.steps - report.replayed} not replayable · ${report.otherLines} operator lines (not steps) · ${report.vectors} distinct inputs`,
  );
  for (const [reason, count] of Object.entries(report.notReplayable)) {
    if (count > 0) out.push(`  not replayable, ${NOT_REPLAYABLE[reason as NotReplayableReason]}: ${count}`);
  }
  if (report.differences.length > 0) {
    out.push("differences (pool, time UTC, server stage, circuit stage):");
    for (const d of report.differences) out.push(`  ${d.pool}  ${d.at}  server ${d.server}  circuit ${d.circuit}  (vector ${d.vector})`);
  }
  if (report.notReplayableSteps.length > 0) {
    out.push("not replayable (pool, time UTC, reason):");
    for (const s of report.notReplayableSteps) out.push(`  ${s.pool}  ${s.at}  ${NOT_REPLAYABLE[s.reason]}`);
  }
  return out.join("\n");
}
