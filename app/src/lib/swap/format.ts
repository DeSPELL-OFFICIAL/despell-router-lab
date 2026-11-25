import { formatUnits, type Address } from "viem";

/** Trims a decimal string to at most `digits` places, dropping trailing zeros. */
export function trimDecimal(value: string, digits: number): string {
  const [whole, frac = ""] = value.split(".");
  const cut = frac.slice(0, digits).replace(/0+$/u, "");
  return cut ? `${whole}.${cut}` : whole;
}

/** Rounds down: the card never shows more than the bytes promise. */
export const fmtUnits = (value: bigint, decimals: number, digits: number) => trimDecimal(formatUnits(value, decimals), digits);

export const fmtUsdc = (value: bigint) => fmtUnits(value, 6, 6);
export const fmtEth = (value: bigint) => fmtUnits(value, 18, 8);

export const short = (address: Address) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/** Hundredths of a bip to percent: 500 -> "0.05%". */
export const fmtFee = (fee: number) => `${trimDecimal((fee / 10_000).toFixed(4), 4)}%`;

/** Unix seconds to "YYYY-MM-DD HH:MM UTC", the same on server and client. The date is always shown. */
export function fmtTime(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}
