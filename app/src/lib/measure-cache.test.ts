import { describe, expect, it } from "vitest";
import { COMPLETE_TTL_MS, createMeasureCache, RETRY_SOON_TTL_MS, ttlFor, type MeasureKind } from "./measure-cache";

type M = { kind: MeasureKind; n: number };

function setup() {
  let t = 0;
  let n = 0;
  const cache = createMeasureCache<M>((m) => m.kind, () => t);
  const load = (kind: MeasureKind = "complete") => async () => ({ kind, n: ++n });
  return { cache, load, advance: (ms: number) => (t += ms), loads: () => n };
}

describe("measure cache", () => {
  it("reuses a complete measurement for 5 minutes", async () => {
    const s = setup();
    expect((await s.cache(s.load())).n).toBe(1);
    s.advance(COMPLETE_TTL_MS - 1);
    expect((await s.cache(s.load())).n).toBe(1);
    s.advance(1);
    expect((await s.cache(s.load())).n).toBe(2);
  });

  it("retries a failed DeSpell check after 1 minute", async () => {
    const s = setup();
    await s.cache(s.load("retry_soon"));
    s.advance(RETRY_SOON_TTL_MS - 1);
    expect((await s.cache(s.load())).n).toBe(1);
    s.advance(1);
    expect((await s.cache(s.load())).n).toBe(2);
  });

  it("backs off longer after each rate-limited measurement in a row, and resets on success", async () => {
    expect([1, 2, 3, 4, 5].map((k) => ttlFor("back_off", k) / 60_000)).toEqual([5, 10, 20, 30, 30]);
    const s = setup();
    await s.cache(s.load("back_off")); // 5 min
    s.advance(5 * 60_000);
    await s.cache(s.load("back_off")); // 10 min
    s.advance(10 * 60_000 - 1);
    expect((await s.cache(s.load())).n).toBe(2);
    s.advance(1);
    expect((await s.cache(s.load("complete"))).n).toBe(3); // streak resets
    s.advance(COMPLETE_TTL_MS);
    await s.cache(s.load("back_off")); // back to 5 min
    s.advance(5 * 60_000);
    expect((await s.cache(s.load())).n).toBe(5);
  });

  it("shares one in-flight measurement between concurrent views", async () => {
    const s = setup();
    const [a, b] = await Promise.all([s.cache(s.load()), s.cache(s.load())]);
    expect(a.n).toBe(1);
    expect(b.n).toBe(1);
    expect(s.loads()).toBe(1);
  });

  it("does not keep errors", async () => {
    const s = setup();
    await expect(s.cache(async () => Promise.reject(new Error("down")))).rejects.toThrow("down");
    expect((await s.cache(s.load())).n).toBe(1);
  });

  it("stops sharing a measurement that has run past its deadline", async () => {
    let t = 0;
    const cache = createMeasureCache<{ n: number }>(() => "complete", () => t);
    void cache(() => new Promise(() => {}));
    t += 59_999;
    let started = 0;
    void cache(async () => ({ n: ++started }));
    expect(started).toBe(0); // still sharing the hung one
    t += 1;
    expect((await cache(async () => ({ n: ++started }))).n).toBe(1);
  });
});
