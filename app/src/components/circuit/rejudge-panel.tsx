"use client";

import { useCircuitCheck } from "@/components/circuit/use-circuit-check";
import { X_LAYER } from "@/lib/circuit/circuit";
import { MISMATCH_TITLE, REFUSED_TITLE } from "@/lib/circuit/check";
import { encodeOutput } from "@despell-lab/xlayer/src/bits.ts";
import { outputRows } from "@/lib/circuit/pins";
import { PinTable } from "./pin-table";

/** The circuit's answer from X Layer for this pool, compared with the server's, and [Re-judge on X Layer]. */
export function RejudgePanel({ chainId, pool, demoMismatch }: { chainId: number; pool: string; demoMismatch: boolean }) {
  const { check, rejudge, asking, rejudgeFailed } = useCircuitCheck(chainId, pool, { demoMismatch });
  if (check.kind === "none") return null;
  const status =
    check.kind === "same"
      ? { text: "Same judgment", tone: "ok" }
      : check.kind === "differs"
        ? { text: MISMATCH_TITLE, tone: "stop" }
        : check.kind === "checking"
          ? { text: "Asking X Layer…", tone: "plain" }
          : check.kind === "unreachable"
            ? { text: `X Layer not reached (${check.reason})`, tone: "plain" }
            : check.kind === "refused"
              ? { text: `${REFUSED_TITLE[check.problem]}: ${check.reason}`, tone: "stop" }
            : { text: "Being prepared: the circuit is not taped out on X Layer yet", tone: "plain" };
  return (
    <section className="lab-panel" aria-labelledby="onchain-h" data-circuit={check.kind}>
      <div className="lab-panel-head">
        <h2 id="onchain-h" className="lab-h2">
          Circuit output on X Layer
        </h2>
        <button type="button" className="ds-btn is-primary" data-action="rejudge" onClick={rejudge} disabled={check.kind === "not-deployed" || asking}>
          {asking ? "Asking X Layer…" : "Re-judge on X Layer"}
        </button>
      </div>
      <p className={`lab-circuit-verdict is-${status.tone}`} role="status">
        {status.text}
      </p>
      {rejudgeFailed && (
        <p className="lab-note" data-rejudge="failed">
          The last re-judge failed in transport; {check.kind === "unreachable" ? "nothing is compared now." : "the earlier answer above still holds the card."}
        </p>
      )}
      {check.kind === "same" || check.kind === "differs" ? (
        <>
          <PinTable rows={outputRows(encodeOutput(check.circuit))} />
          <p className="lab-note">
            <code>eval({String(check.deployment.circuitId)}, inputs)</code> on processor{" "}
            <a href={`${X_LAYER.explorer}/address/${check.deployment.processor}`} target="_blank" rel="noreferrer" className="ds-mono">
              {check.deployment.processor}
            </a>{" "}
            read at X Layer block {String(check.block)}: {check.circuit.stage}, {check.circuit.lane} lane. The server judged {check.server.judgment.stage},{" "}
            {check.server.judgment.lane} lane.
          </p>
        </>
      ) : null}
    </section>
  );
}
