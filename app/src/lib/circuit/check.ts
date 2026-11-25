import type { Judgment } from "@despell-lab/xlayer/src/rule.ts";
import type { ContestGate } from "@/lib/swap/view";
import type { CircuitDeployment } from "./circuit";
import type { ServerJudgment } from "./server-judgment";

/*
  The card's check against the pool judgment circuit: the server's judgment
  of the pool compared with the circuit's answer from X Layer for the same
  input bits. A difference holds the card. While the circuit is being asked
  the card is pending, so the button stays off.

  Defaults, to be confirmed (DES-704): with no circuit taped out yet, or when
  X Layer cannot be reached, nothing is compared and the card is not held.
  The server's judgment is the one that decides; the circuit is a second,
  public copy.
*/

export type CircuitCheck =
  /** The server has no judgment of this pool: no circuit line. */
  | { kind: "none" }
  | { kind: "not-deployed"; server: ServerJudgment }
  | { kind: "checking"; server: ServerJudgment; deployment: CircuitDeployment }
  | { kind: "same"; server: ServerJudgment; deployment: CircuitDeployment; circuit: Judgment; block: bigint }
  | { kind: "differs"; server: ServerJudgment; deployment: CircuitDeployment; circuit: Judgment; block: bigint }
  | { kind: "unreachable"; server: ServerJudgment; deployment: CircuitDeployment; reason: string }
  /** X Layer answered with something that is not a judgment: held, like a mismatch. */
  | { kind: "malformed"; server: ServerJudgment; deployment: CircuitDeployment; reason: string };

/** What the X Layer read looks like right now (from the query that asks it). */
export type EvalState =
  | { status: "asking" }
  /** The read failed in transport (RPC error, timeout): nothing was compared. */
  | { status: "failed"; reason: string }
  /** The chain answered, but not with a judgment. */
  | { status: "malformed"; reason: string }
  | { status: "answered"; judgment: Judgment; block: bigint };

/**
 * The check for a pool, from the server's judgment, where the circuit is taped out, and the X Layer read. A read in
 * flight (the first one or a re-judge) is "checking", so a card holds its sign button off until the answer is in.
 */
export function checkFrom(server: ServerJudgment | null, deployment: CircuitDeployment | null, read: EvalState): CircuitCheck {
  if (!server) return { kind: "none" };
  if (!deployment) return { kind: "not-deployed", server };
  switch (read.status) {
    case "asking":
      return { kind: "checking", server, deployment };
    case "failed":
      return { kind: "unreachable", server, deployment, reason: read.reason };
    case "malformed":
      return { kind: "malformed", server, deployment, reason: read.reason };
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
export const MALFORMED_TITLE = "The circuit's answer is not a judgment";

const show = (j: Judgment) => `${j.stage}, ${j.lane} lane`;

/** The card's gate for this check. Only a compared and equal judgment, or nothing to compare, leaves it open. */
export function circuitGate(check: CircuitCheck): ContestGate {
  switch (check.kind) {
    case "checking":
      return { state: "pending", label: "the pool judgment circuit" };
    case "differs":
      return { state: "hold", title: MISMATCH_TITLE, items: `· server: ${show(check.server.judgment)} · circuit: ${show(check.circuit)}` };
    case "malformed":
      return { state: "hold", title: MALFORMED_TITLE, items: `· ${check.reason}` };
    case "none":
    case "not-deployed":
    case "same":
    case "unreachable":
      return { state: "ok" };
  }
}

export type CircuitLine = { circuit: string; status: string; tone: "ok" | "stop" | "plain" };

/** The one line the card's check box shows, or null for no line. */
export function circuitLine(check: CircuitCheck): CircuitLine | null {
  switch (check.kind) {
    case "none":
      return null;
    case "not-deployed":
      return { circuit: "Pool judgment circuit", status: "being prepared", tone: "plain" };
    case "checking":
      return { circuit: `Pool judgment circuit #${check.deployment.circuitId}`, status: "checking", tone: "plain" };
    case "same":
      return { circuit: `Pool judgment circuit #${check.deployment.circuitId}`, status: "same judgment", tone: "ok" };
    case "differs":
      return { circuit: `Pool judgment circuit #${check.deployment.circuitId}`, status: "differs", tone: "stop" };
    case "unreachable":
      return { circuit: `Pool judgment circuit #${check.deployment.circuitId}`, status: "not reached", tone: "plain" };
    case "malformed":
      return { circuit: `Pool judgment circuit #${check.deployment.circuitId}`, status: "not a judgment", tone: "stop" };
  }
}
