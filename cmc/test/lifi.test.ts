import assert from "node:assert/strict";
import { test } from "node:test";
import { createLifiQuoter, NoRouteError, parseLifiQuote, QuoteFailedError, QuoteIncompleteError, UnsupportedChainError } from "../src/lifi.ts";
import { fakeFetch, lifiQuoteNvdax } from "./helpers.ts";

// NVDAx (Backed xStock) contract, same address on Ethereum and BNB Smart Chain.
const NVDAX = "0xc845b2894dbddd03858fd2d643b4ef725fe0849d";

test("a recorded LI.FI quote parses into tokens out, gas and fees", () => {
  const q = parseLifiQuote(lifiQuoteNvdax());
  assert.equal(q.tokensOut, 0.685596148960855662);
  assert.equal(q.gasUsd, 0.2191);
  assert.equal(q.feeUsd, 0.2506);
  assert.equal(q.extraFeeUsd, 0);
  assert.equal(q.tool, "lifiIntentsDex");
});

test("fees with included:false are paid on top and kept apart", () => {
  const body = lifiQuoteNvdax();
  body.estimate!.feeCosts = [
    { amountUSD: "0.25", included: true },
    { amountUSD: "1.50", included: false },
  ];
  const q = parseLifiQuote(body);
  assert.equal(q.feeUsd, 0.25);
  assert.equal(q.extraFeeUsd, 1.5);
});

test("the quoter pays exact USDC base units on the same chain", async () => {
  const f = fakeFetch({ "/v1/quote": { body: lifiQuoteNvdax() } });
  const quote = createLifiQuoter({ fetch: f.fetch });

  await quote({ chainId: 1, tokenAddress: NVDAX, spendUsd: 100 });
  const p = f.seen[0]!.url.searchParams;
  assert.equal(p.get("fromChain"), "1");
  assert.equal(p.get("toChain"), "1");
  assert.equal(p.get("fromToken"), "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
  assert.equal(p.get("fromAmount"), "100000000");

  // USDC on BNB Smart Chain has 18 decimals.
  await quote({ chainId: 56, tokenAddress: NVDAX, spendUsd: 100 });
  assert.equal(f.seen[1]!.url.searchParams.get("fromAmount"), "100000000000000000000");

  await quote({ chainId: 1, tokenAddress: NVDAX, spendUsd: 0.1 + 0.2 });
  assert.equal(f.seen[2]!.url.searchParams.get("fromAmount"), "300000");
});

test("404 means no route; other failures mean the quote failed", async () => {
  const notFound = fakeFetch({ "/v1/quote": { status: 404, body: { message: "No available quotes for the requested transfer" } } });
  await assert.rejects(createLifiQuoter({ fetch: notFound.fetch })({ chainId: 1, tokenAddress: NVDAX, spendUsd: 100 }), (err: unknown) => {
    assert.ok(err instanceof NoRouteError);
    assert.match(err.message, /No available quotes/);
    return true;
  });

  const limited = fakeFetch({ "/v1/quote": { status: 429, body: { message: "Rate limit exceeded" } } });
  await assert.rejects(
    createLifiQuoter({ fetch: limited.fetch })({ chainId: 1, tokenAddress: NVDAX, spendUsd: 100 }),
    (err: unknown) => err instanceof QuoteFailedError && /429/.test(err.message),
  );

  const offline = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  await assert.rejects(createLifiQuoter({ fetch: offline })({ chainId: 1, tokenAddress: NVDAX, spendUsd: 100 }), QuoteFailedError);

  await assert.rejects(createLifiQuoter({ fetch: notFound.fetch })({ chainId: 424242, tokenAddress: NVDAX, spendUsd: 100 }), UnsupportedChainError);
  assert.throws(() => parseLifiQuote({}), QuoteFailedError);
});

test("missing cost fields make a quote incomplete instead of free", () => {
  const withGas = (gasCosts: unknown) => ({ ...lifiQuoteNvdax(), estimate: { ...lifiQuoteNvdax().estimate, gasCosts } }) as Parameters<typeof parseLifiQuote>[0];
  const withFees = (feeCosts: unknown) => ({ ...lifiQuoteNvdax(), estimate: { ...lifiQuoteNvdax().estimate, feeCosts } }) as Parameters<typeof parseLifiQuote>[0];

  assert.throws(() => parseLifiQuote(withGas([])), QuoteIncompleteError);
  assert.throws(() => parseLifiQuote(withGas([{ type: "SEND" }])), QuoteIncompleteError);
  assert.throws(() => parseLifiQuote(withGas([{ type: "SEND", amountUSD: "n/a" }])), QuoteIncompleteError);
  assert.throws(() => parseLifiQuote(withFees([{ amountUSD: "0.25" }])), /whether it is included/);
  assert.throws(() => parseLifiQuote(withFees([{ included: true }])), QuoteIncompleteError);
  // No fees at all is fine.
  assert.equal(parseLifiQuote(withFees([])).feeUsd, 0);
});
