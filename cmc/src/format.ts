// Plain-text table of a comparison, for the CLI and for reports.

import type { CompareResult } from "./compare.ts";
import type { RankedWrapper } from "./rank.ts";

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

function note(r: RankedWrapper): string {
  if (r.best) return "receives the most";
  if (r.bestBlocked === "receives_more_than_spent") return "not best: receives more than spent";
  if (r.bestBlocked === "ranking_incomplete") return "not best: ranking incomplete";
  if (r.bestBlocked === "discount_over_1pct") return "not best: pays over 1% below the stock";
  if (r.tiedWithBest) return "tied with best";
  return r.unavailable ?? "";
}

export function formatTable(result: CompareResult): string {
  const head = [
    `${result.asset.name} (${result.asset.symbol}) wrappers, $${result.spendUsd} of USDC each`,
    `reference price ${usd(result.referencePriceUsd)} (${result.referenceSource}), CMC prices as of ${result.pricesAsOf}, quotes at ${result.quotedAt}`,
  ];
  const cols = ["#", "wrapper", "issuer", "chain", "premium", "receives", "short", "known cost", "price gap", "note"];
  const body = result.rows.map((r, i) => [
    r.receivedValueUsd == null ? "" : String(i + 1),
    r.wrapper.symbol,
    r.wrapper.issuer ?? "-",
    r.wrapper.chainName ?? "-",
    pct(r.premiumPct),
    usd(r.receivedValueUsd),
    usd(r.shortfallUsd),
    usd(r.knownCostUsd),
    usd(r.priceGapUsd),
    note(r),
  ]);
  const widths = cols.map((c, i) => Math.max(c.length, ...body.map((row) => row[i]!.length)));
  const line = (row: string[]) => row.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd();

  const legend = "premium = execution price vs reference; short = spend - receives = known cost (gas + fees) + price gap";
  const notes: string[] = [];
  if (result.incomplete > 0) {
    notes.push(`! ${result.incomplete} quote(s) failed or were incomplete, so no wrapper is marked best: a better one may be missing.`);
  }
  for (const r of result.rows) {
    if (r.unavailable === "quote_failed" || r.unavailable === "quote_incomplete" || r.unavailable === "premium_out_of_band") {
      notes.push(`! ${r.wrapper.symbol} on ${r.wrapper.chainName ?? "-"}: ${r.unavailable}${r.unavailableDetail ? ` (${r.unavailableDetail})` : ""}`);
    }
  }
  return [...head, "", line(cols), ...body.map(line), "", legend, ...notes].join("\n");
}
