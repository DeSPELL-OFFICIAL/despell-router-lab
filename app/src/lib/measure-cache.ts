/*
  Reuse one measurement across page views for a while.

  Each /cmc view costs about 13 LI.FI quotes, 2 CoinMarketCap credits and a
  dozen DeSpell connector calls, and LI.FI's keyless limit is tens of quotes
  an hour. So each measurement is kept according to what it is:

    complete    5 minutes.
    retry_soon  1 minute: only a DeSpell check failed, which is cheap to redo.
    back_off    5 minutes, doubling for each such result in a row up to 30:
                quotes failed (usually LI.FI's rate limit), and asking again
                soon would only keep the limit hit.
    error       1 minute: the measurement threw (CoinMarketCap down, say).
                Kept too, so a burst of views does not retry it every time.

  Concurrent views share one in-flight measurement, for at most a minute.
  The cache lives in the server process; on serverless each instance keeps
  its own, which is fine for this demo's traffic.
*/

export type MeasureKind = "complete" | "retry_soon" | "back_off";

export const COMPLETE_TTL_MS = 5 * 60_000;
export const RETRY_SOON_TTL_MS = 60_000;
export const ERROR_TTL_MS = 60_000;
export const BACK_OFF_FIRST_MS = 5 * 60_000;
export const BACK_OFF_MAX_MS = 30 * 60_000;
/** A measurement still running after this is no longer shared; the next view starts its own. */
export const IN_FLIGHT_TTL_MS = 60_000;

type Entry<T> = { promise: Promise<T>; expiresAt: number };

export type Measured<T> = {
  value: T;
  kind: MeasureKind;
  /** When the next view will measure again instead of reusing this one. */
  nextMeasureAt: number;
};

export function ttlFor(kind: MeasureKind, backOffStreak: number): number {
  if (kind === "complete") return COMPLETE_TTL_MS;
  if (kind === "retry_soon") return RETRY_SOON_TTL_MS;
  return Math.min(BACK_OFF_FIRST_MS * 2 ** Math.max(0, backOffStreak - 1), BACK_OFF_MAX_MS);
}

export function createMeasureCache<T>(classify: (value: T) => MeasureKind, now: () => number = Date.now) {
  let entry: Entry<Measured<T>> | null = null;
  let backOffStreak = 0;

  return async function get(load: () => Promise<T>): Promise<Measured<T>> {
    const t = now();
    if (entry && t < entry.expiresAt) return entry.promise;

    // While loading, callers share this promise, but not forever: a hung
    // request must not hold every later view.
    const current: Entry<Measured<T>> = { promise: Promise.resolve() as unknown as Promise<Measured<T>>, expiresAt: t + IN_FLIGHT_TTL_MS };
    current.promise = (async () => {
      try {
        const value = await load();
        const kind = classify(value);
        if (entry === current) backOffStreak = kind === "back_off" ? backOffStreak + 1 : 0;
        const nextMeasureAt = now() + ttlFor(kind, kind === "back_off" ? Math.max(1, backOffStreak) : 0);
        if (entry === current) current.expiresAt = nextMeasureAt;
        return { value, kind, nextMeasureAt };
      } catch (err) {
        if (entry === current) current.expiresAt = now() + ERROR_TTL_MS;
        throw err;
      }
    })();
    entry = current;
    return current.promise;
  };
}
