import { describe, expect, it } from "vitest";
import { createRateLimit } from "./rate-limit";

describe("rate limit", () => {
  it("allows `limit` calls per window and opens again in the next window", () => {
    let t = 0;
    const take = createRateLimit(3, 60_000, () => t);
    expect([take(), take(), take(), take()]).toEqual([true, true, true, false]);
    t += 59_999;
    expect(take()).toBe(false);
    t += 1;
    expect(take()).toBe(true);
  });
});
