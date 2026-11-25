import { describe, expect, it } from "vitest";
import { COMPLETE_TTL_MS, createMeasureCache, INCOMPLETE_TTL_MS } from "./measure-cache";

type M = { complete: boolean; n: number };

function setup() {
  let t = 0;
  let n = 0;
  const cache = createMeasureCache<M>((m) => m.complete, () => t);
  const load = (complete = true) => async () => ({ complete, n: ++n });
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

  it("reuses an incomplete measurement for 1 minute only", async () => {
    const s = setup();
    await s.cache(s.load(false));
    s.advance(INCOMPLETE_TTL_MS - 1);
    expect((await s.cache(s.load())).n).toBe(1);
    s.advance(1);
    expect((await s.cache(s.load())).n).toBe(2);
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
});

describe("measure cache in flight", () => {
  it("stops sharing a measurement that has run past its deadline", async () => {
    let t = 0;
    const cache = createMeasureCache<{ n: number }>(() => true, () => t);
    const hung = cache(() => new Promise(() => {}));
    void hung;
    t += 59_999;
    let started = 0;
    const shared = cache(async () => ({ n: ++started }));
    void shared;
    expect(started).toBe(0); // still sharing the hung one
    t += 1;
    expect((await cache(async () => ({ n: ++started }))).n).toBe(1);
  });
});
