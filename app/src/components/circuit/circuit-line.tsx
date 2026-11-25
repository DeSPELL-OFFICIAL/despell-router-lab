import type { Route } from "next";
import Link from "next/link";
import { circuitLine, type CircuitCheck } from "@/lib/circuit/check";

/**
 * "Pool judgment circuit #7 · same judgment · View circuit": the one line a card's check box shows for the circuit.
 * The link is not called "Details": the check box's own toggle already is.
 */
export function CircuitLine({ check, href }: { check: CircuitCheck; href: Route }) {
  const line = circuitLine(check);
  if (!line) return null;
  return (
    <>
      <span>{line.circuit}</span>
      <span aria-hidden="true">·</span>
      <span className={`lab-circuit-status is-${line.tone}`} data-circuit={check.kind}>
        {line.status}
      </span>
      <span aria-hidden="true">·</span>
      <Link href={href}>View circuit</Link>
    </>
  );
}
