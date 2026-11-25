import assert from "node:assert/strict";
import { test } from "node:test";
import type { CompareResult } from "../src/compare.ts";
import { formatTable } from "../src/format.ts";
import type { RankedWrapper } from "../src/rank.ts";

const row = (symbol: string, premiumPct: number, routeCostUsd: number, receivedValueUsd: number, best = false): RankedWrapper => ({
  wrapper: {
    cryptoId: 1, symbol, name: symbol, issuer: "Issuer", cmcPriceUsd: 100, cmcMarketCapUsd: 1,
    chainName: "Base", chainId: 8453, chainKind: "evm", address: "0x0000000000000000000000000000000000000001",
  },
  premiumPct,
  quote: null,
  routeCostUsd,
  receivedValueUsd,
  unavailable: null,
  best,
});

test("negative money and near-zero percentages print cleanly", () => {
  const result: CompareResult = {
    asset: { rwaId: 2, symbol: "NVDA", name: "Nvidia Corp" },
    spendUsd: 100,
    referencePriceUsd: 144.59,
    referenceSource: "cmc_average_tokenized_price",
    pricesAsOf: "2026-11-25T17:24:13.778Z",
    cmcRespondedAt: "2026-11-25T17:24:14.000Z",
    quotedAt: "2026-11-25T17:25:03.409Z",
    rows: [row("A", -0.001, -0.58, 100.05, true), row("B", 0.54, 0.271, 99.5)],
  };
  const table = formatTable(result);
  assert.match(table, /-\$0\.58/);
  assert.match(table, /\+0\.00%/);
  assert.doesNotMatch(table, /\$-|-0\.00%/);
  assert.match(table, /\+0\.54%\s+\$0\.27\s+\$99\.50/);
});
