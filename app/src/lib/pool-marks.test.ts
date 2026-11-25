import type { Hex, PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import { agoText, leftOut, markGate, markNote, MARKS_MAX_AGE_MS, readMarks, type MarksRead } from "./pool-marks";
import { BASE_SEPOLIA } from "./swap/chains";

const [A, B] = BASE_SEPOLIA.pools;
const TX = `0x${"ab".repeat(32)}` as Hex;
const ZERO = `0x${"00".repeat(32)}` as Hex;
const NOW = 1_795_700_100_000; // client clock, ms

function readOf(statusA: number, statusB: number, timestamp = 1_795_700_100): MarksRead {
  return {
    block: 100n,
    timestamp,
    marks: [
      { pool: A, status: statusA, markedAt: statusA ? timestamp - 12 : 0, originTx: statusA ? TX : ZERO },
      { pool: B, status: statusB, markedAt: statusB ? timestamp - 300 : 0, originTx: statusB ? TX : ZERO },
    ],
    receivedAt: NOW,
  };
}

describe("readMarks", () => {
  it("reads every listed pool from PoolGuard in one call at the latest block", async () => {
    const calls: unknown[] = [];
    const client = {
      getBlock: async () => ({ number: 100n, timestamp: 1_795_700_100n }),
      multicall: async (args: unknown) => {
        calls.push(args);
        return [
          { status: 2, markedAt: 1_795_700_088n, originBlock: 99n, reason: ZERO, originTx: TX },
          { status: 0, markedAt: 0n, originBlock: 0n, reason: ZERO, originTx: ZERO },
        ];
      },
    } as unknown as PublicClient;
    const read = await readMarks(client, BASE_SEPOLIA, () => NOW);
    expect(read).toEqual({
      block: 100n,
      timestamp: 1_795_700_100,
      marks: [
        { pool: A, status: 2, markedAt: 1_795_700_088, originTx: TX },
        { pool: B, status: 0, markedAt: 0, originTx: ZERO },
      ],
      receivedAt: NOW,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      blockNumber: 100n,
      allowFailure: false,
      contracts: [
        { address: BASE_SEPOLIA.poolGuard, functionName: "markOf", args: [A.id] },
        { address: BASE_SEPOLIA.poolGuard, functionName: "markOf", args: [B.id] },
      ],
    });
  });
});

describe("leftOut", () => {
  it("leaves out narrowed and blocked pools, keeps open and small-cap ones", () => {
    expect(leftOut(readOf(0, 0))).toEqual([]);
    expect(leftOut(readOf(2, 0)).map((m) => m.pool.id)).toEqual([A.id]);
    expect(leftOut(readOf(1, 3)).map((m) => m.pool.id)).toEqual([B.id]);
    expect(leftOut(readOf(2, 2))).toHaveLength(2);
  });
});

describe("markGate", () => {
  it("waits for the first read, and holds if it fails", () => {
    expect(markGate(null, false, BASE_SEPOLIA, NOW)).toEqual({ state: "pending", label: "the on-chain marks" });
    expect(markGate(null, true, BASE_SEPOLIA, NOW)).toMatchObject({ state: "hold", title: "Could not read the on-chain marks" });
  });

  it("allows signing only on a fresh read that leaves a pool in the route", () => {
    expect(markGate(readOf(0, 0), false, BASE_SEPOLIA, NOW)).toEqual({ state: "ok" });
    expect(markGate(readOf(2, 0), false, BASE_SEPOLIA, NOW)).toEqual({ state: "ok" });
    expect(markGate(readOf(0, 0), true, BASE_SEPOLIA, NOW)).toEqual({ state: "pending", label: "a fresh read of the on-chain marks" });
  });

  // A read that stopped coming (a hung request is neither data nor an error) must not keep the button on.
  it("waits for a fresh read once the last answer is older than six seconds", () => {
    expect(markGate(readOf(0, 0), false, BASE_SEPOLIA, NOW + MARKS_MAX_AGE_MS)).toEqual({ state: "ok" });
    expect(markGate(readOf(0, 0), false, BASE_SEPOLIA, NOW + MARKS_MAX_AGE_MS + 1)).toEqual({ state: "pending", label: "a fresh read of the on-chain marks" });
    expect(MARKS_MAX_AGE_MS).toBe(6_000);
  });

  it("stops with no route when every pool is marked", () => {
    expect(markGate(readOf(2, 3), false, BASE_SEPOLIA, NOW)).toEqual({ state: "hold", title: "No route", items: "· every pool is marked on-chain" });
  });
});

describe("the left-out row", () => {
  it("says the pool is marked on-chain and how long ago, by block time", () => {
    const read = readOf(2, 3);
    expect(markNote(read.marks[0], read.timestamp)).toBe("marked on-chain · 12 s ago");
    expect(markNote(read.marks[1], read.timestamp)).toBe("blocked on-chain · 5 min ago");
  });

  it("rounds ages down and never goes below zero", () => {
    expect([agoText(-3), agoText(0), agoText(119.9), agoText(120), agoText(7199), agoText(7200), agoText(172_799), agoText(172_800)]).toEqual([
      "0 s ago",
      "0 s ago",
      "119 s ago",
      "2 min ago",
      "119 min ago",
      "2 h ago",
      "47 h ago",
      "2 d ago",
    ]);
  });
});
