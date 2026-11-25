import assert from "node:assert/strict";
import { test } from "node:test";
import { createLifiQuoter, NoRouteError, parseLifiQuote, UnsupportedChainError } from "../src/lifi.ts";
import { fakeFetch, lifiQuoteNvdax } from "./helpers.ts";

// NVDAx (Backed xStock) contract, same address on Ethereum and BNB Smart Chain.
const NVDAX = "0xc845b2894dbddd03858fd2d643b4ef725fe0849d";

test("a recorded LI.FI quote parses into tokens out, gas and fees", () => {
  const q = parseLifiQuote(lifiQuoteNvdax());
  assert.equal(q.tokensOut, 0.685596148960855662);
  assert.equal(q.gasUsd, 0.2191);
  assert.equal(q.feeUsd, 0.2506);
  assert.equal(q.tool, "lifiIntentsDex");
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
});

test("chains without a pay token and failed quotes are typed errors", async () => {
  const f = fakeFetch({ "/v1/quote": { status: 404, body: { message: "No available quotes for the requested transfer" } } });
  const quote = createLifiQuoter({ fetch: f.fetch });

  await assert.rejects(quote({ chainId: 424242, tokenAddress: "0x1", spendUsd: 100 }), UnsupportedChainError);
  await assert.rejects(quote({ chainId: 1, tokenAddress: "0x1", spendUsd: 100 }), (err: unknown) => {
    assert.ok(err instanceof NoRouteError);
    assert.match(err.message, /No available quotes/);
    return true;
  });
  assert.throws(() => parseLifiQuote({}), NoRouteError);
});
