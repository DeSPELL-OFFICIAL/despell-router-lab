"use client";

import { useQuery } from "@tanstack/react-query";
import type { PublicClient } from "viem";
import { usePublicClient } from "wagmi";
import { marksKey, MARKS_POLL_MS, readMarks } from "@/lib/pool-marks";
import { BASE_SEPOLIA } from "@/lib/swap/chains";

/**
 * PoolGuard's marks on Base Sepolia. The card and the marks table share the same 2-second read through one query key.
 */
export function useMarks() {
  const client = usePublicClient({ chainId: BASE_SEPOLIA.id }) as unknown as PublicClient | undefined;
  const query = useQuery({
    queryKey: marksKey(BASE_SEPOLIA.id),
    queryFn: () => readMarks(client!, BASE_SEPOLIA),
    enabled: Boolean(client),
    refetchInterval: MARKS_POLL_MS,
    retry: 1,
  });
  return { ...query, client };
}
