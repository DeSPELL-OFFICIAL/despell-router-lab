"use client";

import { useQuery } from "@tanstack/react-query";
import type { PublicClient } from "viem";
import { usePublicClient } from "wagmi";
import { SignCardRow } from "@/components/sign-card/sign-card";
import { DEMO_USDC } from "@/components/swap/swap-demo";
import { SwapCard } from "@/components/swap/swap-card";
import { leftOut, markGate, markNote, MARKS_POLL_MS, readMarks } from "@/lib/pool-marks";
import { BASE_SEPOLIA } from "@/lib/swap/chains";

/*
  The Reactive Omni card: the shared Base Sepolia swap card, with PoolGuard
  read before the quote. A marked pool is left out of the route and gets one
  "Left out" row; with every pool marked, the card stops with no route. The
  marks are read every 2 seconds, and signing stops before the next
  transaction if the pool the plan swaps through is marked meanwhile.
*/

export function MarkedPoolSwap() {
  const client = usePublicClient({ chainId: BASE_SEPOLIA.id }) as unknown as PublicClient | undefined;
  const marksQ = useQuery({
    queryKey: ["pool-marks", BASE_SEPOLIA.id],
    queryFn: () => readMarks(client!, BASE_SEPOLIA),
    enabled: Boolean(client),
    refetchInterval: MARKS_POLL_MS,
    retry: 1,
  });
  const read = marksQ.data ?? null;
  const out = read ? leftOut(read) : [];
  const rows = read
    ? out.map((m) => <SignCardRow key={m.pool.id} k="Left out" value={`Uniswap v4 · ${m.pool.label}`} note={markNote(m, read.timestamp)} />)
    : null;
  return (
    <SwapCard
      chain={BASE_SEPOLIA}
      amountIn={DEMO_USDC}
      gate={markGate(read, marksQ.isError, BASE_SEPOLIA)}
      leaveOut={read ? out.map((m) => m.pool.id) : null}
      extraRows={rows}
    />
  );
}
