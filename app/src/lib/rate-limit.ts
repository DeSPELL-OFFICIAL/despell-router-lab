/*
  A fixed-window counter for this server process: at most `limit` calls per
  `windowMs`. It caps how many DeSpell links the public Buy action asks for,
  so a script hitting it cannot spend the server's share of DeSpell's
  connector limit. Per process only; on serverless each instance has its own.
*/

export function createRateLimit(limit: number, windowMs: number, now: () => number = Date.now) {
  let windowStart = now();
  let count = 0;
  return function take(): boolean {
    const t = now();
    if (t - windowStart >= windowMs) {
      windowStart = t;
      count = 0;
    }
    if (count >= limit) return false;
    count += 1;
    return true;
  };
}
