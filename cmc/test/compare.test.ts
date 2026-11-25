import assert from "node:assert/strict";
import { test } from "node:test";
import { createCmcClient } from "../src/cmc.ts";
import { compareWrappers } from "../src/compare.ts";
import { formatTable } from "../src/format.ts";
import { NoRouteError, type RouteQuoter } from "../src/lifi.ts";
import { cryptoInfoNvda, fakeFetch, rwaQuotesNvda } from "./helpers.ts";

const cmcFixtures = () => {
  const f = fakeFetch({
    "/v5/real-world-assets/quotes/latest": { body: rwaQuotesNvda() },
    "/v2/cryptocurrency/info": { body: cryptoInfoNvda() },
  });
  return createCmcClient({ apiKey: "test-key-not-real", fetch: f.fetch });
};

// Deterministic stand-in for LI.FI: 0.69 tokens unless overridden, gas by
// chain, and no route for the Dinari token on Arbitrum.
const GAS_BY_CHAIN: Record<number, number> = { 1: 0.4, 56: 0.03, 42161: 0.02, 8453: 0.01, 57073: 0.01, 196: 0.01, 999: 0.02 };
const fakeQuoter = (overrides: Record<string, number> = {}): { quoter: RouteQuoter; asked: string[] } => {
  const asked: string[] = [];
  const quoter: RouteQuoter = async ({ chainId, tokenAddress }) => {
    const key = `${chainId}:${tokenAddress.toLowerCase()}`;
    asked.push(key);
    if (key === "42161:0x4dafffddea93ddf1e0e7b61e844331455053ce5c") throw new NoRouteError("No available quotes");
    const tokensOut = overrides[key] ?? 0.69;
    return { tokensOut, gasUsd: GAS_BY_CHAIN[chainId] ?? 0.05, feeUsd: 0.25, tool: "fake", source: "lifi" };
  };
  return { quoter, asked };
};

test("NVIDIA: wrappers are grouped, quoted and ranked by what $100 receives", async () => {
  // Make NVDAon on BNB clearly the best and NVDAX on Ethereum second.
  const { quoter, asked } = fakeQuoter({
    "56:0xa9ee28c80f960b889dfbd1902055218cba016f75": 0.6935,
    "1:0xc845b2894dbddd03858fd2d643b4ef725fe0849d": 0.6930,
  });
  const result = await compareWrappers({
    cmc: cmcFixtures(),
    quoter,
    symbol: "NVDA",
    now: () => new Date("2026-11-25T17:10:00.000Z"),
  });

  assert.equal(result.asset.symbol, "NVDA");
  assert.equal(result.spendUsd, 100);
  assert.equal(result.referenceSource, "cmc_average_tokenized_price");
  assert.equal(result.referencePriceUsd, 143.21885213502998);
  assert.equal(result.pricesAsOf, "2026-11-25T17:09:11.539Z");
  assert.equal(result.cmcRespondedAt, "2026-11-25T17:09:31.796Z");
  assert.equal(result.quotedAt, "2026-11-25T17:10:00.000Z");

  assert.equal(result.rows.length, 18);
  // Solana x2, TON and Robinhood Chain x2 are never sent to the quoter.
  assert.equal(asked.length, 13);

  const [best, second] = result.rows;
  assert.equal(best!.wrapper.symbol, "NVDAon");
  assert.equal(best!.wrapper.chainName, "BNB Smart Chain (BEP20)");
  assert.equal(best!.best, true);
  assert.equal(second!.wrapper.symbol, "NVDAX");
  assert.equal(result.rows.filter((r) => r.best).length, 1);

  const reasons = result.rows.filter((r) => r.unavailable).map((r) => `${r.wrapper.symbol}@${r.wrapper.chainName}:${r.unavailable}`);
  assert.deepEqual(reasons.sort(), [
    "NVDA.D@Arbitrum:no_route",
    "NVDA@Robinhood Chain:unsupported_chain",
    "NVDAX@Solana:non_evm_chain",
    "NVDAX@TON:non_evm_chain",
    "NVDAon@Robinhood Chain:unsupported_chain",
    "NVDAon@Solana:non_evm_chain",
  ]);
  // Unavailable rows are all at the bottom.
  const firstUnavailable = result.rows.findIndex((r) => r.unavailable);
  assert.ok(result.rows.slice(firstUnavailable).every((r) => r.unavailable));

  // Received value is exposure at the reference price, net of gas.
  assert.ok(Math.abs(best!.receivedValueUsd! - (0.6935 * 143.21885213502998 - 0.03)) < 1e-9);

  const table = formatTable(result);
  assert.match(table, /receives the most/);
  assert.match(table, /CMC prices as of 2026-11-25T17:09:11.539Z/);
});

test("a given reference price replaces the CMC tokenized average", async () => {
  const { quoter } = fakeQuoter();
  const result = await compareWrappers({ cmc: cmcFixtures(), quoter, symbol: "NVDA", referencePriceUsd: 150, spendUsd: 50 });
  assert.equal(result.referenceSource, "given");
  assert.equal(result.referencePriceUsd, 150);
  assert.equal(result.spendUsd, 50);
  const nvdac = result.rows.find((r) => r.wrapper.symbol === "NVDAc")!;
  assert.ok(Math.abs(nvdac.premiumPct! - (142.79707847961018 / 150 - 1) * 100) < 1e-9);
});
