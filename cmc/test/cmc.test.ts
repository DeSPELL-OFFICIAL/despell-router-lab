import assert from "node:assert/strict";
import { test } from "node:test";
import { CmcError, createCmcClient } from "../src/cmc.ts";
import { cryptoInfoNvda, fakeFetch, rwaQuotesNvda } from "./helpers.ts";

const KEY = "test-key-not-real";

test("RWA quotes call sends the key only as a header and the symbol as a query", async () => {
  const f = fakeFetch({ "/v5/real-world-assets/quotes/latest": { body: rwaQuotesNvda() } });
  const cmc = createCmcClient({ apiKey: KEY, fetch: f.fetch });
  const res = await cmc.rwaQuotesLatest({ symbol: "NVDA" });

  assert.equal(res.data.rwa_assets[0]?.symbol, "NVDA");
  const req = f.seen[0]!;
  assert.equal(req.url.searchParams.get("symbol"), "NVDA");
  assert.equal(req.headers["x-cmc_pro_api_key"], KEY);
  assert.ok(!req.url.toString().includes(KEY), "key must not be in the URL");
});

test("crypto info asks by id with platform data", async () => {
  const f = fakeFetch({ "/v2/cryptocurrency/info": { body: cryptoInfoNvda() } });
  const cmc = createCmcClient({ apiKey: KEY, fetch: f.fetch });
  const res = await cmc.cryptoInfo([36992, 38093]);

  assert.ok(res.data["36992"]);
  assert.equal(f.seen[0]!.url.searchParams.get("id"), "36992,38093");
  assert.equal(f.seen[0]!.url.searchParams.get("aux"), "platform");
});

test("CMC error envelopes become CmcError without leaking the key", async () => {
  const f = fakeFetch({
    "/v5/real-world-assets/quotes/latest": {
      status: 401,
      body: { status: { timestamp: "t", error_code: "1002", error_message: "API key missing.", elapsed: 1, credit_count: 0 } },
    },
  });
  const cmc = createCmcClient({ apiKey: KEY, fetch: f.fetch });
  await assert.rejects(cmc.rwaQuotesLatest({ symbol: "NVDA" }), (err: unknown) => {
    assert.ok(err instanceof CmcError);
    assert.equal(err.code, "1002");
    assert.equal(err.httpStatus, 401);
    assert.ok(!err.message.includes(KEY));
    return true;
  });
});

test("a 200 with a non-zero error_code is still an error", async () => {
  const f = fakeFetch({
    "/v5/real-world-assets/quotes/latest": {
      body: { data: null, status: { timestamp: "t", error_code: 400, error_message: "Invalid value", elapsed: 1, credit_count: 0 } },
    },
  });
  const cmc = createCmcClient({ apiKey: KEY, fetch: f.fetch });
  await assert.rejects(cmc.rwaQuotesLatest({ symbol: "NOPE" }), CmcError);
});

test("a missing key fails before any request", () => {
  assert.throws(() => createCmcClient({ apiKey: "" }), /CMC_PRO_API_KEY/);
});
