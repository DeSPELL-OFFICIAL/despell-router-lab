import assert from "node:assert/strict";
import { test } from "node:test";
import { createCmcClient } from "../src/cmc.ts";
import { compareWrappers } from "../src/compare.ts";
import { formatTable } from "../src/format.ts";
import { NoRouteError, QuoteFailedError, QuoteIncompleteError, type RouteQuoter } from "../src/lifi.ts";
import { cryptoInfoNvda, fakeFetch, rwaQuotesNvda } from "./helpers.ts";

const cmcFixtures = (quotesBody: unknown = rwaQuotesNvda()) => {
  const f = fakeFetch({
    "/v5/real-world-assets/quotes/latest": { body: quotesBody },
    "/v2/cryptocurrency/info": { body: cryptoInfoNvda() },
  });
  return createCmcClient({ apiKey: "test-key-not-real", fetch: f.fetch });
};

// Deterministic stand-in for LI.FI: 0.69 tokens per $100 unless overridden,
// gas by chain, a $0.25 fee inside the route, and no route for the Dinari
// token on Arbitrum.
const GAS_BY_CHAIN: Record<number, number> = { 1: 0.4, 56: 0.03, 42161: 0.02, 8453: 0.01, 57073: 0.01, 196: 0.01, 999: 0.02 };
const fakeQuoter = (overrides: Record<string, number> = {}): { quoter: RouteQuoter; asked: string[] } => {
  const asked: string[] = [];
  const quoter: RouteQuoter = async ({ chainId, tokenAddress, spendUsd }) => {
    const key = `${chainId}:${tokenAddress.toLowerCase()}`;
    asked.push(key);
    if (key === "42161:0x4dafffddea93ddf1e0e7b61e844331455053ce5c") throw new NoRouteError("No available quotes");
    const tokensOut = ((overrides[key] ?? 0.69) * spendUsd) / 100;
    return { tokensOut, gasUsd: GAS_BY_CHAIN[chainId] ?? 0.05, extraFeeUsd: 0, feeUsd: 0.25, tool: "fake", source: "lifi" };
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

  assert.equal(result.incomplete, 0);
  // 18 deployments plus CMC's derivatives index entry, kept as a no_contract row.
  assert.equal(result.rows.length, 19);
  // Solana x2, TON and Robinhood Chain x2 are never sent to the quoter.
  assert.equal(asked.length, 13);

  const [best, second] = result.rows;
  assert.equal(best!.wrapper.symbol, "NVDAon");
  assert.equal(best!.wrapper.chainName, "BNB Smart Chain (BEP20)");
  assert.equal(best!.best, true);
  assert.equal(second!.wrapper.symbol, "NVDAX");
  assert.equal(result.rows.filter((r) => r.best).length, 1);

  const reasons = result.rows.filter((r) => r.unavailable).map((r) => `${r.wrapper.symbol}@${r.wrapper.chainName ?? "-"}:${r.unavailable}`);
  assert.deepEqual(reasons.sort(), [
    "NVDA.D@Arbitrum:no_route",
    "NVDA@-:no_contract",
    "NVDA@Robinhood Chain:unsupported_chain",
    "NVDAX@Solana:non_evm_chain",
    "NVDAX@TON:non_evm_chain",
    "NVDAon@Robinhood Chain:unsupported_chain",
    "NVDAon@Solana:non_evm_chain",
  ]);
  // Unavailable rows are all at the bottom.
  const firstUnavailable = result.rows.findIndex((r) => r.unavailable);
  assert.ok(result.rows.slice(firstUnavailable).every((r) => r.unavailable));

  // Received value is exposure at the reference price, net of gas; the
  // shortfall splits into known cost and price gap.
  assert.ok(Math.abs(best!.receivedValueUsd! - (0.6935 * 143.21885213502998 - 0.03)) < 1e-9);
  assert.ok(Math.abs(best!.knownCostUsd! - 0.28) < 1e-9);
  assert.ok(Math.abs(best!.knownCostUsd! + best!.priceGapUsd! - best!.shortfallUsd!) < 1e-9);

  const table = formatTable(result);
  assert.match(table, /receives the most/);
  assert.match(table, /CMC prices as of 2026-11-25T17:09:11.539Z/);
});

test("a given reference price replaces the CMC tokenized average", async () => {
  const { quoter } = fakeQuoter();
  const result = await compareWrappers({ cmc: cmcFixtures(), quoter, symbol: "NVDA", referencePriceUsd: 145, spendUsd: 50 });
  assert.equal(result.referenceSource, "given");
  assert.equal(result.referencePriceUsd, 145);
  assert.equal(result.spendUsd, 50);
  const nvdac = result.rows.find((r) => r.wrapper.symbol === "NVDAc")!;
  assert.ok(Math.abs(nvdac.cmcPremiumPct! - (142.79707847961018 / 145 - 1) * 100) < 1e-9);
  assert.ok(Math.abs(nvdac.premiumPct! - (((50 - 0.25) / 0.345) / 145 - 1) * 100) < 1e-9);
});

test("a failed quote is kept apart from no route, and the table warns about it", async () => {
  const { quoter } = fakeQuoter();
  const flaky: RouteQuoter = async (req) => {
    if (req.chainId === 8453) throw new QuoteFailedError("LI.FI HTTP 429: Rate limit exceeded");
    return quoter(req);
  };
  const result = await compareWrappers({ cmc: cmcFixtures(), quoter: flaky, symbol: "NVDA" });
  const nvdac = result.rows.find((r) => r.wrapper.symbol === "NVDAc")!;
  assert.equal(nvdac.unavailable, "quote_failed");
  assert.equal(result.incomplete, 1);
  assert.ok(result.rows.every((r) => !r.best), "an incomplete ranking crowns no one");
  const table = formatTable(result);
  assert.match(table, /1 quote\(s\) failed or were incomplete/);
  assert.match(table, /NVDAc on Base: quote_failed \(LI\.FI HTTP 429/);
});

test("the asset must match the ticker exactly", async () => {
  const body = rwaQuotesNvda();
  body.data!.rwa_assets[0]!.symbol = "NVDL";
  const { quoter } = fakeQuoter();
  await assert.rejects(compareWrappers({ cmc: cmcFixtures(body), quoter, symbol: "NVDA" }), /no RWA asset with symbol NVDA \(got NVDL\)/);
  // Case does not matter.
  const ok = await compareWrappers({ cmc: cmcFixtures(), quoter, symbol: "nvda" });
  assert.equal(ok.asset.symbol, "NVDA");
});

test("an asset with no tokens is a clear error", async () => {
  const body = rwaQuotesNvda();
  const a = body.data!.rwa_assets[0]!;
  a.has_tokens = false;
  delete a.tokens;
  const { quoter } = fakeQuoter();
  await assert.rejects(compareWrappers({ cmc: cmcFixtures(body), quoter, symbol: "NVDA" }), /no tokenized wrappers/);
});

test("bad spend, concurrency and reference values are refused before any call", async () => {
  const { quoter, asked } = fakeQuoter();
  const cmc = cmcFixtures();
  for (const spendUsd of [Number.NaN, 0, -5, 1e21]) {
    await assert.rejects(compareWrappers({ cmc, quoter, symbol: "NVDA", spendUsd }), /spend must be/);
  }
  for (const concurrency of [Number.NaN, 0, 1.5]) {
    await assert.rejects(compareWrappers({ cmc, quoter, symbol: "NVDA", concurrency }), /concurrency must be/);
  }
  await assert.rejects(compareWrappers({ cmc, quoter, symbol: "NVDA", referencePriceUsd: -1 }), /reference price/);
  assert.equal(asked.length, 0);
});

test("a quote missing cost fields counts as incomplete", async () => {
  const { quoter } = fakeQuoter();
  const partial: RouteQuoter = async (req) => {
    if (req.chainId === 56) throw new QuoteIncompleteError("a gas cost has no USD amount");
    return quoter(req);
  };
  const result = await compareWrappers({ cmc: cmcFixtures(), quoter: partial, symbol: "NVDA" });
  assert.equal(result.rows.filter((r) => r.unavailable === "quote_incomplete").length, 3); // NVDAX, NVDAon, NVDAB on BNB
  assert.equal(result.incomplete, 3);
  assert.ok(result.rows.every((r) => !r.best));
});

test("the premium band and tie width are passed through and checked", async () => {
  const { quoter } = fakeQuoter();
  // Every fake quote pays about +0.94% over the reference: out of a 0.5% band.
  const narrow = await compareWrappers({ cmc: cmcFixtures(), quoter, symbol: "NVDA", maxPremiumPct: 0.5 });
  assert.ok(narrow.rows.every((r) => r.receivedValueUsd == null || r.premiumPct! <= 0.5));
  assert.ok(narrow.rows.some((r) => r.unavailable === "premium_out_of_band"));
  await assert.rejects(compareWrappers({ cmc: cmcFixtures(), quoter, symbol: "NVDA", maxPremiumPct: 25 }), /maxPremiumPct/);
  await assert.rejects(compareWrappers({ cmc: cmcFixtures(), quoter, symbol: "NVDA", tieUsd: -1 }), /tieUsd/);
});
