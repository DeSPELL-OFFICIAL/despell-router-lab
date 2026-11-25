// Plain-text table of a comparison, for the CLI and for reports.

import type { CompareResult } from "./compare.ts";

const usd = (v: number | null) => (v == null ? "-" : `$${v.toFixed(2)}`);
const pct = (v: number | null) => (v == null ? "-" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);

export function formatTable(result: CompareResult): string {
  const head = [
    `${result.asset.name} (${result.asset.symbol}) wrappers, $${result.spendUsd} of USDC each`,
    `reference price ${usd(result.referencePriceUsd)} (${result.referenceSource}), CMC prices as of ${result.pricesAsOf}, quotes at ${result.quotedAt}`,
  ];
  const cols = ["#", "wrapper", "issuer", "chain", "CMC price", "premium", "route cost", "receives", "note"];
  const body = result.rows.map((r, i) => [
    r.unavailable ? "" : String(i + 1),
    r.wrapper.symbol,
    r.wrapper.issuer ?? "-",
    r.wrapper.chainName,
    usd(r.wrapper.cmcPriceUsd),
    pct(r.premiumPct),
    usd(r.routeCostUsd),
    usd(r.receivedValueUsd),
    r.best ? "receives the most" : (r.unavailable ?? ""),
  ]);
  const widths = cols.map((c, i) => Math.max(c.length, ...body.map((row) => row[i]!.length)));
  const line = (row: string[]) => row.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd();
  return [...head, "", line(cols), ...body.map(line)].join("\n");
}
