/*
  The on-chain reflex page's data: the measurement written by reactive/reflex/scripts/report.mjs
  (deployments/reflex-page.json, schema despell-reflex-page/1) plus a live read of PoolGuard.

  Every number on the page comes from here and is computed from the recorded runs, never typed in.
  Time to mark is the gap between two Base Sepolia blocks (the fee change and the mark). Lasna times
  are shown for reference only: the two chains' clocks are not the same clock.
*/
import recorded from "@despell-lab/reactive/reflex-page.json";
import { BASE_SEPOLIA } from "./swap/chains";

export const SCHEMA = "despell-reflex-page/1";

export type TxRef = { tx: string; block: number; at: string | null; url: string };

export type JournalEntry = {
  run: number;
  at: string | null;
  result: string;
  change: { kind: string; oldFee: number; newFee: number; label: string } | null;
  origin: (TxRef & { reactscan: string }) | null;
  reactive: TxRef | null;
  /** `newStatus`: the status PoolGuard's Marked event set, recorded by measurements from DES-700 on. */
  mark: (TxRef & { newStatus?: number }) | null;
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
  // Journal entries carry no pool id, so the page can only tell runs apart while one pool is watched.
  if (!Array.isArray(p.watchedPools) || p.watchedPools.length !== 1) throw new Error("reflex page: expects exactly one watched pool");
  // Time to mark compares two block timestamps, which only means something on one chain.
  if (p.chains.origin.chainId !== p.chains.destination.chainId) throw new Error("reflex page: origin and mark must be on one chain");
  if (!Array.isArray(p.journal) || p.journal.length === 0) throw new Error("reflex page: no runs");
  if (!p.journal.some((j) => j.result === "marked")) throw new Error("reflex page: no marked run");
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
  /** Seconds per block over the measured runs (first change to last mark), finer than whole-second timestamps. */
  blockSeconds: number;
  withinFiveBlocks: number;
  withinTenBlocks: number;
};

/** The headline numbers, from the runs themselves. */
export function summarize(page: ReflexPage): Summary {
  const marked = page.journal.filter((j) => j.result === "marked");
  const secs = marked.map((j) => j.seconds as number);
  const blocks = marked.map((j) => j.blocks as number);
  const byRun = [...marked].sort((a, b) => a.run - b.run);
  const first = byRun[0];
  const lastRun = byRun[byRun.length - 1];
  const spanBlocks = (lastRun.mark?.block ?? 0) - (first.origin?.block ?? 0);
  const spanSeconds = (Date.parse(lastRun.mark?.at ?? "") - Date.parse(first.origin?.at ?? "")) / 1000;
  return {
    runs: page.journal.length,
    n: marked.length,
    medianSeconds: median(secs),
    medianBlocks: median(blocks),
    minSeconds: secs.length ? Math.min(...secs) : null,
    maxSeconds: secs.length ? Math.max(...secs) : null,
    minBlocks: blocks.length ? Math.min(...blocks) : null,
    maxBlocks: blocks.length ? Math.max(...blocks) : null,
    blockSeconds: spanBlocks > 0 && spanSeconds > 0 ? spanSeconds / spanBlocks : NaN,
    withinFiveBlocks: blocks.filter((b) => b <= 5).length,
    withinTenBlocks: blocks.filter((b) => b <= 10).length,
  };
}

/** "1–2 s · 4–10 blocks", or one value when the range is a single number. */
/** A range as "4–10", or "4" when both ends agree; "—" for a missing end. */
export function span(a: number | null, b: number | null): string {
  return a === b ? `${a ?? "—"}` : `${a ?? "—"}–${b ?? "—"}`;
}

export function shortHex(h: string): string {
  return h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-4)}` : h;
}

/** "2026-11-25 18:46 UTC", whatever offset the input carries. */
export function utc(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const z = new Date(t).toISOString();
  return `${z.slice(0, 10)} ${z.slice(11, 16)} UTC`;
}

/** "1.3", one decimal: block counts turned into seconds. */
export function oneDecimal(x: number): string {
  return Number.isFinite(x) ? x.toFixed(1) : "—";
}

/** The router's reflex table, as PoolReflex.reflexFor has it: the status a change kind is marked with. */
export const REFLEX_STATUS: Readonly<Record<string, number>> = {
  code_changed: 3,
  token_code_changed: 3,
  implementation_changed: 3,
  sell_reverted: 3,
  owner_changed: 2,
  fee_changed: 2,
  reserve_below_band: 2,
  round_trip_loss_up: 2,
};

/** The status a marked run set: the reflex table's entry for its change kind. */
/** The status a marked run set: the one its Marked event recorded, else the reflex table's for its change kind. */
export function markedStatus(j: JournalEntry): number | null {
  if (j.result !== "marked" || !j.change) return null;
  if (Number.isInteger(j.mark?.newStatus)) return j.mark!.newStatus!;
  return REFLEX_STATUS[j.change.kind] ?? null;
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

export type HookPool = { poolId: string; label: string; measured: boolean };

/**
 * Every lab pool on the watched hook. PoolReflex reacts to FeeUpdated from the hook for any pool, so all of them are
 * watched; `measured` marks the one the timed runs used.
 */
export function hookPools(page: ReflexPage): HookPool[] {
  const hook = page.contracts.hook.address.toLowerCase();
  const measured = new Set(page.watchedPools.map((w) => w.poolId.toLowerCase()));
  const pools = BASE_SEPOLIA.pools
    .filter((p) => p.key.hooks.toLowerCase() === hook)
    .map((p) => ({ poolId: p.id, label: `Uniswap v4 ETH/USDC · ${p.label}`, measured: measured.has(p.id.toLowerCase()) }));
  if (!pools.some((p) => p.measured)) throw new Error("reflex page: the measured pool is not among the app's pools");
  return pools;
}

export type LiveMark = { poolId: string; status: number; label: string };
export type LiveRead = { marks: LiveMark[]; readAt: string } | null;

/**
 * Reads statusOf(poolId) from PoolGuard for every given pool. Returns null when the RPC cannot be reached,
 * so the page shows that the live read is missing instead of a number it did not read.
 */
export async function readMarksNow(
  page: ReflexPage,
  pools: readonly { poolId: string }[] = hookPools(page),
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): Promise<LiveRead> {
  try {
    // One overall deadline for every pool, read side by side.
    const signal = AbortSignal.timeout(5_000);
    const read = async (pool: { poolId: string }): Promise<LiveMark | null> => {
      const res = await fetchImpl(BASE_SEPOLIA_RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [{ to: page.contracts.poolGuard.address, data: STATUS_OF + pool.poolId.slice(2) }, "latest"],
        }),
        signal,
      });
      const body = (await res.json()) as { result?: string; error?: unknown };
      if (typeof body.result !== "string" || !/^0x[0-9a-fA-F]+$/.test(body.result)) return null;
      const status = Number(BigInt(body.result));
      return { poolId: pool.poolId, status, label: statusLabel(page, status) };
    };
    const marks = await Promise.all(pools.map(read));
    if (marks.some((m) => m === null)) return null;
    return { marks: marks as LiveMark[], readAt: now().toISOString() };
  } catch {
    return null;
  }
}
