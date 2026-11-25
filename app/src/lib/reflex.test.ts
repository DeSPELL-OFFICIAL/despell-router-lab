import { describe, expect, it } from "vitest";
import recorded from "@despell-lab/reactive/reflex-page.json";
import {
  journalNewestFirst,
  markedStatus,
  median,
  oneDecimal,
  parseReflexPage,
  rangeLine,
  readMarksNow,
  reflexPage,
  shortHex,
  summarize,
  utc,
} from "./reflex";

describe("the recorded measurement", () => {
  it("parses as despell-reflex-page/1", () => {
    expect(reflexPage.schema).toBe("despell-reflex-page/1");
    expect(reflexPage.watchedPools).toHaveLength(1);
  });

  it("gives the page the numbers the record holds", () => {
    const s = summarize(reflexPage);
    // The page computes from the runs; report.mjs computed the same from the same runs.
    expect(s.n).toBe(recorded.latency.n);
    expect(s.runs).toBe(recorded.latency.runs);
    expect(s.medianSeconds).toBe(recorded.latency.medianSeconds);
    expect(s.medianBlocks).toBe(recorded.latency.medianBlocks);
    expect(s.minSeconds).toBe(recorded.latency.minSeconds);
    expect(s.maxSeconds).toBe(recorded.latency.maxSeconds);
    expect(s.withinFiveBlocks / s.n).toBeCloseTo(recorded.latency.shares.withinFiveBlocks, 10);
  });

  it("measured 14 marks: median 1 s (6.5 blocks), 1–2 s and 4–10 blocks, 6 within 5 blocks", () => {
    const s = summarize(reflexPage);
    expect([s.n, s.medianSeconds, s.medianBlocks, s.withinFiveBlocks, s.withinTenBlocks]).toEqual([14, 1, 6.5, 6, 14]);
    expect(rangeLine(s)).toBe("1–2 s · 4–10 blocks");
  });

  it("measures the block time from the runs themselves: about 0.2 s", () => {
    const s = summarize(reflexPage);
    expect(s.blockSeconds).toBeGreaterThan(0.19);
    expect(s.blockSeconds).toBeLessThan(0.21);
    expect(oneDecimal(s.medianBlocks! * s.blockSeconds)).toBe("1.3");
  });

  it("marks every run with the reflex table's status for its change", () => {
    expect(reflexPage.journal.every((j) => markedStatus(j) === 2)).toBe(true);
  });

  it("links every marked run's three transactions", () => {
    for (const j of reflexPage.journal.filter((x) => x.result === "marked")) {
      expect(j.origin?.url).toMatch(/^https:\/\/sepolia\.basescan\.org\/tx\/0x[0-9a-f]{64}$/);
      expect(j.reactive?.url).toMatch(/^https:\/\/lasna\.reactscan\.net\/tx\/0x[0-9a-f]{64}$/);
      expect(j.mark?.url).toMatch(/^https:\/\/sepolia\.basescan\.org\/tx\/0x[0-9a-f]{64}$/);
    }
  });
});

describe("parseReflexPage", () => {
  const base = JSON.parse(JSON.stringify(recorded));

  it("rejects another schema", () => {
    expect(() => parseReflexPage({ ...base, schema: "something/2" })).toThrow(/schema/);
  });

  it("rejects a record with no runs", () => {
    expect(() => parseReflexPage({ ...base, journal: [] })).toThrow(/no runs/);
  });

  it("rejects a marked run without its mark", () => {
    const journal = [{ ...base.journal[0], mark: null }];
    expect(() => parseReflexPage({ ...base, journal })).toThrow(/lacks/);
  });

  it("rejects a record with no marked run", () => {
    const journal = [{ ...base.journal[0], result: "no mark within 180 s", mark: null, seconds: null, blocks: null }];
    expect(() => parseReflexPage({ ...base, journal })).toThrow(/no marked run/);
  });

  it("rejects more than one watched pool, since runs carry no pool id", () => {
    const watchedPools = [...base.watchedPools, { ...base.watchedPools[0], poolId: `0x${"1".repeat(64)}` }];
    expect(() => parseReflexPage({ ...base, watchedPools })).toThrow(/exactly one/);
  });

  it("rejects a change and a mark on different chains", () => {
    const chains = { ...base.chains, destination: { chainId: 1, name: "Ethereum" } };
    expect(() => parseReflexPage({ ...base, chains })).toThrow(/one chain/);
  });
});

describe("helpers", () => {
  it("median handles odd, even and empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it("reads a kept or missing run as no new mark", () => {
    const j = reflexPage.journal[0];
    expect(markedStatus({ ...j, result: "kept" })).toBeNull();
    expect(markedStatus({ ...j, result: "no mark within 180 s", mark: null })).toBeNull();
  });

  it("orders the journal newest first", () => {
    const runs = journalNewestFirst(reflexPage).map((j) => j.run);
    expect(runs[0]).toBe(14);
    expect(runs.at(-1)).toBe(1);
  });

  it("shortens hashes and formats UTC", () => {
    expect(shortHex(`0x${"ab".repeat(32)}`)).toBe("0xababab…abab");
    expect(utc("2026-11-25T18:46:11.285Z")).toBe("2026-11-25 18:46 UTC");
    expect(utc("2026-11-26T03:46:11+09:00")).toBe("2026-11-25 18:46 UTC");
    expect(utc(null)).toBe("—");
    expect(utc("not a date")).toBe("—");
  });
});

describe("readMarksNow", () => {
  const reply = (result: unknown) =>
    (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }))) as typeof fetch;
  const at = () => new Date("2026-11-26T00:00:00Z");

  it("reads PoolGuard.statusOf for each watched pool", async () => {
    const live = await readMarksNow(reflexPage, reply(`0x${"0".repeat(63)}2`), at);
    expect(live).toEqual({
      marks: [{ poolId: reflexPage.watchedPools[0].poolId, status: 2, label: "narrowed (0.1x)" }],
      readAt: "2026-11-26T00:00:00.000Z",
    });
  });

  it("sends statusOf(poolId) to PoolGuard", async () => {
    let sent: { to: string; data: string } | undefined;
    const spy = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)).params[0];
      return new Response(JSON.stringify({ result: `0x${"0".repeat(64)}` }));
    }) as unknown as typeof fetch;
    await readMarksNow(reflexPage, spy, at);
    expect(sent?.to).toBe(reflexPage.contracts.poolGuard.address);
    expect(sent?.data).toBe(`0xc7df14e2${reflexPage.watchedPools[0].poolId.slice(2)}`);
  });

  it("returns null when the RPC fails or answers without a value", async () => {
    const down = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    expect(await readMarksNow(reflexPage, down, at)).toBeNull();
    expect(await readMarksNow(reflexPage, reply("0x"), at)).toBeNull();
    expect(await readMarksNow(reflexPage, reply(undefined), at)).toBeNull();
  });
});
