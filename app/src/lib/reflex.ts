/*
  The on-chain reflex page's data: the measurement written by reactive/reflex/scripts/report.mjs
  (deployments/reflex-page.json, schema despell-reflex-page/1) plus a live read of PoolGuard.

  Every number on the page comes from here and is computed from the recorded runs, never typed in.
  Time to mark is the gap between two Base Sepolia blocks (the fee change and the mark). Lasna times
  are shown for reference only: the two chains' clocks are not the same clock.
*/
import recorded from "@despell-lab/reactive/reflex-page.json";

export const SCHEMA = "despell-reflex-page/1";

export type TxRef = { tx: string; block: number; at: string | null; url: string };

export type JournalEntry = {
  run: number;
  at: string | null;
  result: string;
  change: { kind: string; oldFee: number; newFee: number; label: string } | null;
  origin: (TxRef & { reactscan: string }) | null;
  reactive: TxRef | null;
  mark: TxRef | null;
  seconds: number | null;
  blocks: number | null;
  reopen: { tx: string; url: string } | null;
};

export type ReflexPage = {
  schema: typeof SCHEMA;
  measuredAt: string;
  chains: Record<"origin" | "reactive" | "destination", { chainId: number; name: string }>;
  contracts: Record<"hook" | "poolReflex" | "poolGuard", { address: string; url: string }>;
  statusLabels: Record<string, string>;
  watchedPools: { poolId: string; hook: string; label: string }[];
  journal: JournalEntry[];
};

/** Checks the fields the page relies on, so a changed or broken record fails the build instead of the page. */
export function parseReflexPage(raw: unknown): ReflexPage {
  const p = raw as Partial<ReflexPage> | null;
  if (!p || p.schema !== SCHEMA) throw new Error(`reflex page: expected schema ${SCHEMA}`);
  if (!p.measuredAt || !p.chains || !p.contracts || !p.statusLabels) throw new Error("reflex page: missing header fields");
  if (!Array.isArray(p.watchedPools) || p.watchedPools.length === 0) throw new Error("reflex page: no watched pools");
  if (!Array.isArray(p.journal) || p.journal.length === 0) throw new Error("reflex page: no runs");
  for (const j of p.journal) {
    if (j.result === "marked" && (!j.origin || !j.mark || j.seconds == null || j.blocks == null)) {
      throw new Error(`reflex page: run ${j.run} is marked but lacks its transactions or timing`);
    }
  }
  return p as ReflexPage;
}

export const reflexPage: ReflexPage = parseReflexPage(recorded);

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export type Summary = {
  runs: number;
  /** Runs where PoolGuard marked the pool: the latency sample. */
  n: number;
  medianSeconds: number | null;
  medianBlocks: number | null;
  minSeconds: number | null;
  maxSeconds: number | null;
  minBlocks: number | null;
  maxBlocks: number | null;
  withinOneSecond: number;
  withinTwoSeconds: number;
};

/** The headline numbers, from the runs themselves. */
export function summarize(page: ReflexPage): Summary {
  const marked = page.journal.filter((j) => j.result === "marked");
  const secs = marked.map((j) => j.seconds as number);
  const blocks = marked.map((j) => j.blocks as number);
  return {
    runs: page.journal.length,
    n: marked.length,
    medianSeconds: median(secs),
    medianBlocks: median(blocks),
    minSeconds: secs.length ? Math.min(...secs) : null,
    maxSeconds: secs.length ? Math.max(...secs) : null,
    minBlocks: blocks.length ? Math.min(...blocks) : null,
    maxBlocks: blocks.length ? Math.max(...blocks) : null,
    withinOneSecond: secs.filter((s) => s <= 1).length,
    withinTwoSeconds: secs.filter((s) => s <= 2).length,
  };
}

/** "1–2 s · 4–10 blocks", or one value when the range is a single number. */
export function rangeLine(s: Summary): string {
  const span = (a: number | null, b: number | null) => (a === b ? `${a}` : `${a}–${b}`);
  return `${span(s.minSeconds, s.maxSeconds)} s · ${span(s.minBlocks, s.maxBlocks)} blocks`;
}

export function shortHex(h: string): string {
  return h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-4)}` : h;
}

/** "2026-11-25 18:46 UTC" */
export function utc(iso: string | null): string {
  if (!iso) return "—";
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export function statusLabel(page: ReflexPage, status: number): string {
  return page.statusLabels[String(status)] ?? "unknown";
}

/** The newest run first, as a journal reads. */
export function journalNewestFirst(page: ReflexPage): JournalEntry[] {
  return [...page.journal].sort((a, b) => b.run - a.run);
}

const BASE_SEPOLIA_RPC = "https://sepolia.base.org";
const STATUS_OF = "0xc7df14e2"; // statusOf(bytes32)

export type LiveMark = { poolId: string; status: number; label: string };
export type LiveRead = { marks: LiveMark[]; readAt: string } | null;

/**
 * Reads statusOf(poolId) from PoolGuard for every watched pool. Returns null when the RPC cannot be reached,
 * so the page shows that the live read is missing instead of a number it did not read.
 */
export async function readMarksNow(
  page: ReflexPage,
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): Promise<LiveRead> {
  try {
    const marks: LiveMark[] = [];
    for (const pool of page.watchedPools) {
      const res = await fetchImpl(BASE_SEPOLIA_RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [{ to: page.contracts.poolGuard.address, data: STATUS_OF + pool.poolId.slice(2) }, "latest"],
        }),
        signal: AbortSignal.timeout(5_000),
      });
      const body = (await res.json()) as { result?: string; error?: unknown };
      if (typeof body.result !== "string" || !/^0x[0-9a-fA-F]+$/.test(body.result)) return null;
      const status = Number(BigInt(body.result));
      marks.push({ poolId: pool.poolId, status, label: statusLabel(page, status) });
    }
    return { marks, readAt: now().toISOString() };
  } catch {
    return null;
  }
}
