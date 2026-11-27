"use client";

import { useEffect, useState } from "react";
import { markNow } from "@/lib/pool-marks";
import { useMarks } from "./use-marks";

type Props = {
  poolId: string;
  /** The server's read, for the first paint; null when it failed. */
  initial: number | null;
  /** PoolGuard status -> label ("open", "narrowed (0.1x)", ...). */
  labels: Record<string, string>;
  /** The badge's class, and one tone class per status; an unknown status takes the blocked tone. */
  badgeClass: string;
  tones: Record<number, string>;
};

/** "Mark now" in the page's marks table: the same 2-second PoolGuard read as the card above it. */
export function MarkNowCell({ poolId, initial, labels, badgeClass, tones }: Props) {
  const q = useMarks();
  // Keep aging the last read while polling is stalled, as the card does.
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  // Keep showing the failure until a read answers again. React Query clears the error when it retries without data.
  const failing = q.errorUpdatedAt > q.dataUpdatedAt;
  const error = failing ? (q.error ?? q.failureReason ?? "no answer yet, reading again") : null;
  const view = markNow(poolId, q.data ?? null, error, initial, now);
  if (view.kind === "none") {
    return (
      <span className="ds-dim" data-mark-now="none">
        —{view.reason ? ` · ${view.reason}` : null}
      </span>
    );
  }
  return (
    <span className={`${badgeClass} ${tones[view.status] ?? tones[3]}`} data-mark-now={view.status} data-mark-from={view.from}>
      {labels[String(view.status)] ?? "unknown"}
    </span>
  );
}
