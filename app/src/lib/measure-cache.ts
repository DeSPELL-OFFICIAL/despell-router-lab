/*
  Reuse one measurement across page views for a while.

  Each /cmc view costs about 13 LI.FI quotes, 2 CoinMarketCap credits and a
  dozen DeSpell connector calls, and LI.FI's keyless limit is tens of quotes
  an hour. So a complete result is kept for 5 minutes and an incomplete one
  (some quotes failed) for 1 minute, so a failure is retried sooner but not
  on every view. Concurrent views share one in-flight measurement. Errors
  are not kept.

  The cache lives in the server process; on serverless each instance keeps
  its own, which is fine for this demo's traffic.
*/

export const COMPLETE_TTL_MS = 5 * 60_000;
export const INCOMPLETE_TTL_MS = 60_000;

type Entry<T> = { promise: Promise<T>; expiresAt: number };

export function createMeasureCache<T>(isComplete: (value: T) => boolean, now: () => number = Date.now) {
  let entry: Entry<T> | null = null;

  return async function get(load: () => Promise<T>): Promise<T> {
    const t = now();
    if (entry && t < entry.expiresAt) return entry.promise;

    const promise = load();
    // While loading, every caller shares this promise.
    const current: Entry<T> = { promise, expiresAt: Number.POSITIVE_INFINITY };
    entry = current;
    try {
      const value = await promise;
      if (entry === current) current.expiresAt = now() + (isComplete(value) ? COMPLETE_TTL_MS : INCOMPLETE_TTL_MS);
      return value;
    } catch (err) {
      if (entry === current) entry = null;
      throw err;
    }
  };
}
