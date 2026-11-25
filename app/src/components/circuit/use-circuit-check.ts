"use client";

import { useQuery } from "@tanstack/react-query";
import { DEPLOYMENT } from "@/lib/circuit/circuit";
import { checkFrom, type CircuitCheck, type EvalState } from "@/lib/circuit/check";
import { serverJudgmentFor } from "@/lib/circuit/server-judgment";
import { judgeOnXLayer, xLayerClient } from "@/lib/circuit/xlayer-eval";

const firstLine = (e: unknown) => (e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e)).split("\n")[0];

/**
 * The circuit check for one pool: the server's judgment, compared with the circuit's answer from X Layer. Asked once
 * per pool (and again on [Re-judge]); "checking" until X Layer answers, which keeps a card's sign button off.
 */
export function useCircuitCheck(chainId: number, pool: string, opts: { demoMismatch?: boolean } = {}): { check: CircuitCheck; rejudge: () => void; asking: boolean } {
  const server = serverJudgmentFor(chainId, pool, opts);
  const deployment = DEPLOYMENT;
  const q = useQuery({
    queryKey: ["circuit-eval", deployment?.processor, deployment?.circuitId.toString(), chainId, pool.toLowerCase()],
    queryFn: () => judgeOnXLayer(xLayerClient(), deployment!, server!.input),
    enabled: Boolean(server && deployment),
    retry: 2,
    staleTime: 60_000,
  });
  const rejudge = () => void q.refetch();
  // A refetch counts as asking again: the card holds its button off until the new answer is in.
  const read: EvalState =
    q.isFetching || (!q.data && !q.error)
      ? { status: "asking" }
      : q.data
        ? { status: "answered", judgment: q.data.judgment, block: q.data.block }
        : { status: "failed", reason: firstLine(q.error) };
  const check = checkFrom(server, deployment, read);
  return { check, rejudge, asking: check.kind === "checking" };
}
