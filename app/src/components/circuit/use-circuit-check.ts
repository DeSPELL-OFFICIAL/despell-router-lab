"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { DEPLOYMENT } from "@/lib/circuit/circuit";
import { checkFromQuery, type CircuitCheck } from "@/lib/circuit/check";
import { serverJudgmentFor } from "@/lib/circuit/server-judgment";
import { readCircuit, xLayerClient } from "@/lib/circuit/xlayer-eval";

const firstLine = (e: unknown) => (e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e)).split("\n")[0];

/**
 * The circuit check for one pool: the server's judgment, compared with the circuit's answer from X Layer. Asked once
 * per pool and again only on [Re-judge]; "checking" until X Layer answers, which keeps a card's sign button off. No
 * background refetch (reconnect, focus, remount) turns an answered check back to checking: a pending gate between two
 * transactions would stop a swap halfway.
 */
export function useCircuitCheck(
  chainId: number,
  pool: string,
  opts: { demoMismatch?: boolean } = {},
): { check: CircuitCheck; rejudge: () => void; asking: boolean; rejudgeFailed: boolean } {
  const server = serverJudgmentFor(chainId, pool, opts);
  const deployment = DEPLOYMENT;
  const q = useQuery({
    queryKey: ["circuit-eval", deployment?.processor, deployment?.circuitId.toString(), chainId, pool.toLowerCase()],
    // A refusal comes back as data, so only transport failures are errors (and retried).
    queryFn: () => readCircuit(xLayerClient(), deployment!, server!.input),
    enabled: Boolean(server && deployment),
    retry: 2,
    staleTime: Infinity,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });
  const [rejudging, setRejudging] = useState(false);
  const rejudge = () => {
    setRejudging(true);
    void q.refetch().finally(() => setRejudging(false));
  };
  const { check, rejudgeFailed } = checkFromQuery(server, deployment, {
    rejudging,
    data: q.data,
    dataUpdatedAt: q.dataUpdatedAt,
    failure: q.error ? firstLine(q.error) : null,
    failureUpdatedAt: q.errorUpdatedAt,
  });
  return { check, rejudge, asking: check.kind === "checking", rejudgeFailed };
}
