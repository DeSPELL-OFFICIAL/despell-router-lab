// Integer base units <-> decimal numbers, without going through floats on the
// way in (amounts sent to quote APIs must be exact integers).

/** "100" or "100.5" with 6 decimals -> "100500000". Extra fraction digits are cut. */
export function toBaseUnits(amount: string, decimals: number): string {
  if (!/^\d+(\.\d+)?$/.test(amount)) throw new Error(`not a decimal amount: ${amount}`);
  const [whole = "0", frac = ""] = amount.split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || "0");
  return units.toString();
}

/** "685596148960855662" with 18 decimals -> 0.685596148960855662 (as a number). */
export function fromBaseUnits(units: string, decimals: number): number {
  if (!/^\d+$/.test(units)) throw new Error(`not an integer amount: ${units}`);
  const scale = 10n ** BigInt(decimals);
  const big = BigInt(units);
  const whole = big / scale;
  const frac = (big % scale).toString().padStart(decimals, "0");
  return Number(decimals === 0 ? whole.toString() : `${whole}.${frac}`);
}
