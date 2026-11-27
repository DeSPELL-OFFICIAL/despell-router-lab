import type { Hex, PublicClient } from "viem";
import type { BaseSepoliaSwap, V4Pool } from "./swap/chains";
import { short } from "./swap/format";
import type { ContestGate } from "./swap/view";

/*
  The on-chain marks the Reactive Omni card reads before it quotes: PoolGuard
  markOf for every listed Base Sepolia pool, in one call at one block, with
  that block's timestamp. A pool marked narrowed (2) or blocked (3) is left
  out of the route. Small cap (1) stays in: it limits a trade's size, and this
  card's trade is 10 USDC (PoolReflex never writes 1).

  Fail-closed: until the first read answers, nothing is quoted; while reads
  fail, or the last answer is older than MARKS_MAX_AGE_MS, the sign button
  stays off. Signing reads the marks again right before every transaction.
*/

export const OPEN = 0;
export const NARROWED = 2;
export const BLOCKED = 3;

/** How often the card reads the marks. A mark lands about a second after a pool change (reactive/deployments). */
export const MARKS_POLL_MS = 2_000;
/** A read older than this no longer opens the gate: three polls missed. */
export const MARKS_MAX_AGE_MS = 6_000;

export const poolGuardAbi = [
  {
    type: "function",
    name: "markOf",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "status", type: "uint8" },
          { name: "markedAt", type: "uint64" },
          { name: "originBlock", type: "uint64" },
          { name: "reason", type: "bytes32" },
          { name: "originTx", type: "bytes32" },
        ],
      },
    ],
  },
] as const;

export type PoolMark = {
  pool: V4Pool;
  status: number;
  /** Unix seconds of the mark's block; 0 when the pool is open. */
  markedAt: number;
  /** The pool change behind the mark. */
  originTx: Hex;
};

export type MarksRead = {
  block: bigint;
  timestamp: number;
  marks: PoolMark[];
  /** Client clock (ms) when the answer arrived: how old the read is, whatever the chain's clock says. */
  receivedAt: number;
};

/** Reads every listed pool's mark at the latest block. */
export async function readMarks(client: PublicClient, chain: BaseSepoliaSwap, nowMs: () => number = Date.now): Promise<MarksRead> {
  const head = await client.getBlock({ blockTag: "latest" });
  const results = await client.multicall({
    contracts: chain.pools.map((pool) => ({ address: chain.poolGuard, abi: poolGuardAbi, functionName: "markOf", args: [pool.id] }) as const),
    blockNumber: head.number,
    allowFailure: false,
  });
  return {
    block: head.number,
    timestamp: Number(head.timestamp),
    marks: chain.pools.map((pool, i) => ({ pool, status: results[i].status, markedAt: Number(results[i].markedAt), originTx: results[i].originTx })),
    receivedAt: nowMs(),
  };
}

/** Narrowed and blocked pools leave the route; any value above blocked counts as blocked, as PoolGuard reads it. */
export const leavesRoute = (status: number) => status >= NARROWED;

export function leftOut(read: MarksRead): PoolMark[] {
  return read.marks.filter((m) => leavesRoute(m.status));
}

/**
 * The card's gate from the latest read. `failing`: the latest read failed (an earlier one may still be on screen).
 * Only a fresh read (no failure, at most MARKS_MAX_AGE_MS old at `nowMs`) with at least one pool still in the route
 * lets the sign button turn on.
 *
 * `signing`: the card is between a plan's transactions. The age rule is off then, because the signing loop reads the
 * marks again right before each transaction and that read decides; a gap in the polling (a hidden tab, say) would
 * otherwise stop a swap after its approval for a read that is about to be replaced anyway.
 */
export function markGate(read: MarksRead | null, failing: boolean, chain: BaseSepoliaSwap, nowMs: number, signing = false): ContestGate {
  if (!read) {
    return failing
      ? { state: "hold", title: "Could not read the on-chain marks", items: `· PoolGuard ${short(chain.poolGuard)} · nothing is quoted until it answers` }
      : { state: "pending", label: "the on-chain marks" };
  }
  const stale = !signing && nowMs - read.receivedAt > MARKS_MAX_AGE_MS;
  if (failing || stale) return { state: "pending", label: "a fresh read of the on-chain marks" };
  if (leftOut(read).length === read.marks.length) return { state: "hold", title: "No route", items: "· every pool is marked on-chain" };
  return { state: "ok" };
}

/** "12 s ago", "3 min ago", "5 h ago", "2 d ago". */
export function agoText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 120) return `${s} s ago`;
  if (s < 2 * 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 2 * 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}

/** The left-out row's note: what the mark says and how old it was at the block it was read at. */
export function markNote(mark: PoolMark, readAt: number): string {
  const what = mark.status >= BLOCKED ? "blocked on-chain" : "marked on-chain";
  return `${what} · ${agoText(readAt - mark.markedAt)}`;
}

/** The react-query key the card and the page's marks table share, so one 2-second read feeds both. */
export const marksKey = (chainId: number) => ["pool-marks", chainId] as const;

export type MarkNow = { kind: "status"; status: number; from: "server" | "chain" } | { kind: "none"; reason: string | null };

/**
 * The marks table's "Mark now" cell for one pool. The latest 2-second read decides; before the first one answers, the
 * server's read gives the first paint. When the latest read failed, the cell shows no status and says why, rather than
 * keep an earlier answer on screen as if it were current.
 */
export function markNow(poolId: string, read: MarksRead | null, error: unknown, initial: number | null): MarkNow {
  if (error) {
    const text = (error instanceof Error ? ((error as { shortMessage?: string }).shortMessage ?? error.message) : String(error)).split("\n")[0];
    return { kind: "none", reason: `read failed: ${text.length > 80 ? `${text.slice(0, 79)}…` : text}` };
  }
  if (read) {
    const mark = read.marks.find((m) => m.pool.id.toLowerCase() === poolId.toLowerCase());
    return mark ? { kind: "status", status: mark.status, from: "chain" } : { kind: "none", reason: "not one of the card's pools" };
  }
  return initial === null ? { kind: "none", reason: null } : { kind: "status", status: initial, from: "server" };
}
