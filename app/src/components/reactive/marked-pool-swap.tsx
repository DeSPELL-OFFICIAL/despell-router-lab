"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { SignCardRow } from "@/components/sign-card/sign-card";
import { DEMO_USDC } from "@/components/swap/swap-demo";
import { SwapCard } from "@/components/swap/swap-card";
import { leftOut, markGate, markNote, marksKey, readMarks } from "@/lib/pool-marks";
import { BASE_SEPOLIA } from "@/lib/swap/chains";
import { useMarks } from "./use-marks";

/*
  The Reactive Omni card: the shared Base Sepolia swap card, with PoolGuard
  read before the quote. A marked pool is left out of the route and gets one
  "Left out" row; with every pool marked, the card stops with no route. The
  marks are read every 2 seconds; a read more than 6 seconds old turns the
  sign button off; and signing reads them again right before each
  transaction, stopping if the pool the plan swaps through is marked. A mark
  that lands while the wallet's window is open is not seen until the next
  transaction; the plan's deadline bounds how long that window can be.
  The page's marks table reads the same query (useMarks), so the two agree.
*/

export function MarkedPoolSwap() {
  const queryClient = useQueryClient();
  const marksQ = useMarks();
  const client = marksQ.client;
  // The gate ages the last read by this clock, so a read that stopped coming closes it without a new render cause.
  // It starts at the real time: a read cached from an earlier visit must not look fresh on the first render.
  const [now, setNow] = useState(Date.now);
  // While the card signs, the read right before each transaction decides instead of the read's age (see markGate).
  const [signing, setSigning] = useState(false);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const timer = setInterval(tick, 1_000);
    return () => clearInterval(timer);
  }, []);
  const recheck = useCallback(async () => {
    if (!client) throw new Error("no Base Sepolia connection");
    const fresh = await readMarks(client, BASE_SEPOLIA);
    queryClient.setQueryData(marksKey(BASE_SEPOLIA.id), fresh);
    return leftOut(fresh).map((m) => m.pool.id);
  }, [client, queryClient]);

  const read = marksQ.data ?? null;
  const out = read ? leftOut(read) : [];
  const rows = read
    ? out.map((m) => <SignCardRow key={m.pool.id} k="Left out" value={`Uniswap v4 · ${m.pool.label}`} note={markNote(m, read.timestamp)} />)
    : null;
  return (
    <SwapCard
      chain={BASE_SEPOLIA}
      amountIn={DEMO_USDC}
      gate={markGate(read, marksQ.isError, BASE_SEPOLIA, now, signing)}
      leaveOut={read ? out.map((m) => m.pool.id) : null}
      recheckLeaveOut={recheck}
      extraRows={rows}
      onBusyChange={setSigning}
    />
  );
}
