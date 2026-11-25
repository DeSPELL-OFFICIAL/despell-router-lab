// Plain-text table of a comparison, for the CLI and for reports.

import type { CompareResult } from "./compare.ts";

// Round first so -0.001 prints as 0.00 with no stray minus sign.
const round2 = (v: number) => {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
};
const usd = (v: number | null) => {
  if (v == null) return "-";
  const r = round2(v);
  return `${r < 0 ? "-" : ""}$${Math.abs(r).toFixed(2)}`;
};
const pct = (v: number | null) => {
  if (v == null) return "-";
  const r = round2(v);
  return `${r < 0 ? "-" : "+"}${Math.abs(r).toFixed(2)}%`;
};

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

  // Rows left out for reasons that may hide a better wrapper are spelled out.
  const notes = result.rows
    .filter((r) => r.unavailable === "quote_failed" || r.unavailable === "implausible_quote")
    .map((r) => `! ${r.wrapper.symbol} on ${r.wrapper.chainName}: ${r.unavailable}${r.unavailableDetail ? ` (${r.unavailableDetail})` : ""}`);
  if (result.rows.some((r) => r.unavailable === "quote_failed")) {
    notes.unshift("! Some quotes failed, so a wrapper that receives more may be missing from the ranking.");
  }
  return [...head, "", line(cols), ...body.map(line), ...(notes.length ? ["", ...notes] : [])].join("\n");
}
