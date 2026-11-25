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
    createLifiQuoter({ fetch: limited.fetch, sleep: async () => {} })({ chainId: 1, tokenAddress: NVDAX, spendUsd: 100 }),
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

test("a negative USD amount makes a quote incomplete", () => {
  const body = lifiQuoteNvdax();
  body.estimate!.gasCosts = [{ amountUSD: "-0.5" }];
  assert.throws(() => parseLifiQuote(body), QuoteIncompleteError);
  const fees = lifiQuoteNvdax();
  fees.estimate!.feeCosts = [{ amountUSD: "-1", included: true }];
  assert.throws(() => parseLifiQuote(fees), QuoteIncompleteError);
});

test("a 429 is retried once, after the Retry-After wait (capped)", async () => {
  let calls = 0;
  const waits: number[] = [];
  const sleep = async (ms: number) => {
    waits.push(ms);
  };
  const thenOk = (async () => {
    calls++;
    return calls === 1
      ? new Response(JSON.stringify({ message: "Rate limit exceeded" }), { status: 429, headers: { "retry-after": "2" } })
      : new Response(JSON.stringify(lifiQuoteNvdax()), { status: 200 });
  }) as typeof fetch;
  const q = await createLifiQuoter({ fetch: thenOk, sleep })({ chainId: 1, tokenAddress: NVDAX, spendUsd: 100 });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [2000]);
  assert.equal(q.tool, "lifiIntentsDex");

  calls = 0;
  waits.length = 0;
  const always429 = (async () => {
    calls++;
    return new Response("{}", { status: 429, headers: { "retry-after": "600" } });
  }) as typeof fetch;
  await assert.rejects(createLifiQuoter({ fetch: always429, sleep })({ chainId: 1, tokenAddress: NVDAX, spendUsd: 100 }), QuoteFailedError);
  assert.equal(calls, 2, "only one retry");
  assert.deepEqual(waits, [5000], "wait is capped");
});

test("a blank USD amount is incomplete, not free", () => {
  const gas = lifiQuoteNvdax();
  gas.estimate!.gasCosts = [{ amountUSD: " " }];
  assert.throws(() => parseLifiQuote(gas), QuoteIncompleteError);
  const fee = lifiQuoteNvdax();
  fee.estimate!.feeCosts = [{ amountUSD: "  ", included: true }];
  assert.throws(() => parseLifiQuote(fee), QuoteIncompleteError);
});

test("a 429 without Retry-After waits the default second before retrying", async () => {
  let calls = 0;
  const waits: number[] = [];
  const noHeader = (async () => {
    calls++;
    return calls === 1 ? new Response("{}", { status: 429 }) : new Response(JSON.stringify(lifiQuoteNvdax()), { status: 200 });
  }) as typeof fetch;
  await createLifiQuoter({ fetch: noHeader, sleep: async (ms) => void waits.push(ms) })({ chainId: 1, tokenAddress: NVDAX, spendUsd: 100 });
  assert.deepEqual(waits, [1000]);
});

test("a LI.FI API key, when given, travels only in its header", async () => {
  const f = fakeFetch({ "/v1/quote": { body: lifiQuoteNvdax() } });
  await createLifiQuoter({ fetch: f.fetch, apiKey: "lifi-test-key" })({ chainId: 1, tokenAddress: NVDAX, spendUsd: 100 });
  assert.equal(f.seen[0]!.headers["x-lifi-api-key"], "lifi-test-key");
  assert.ok(!f.seen[0]!.url.toString().includes("lifi-test-key"));
  const none = fakeFetch({ "/v1/quote": { body: lifiQuoteNvdax() } });
  await createLifiQuoter({ fetch: none.fetch })({ chainId: 1, tokenAddress: NVDAX, spendUsd: 100 });
  assert.equal(none.seen[0]!.headers["x-lifi-api-key"], undefined);
});
