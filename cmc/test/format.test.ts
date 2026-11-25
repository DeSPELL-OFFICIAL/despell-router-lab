import assert from "node:assert/strict";
import { test } from "node:test";
import type { CompareResult } from "../src/compare.ts";
import { formatTable } from "../src/format.ts";
import type { RankedWrapper } from "../src/rank.ts";

const row = (symbol: string, premiumPct: number, receivedValueUsd: number, extra: Partial<RankedWrapper> = {}): RankedWrapper => ({
  wrapper: {
    cryptoId: 1, symbol, name: symbol, issuer: "Issuer", cmcPriceUsd: 100, cmcMarketCapUsd: 1, cmcVolume24hUsd: 1,
    listing: "deployed", chainName: "Base", chainId: 8453, chainKind: "evm", address: "0x0000000000000000000000000000000000000001",
  },
  cmcPremiumPct: 0,
  quote: null,
  execPriceUsd: 100,
  premiumPct,
  receivedValueUsd,
  shortfallUsd: 100 - receivedValueUsd,
  knownCostUsd: 0.3,
  priceGapUsd: 100 - receivedValueUsd - 0.3,
  unavailable: null,
  best: false,
  tiedWithBest: false,
  ...extra,
});

const result = (rows: RankedWrapper[], incomplete = 0): CompareResult => ({
  asset: { rwaId: 2, symbol: "NVDA", name: "Nvidia Corp" },
  spendUsd: 100,
  referencePriceUsd: 144.59,
  referenceSource: "cmc_average_tokenized_price",
  pricesAsOf: "2026-11-25T17:24:13.778Z",
  cmcRespondedAt: "2026-11-25T17:24:14.000Z",
  quotedAt: "2026-11-25T17:25:03.409Z",
  incomplete,
  rows,
});

test("negative money and near-zero percentages print cleanly", () => {
  const table = formatTable(result([row("A", -0.001, 99.9, { best: true, priceGapUsd: -0.58 }), row("B", 0.54, 99.5)]));
  assert.match(table, /-\$0\.58/);
  assert.match(table, /\+0\.00%/);
  assert.doesNotMatch(table, /\$-|-0\.00%/);
  assert.match(table, /receives the most/);
  assert.match(table, /short = spend - receives = known cost/);
});

test("ties, blocked best rows and incomplete rankings are spelled out", () => {
  const table = formatTable(
    result(
      [
        row("Over", -2, 100.4, { bestBlocked: "receives_more_than_spent" }),
        row("Best", 0.1, 99.8, { best: true }),
        row("Close", 0.12, 99.77, { tiedWithBest: true }),
      ],
      0,
    ),
  );
  assert.match(table, /not best: receives more than spent/);
  assert.match(table, /tied with best/);

  const partial = formatTable(result([row("Top", 0.1, 99.8, { bestBlocked: "ranking_incomplete" })], 2));
  assert.match(partial, /2 quote\(s\) failed or were incomplete, so no wrapper is marked best/);
  assert.match(partial, /not best: ranking incomplete/);
});
