import type { Judgment } from "@despell-lab/xlayer/src/rule.ts";
import type { ContestGate } from "@/lib/swap/view";
import type { CircuitDeployment } from "./circuit";
import type { CircuitAnswer, CircuitProblem } from "./xlayer-eval";
import type { ServerJudgment } from "./server-judgment";

/*
  The card's check against the pool judgment circuit: the server's judgment
  of the pool compared with the circuit's answer from X Layer for the same
  input bits. A difference holds the card. While the circuit is being asked
  the card is pending, so the button stays off.

  Default (DES-704): when X Layer cannot be reached, nothing is compared and
  the card is not held.
  The server's judgment is the one that decides; the circuit is a second,
  public copy.
*/

export type CircuitCheck =
  /** The server has no judgment of this pool: no circuit line. */
  | { kind: "none" }
  | { kind: "checking"; server: ServerJudgment; deployment: CircuitDeployment }
  | { kind: "same"; server: ServerJudgment; deployment: CircuitDeployment; circuit: Judgment; block: bigint }
  | { kind: "differs"; server: ServerJudgment; deployment: CircuitDeployment; circuit: Judgment; block: bigint }
  | { kind: "unreachable"; server: ServerJudgment; deployment: CircuitDeployment; reason: string }
  /** X Layer answered that the circuit is not there or not this one, or with something that is not a judgment: held. */
  | { kind: "refused"; server: ServerJudgment; deployment: CircuitDeployment; problem: CircuitProblem; reason: string };

/** What the X Layer read looks like right now (from the query that asks it). */
export type EvalState =
  | { status: "asking" }
  /** The read failed in transport (RPC error, timeout): nothing was compared. */
  | { status: "failed"; reason: string }
  /** The chain answered that the circuit is not there or not this one, or not with a judgment. */
  | { status: "refused"; problem: CircuitProblem; reason: string }
  | { status: "answered"; judgment: Judgment; block: bigint };

/**
 * The check for a pool, from the server's judgment, where the circuit is taped out, and the X Layer read. A read in
 * flight (the first one or a re-judge) is "checking", so a card holds its sign button off until the answer is in.
 */
export function checkFrom(server: ServerJudgment | null, deployment: CircuitDeployment, read: EvalState): CircuitCheck {
  if (!server) return { kind: "none" };
  switch (read.status) {
    case "asking":
      return { kind: "checking", server, deployment };
    case "failed":
      return { kind: "unreachable", server, deployment, reason: read.reason };
    case "refused":
      return { kind: "refused", server, deployment, problem: read.problem, reason: read.reason };
    case "answered":
      return sameJudgment(server.judgment, read.judgment)
        ? { kind: "same", server, deployment, circuit: read.judgment, block: read.block }
        : { kind: "differs", server, deployment, circuit: read.judgment, block: read.block };
  }
}

export function sameJudgment(a: Judgment, b: Judgment): boolean {
  return a.stage === b.stage && a.lane === b.lane;
}

export const MISMATCH_TITLE = "Judgment differs from the circuit";
export const REFUSED_TITLE: Record<CircuitProblem, string> = {
  "not-found": "Circuit not found on X Layer",
  "wrong-circuit": "The circuit on X Layer is not this netlist",
  "not-a-judgment": "The circuit's answer is not a judgment",
};
const REFUSED_STATUS: Record<CircuitProblem, string> = { "not-found": "not found", "wrong-circuit": "wrong circuit", "not-a-judgment": "not a judgment" };

export type QueryState = {
  rejudging: boolean;
  /** The last decisive answer from X Layer (a judgment, or "not this circuit"). */
  data: CircuitAnswer | undefined;
  dataUpdatedAt: number;
  /** The last transport failure, if any. */
  failure: string | null;
  failureUpdatedAt: number;
};

const fromAnswer = (a: CircuitAnswer): EvalState =>
  a.kind === "answered" ? { status: "answered", judgment: a.judgment, block: a.block } : { status: "refused", problem: a.problem, reason: a.reason };

/**
 * The check from the query that asks X Layer. The newest outcome counts, with one exception that only keeps the card
 * held: a re-judge that fails in transport after a decisive answer that held the card (differs, refused) keeps that
 * hold. After an answer that let the card through, the failure is shown as a failure, never as the old answer.
 * `rejudgeFailed` marks a failure that came after an earlier answer, for the screen.
 */
export function checkFromQuery(server: ServerJudgment | null, deployment: CircuitDeployment, q: QueryState): { check: CircuitCheck; rejudgeFailed: boolean } {
  if (q.rejudging || (!q.data && !q.failure)) return { check: checkFrom(server, deployment, { status: "asking" }), rejudgeFailed: false };
  const earlier = q.data ? checkFrom(server, deployment, fromAnswer(q.data)) : null;
  const failedLast = q.failure !== null && (!q.data || q.failureUpdatedAt >= q.dataUpdatedAt);
  if (!failedLast) return { check: earlier!, rejudgeFailed: false };
  if (earlier && circuitGate(earlier).state === "hold") return { check: earlier, rejudgeFailed: true };
  return { check: checkFrom(server, deployment, { status: "failed", reason: q.failure! }), rejudgeFailed: earlier !== null };
}

const show = (j: Judgment) => `${j.stage}, ${j.lane} lane`;

/** The card's gate for this check. Only a compared and equal judgment, or nothing to compare, leaves it open. */
export function circuitGate(check: CircuitCheck): ContestGate {
  switch (check.kind) {
    case "checking":
      return { state: "pending", label: "the pool judgment circuit" };
    case "differs":
      return { state: "hold", title: MISMATCH_TITLE, items: `· server: ${show(check.server.judgment)} · circuit: ${show(check.circuit)}` };
    case "refused":
      return { state: "hold", title: REFUSED_TITLE[check.problem], items: `· ${check.reason}` };
    case "none":
    case "same":
    case "unreachable":
      return { state: "ok" };
  }
}

export type CircuitLine = { circuit: string; status: string; tone: "ok" | "stop" | "plain" };

/** Where the compared server judgment comes from, said on the card itself so a cropped screenshot still shows it. */
export function serverMark(server: ServerJudgment): string | null {
  if (server.demo) return "server judgment altered (demo)";
  return server.source === "sample" ? "server: recorded sample" : null;
}

/** The one line the card's check box shows, or null for no line. */
export function circuitLine(check: CircuitCheck): CircuitLine | null {
  switch (check.kind) {
    case "none":
      return null;
    case "checking":
      return { circuit: `Pool judgment circuit #${check.deployment.circuitId}`, status: "checking", tone: "plain" };
    case "same":
      return { circuit: `Pool judgment circuit #${check.deployment.circuitId}`, status: "same judgment", tone: "ok" };
    case "differs":
      return { circuit: `Pool judgment circuit #${check.deployment.circuitId}`, status: "differs", tone: "stop" };
    case "unreachable":
      return { circuit: `Pool judgment circuit #${check.deployment.circuitId}`, status: "not reached", tone: "plain" };
    case "refused":
      return { circuit: `Pool judgment circuit #${check.deployment.circuitId}`, status: REFUSED_STATUS[check.problem], tone: "stop" };
  }
}
