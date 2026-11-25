import assert from "node:assert/strict";
import { test } from "node:test";
import { createCmcClient } from "../src/cmc.ts";
import { createDespellConnector, prepareWrapperBuy, type Buyability } from "../src/despell.ts";
import { NoRouteError, QuoteFailedError, type RouteQuoter } from "../src/lifi.ts";
import { loadWrapperScreen } from "../src/screen.ts";
import { buildWrapperScreen, rowKey } from "../src/view.ts";
import { compareWrappers } from "../src/compare.ts";
import { cryptoInfoNvda, fakeConnector, fakeFetch, rwaQuotesNvda } from "./helpers.ts";

const cmc = () => {
  const f = fakeFetch({
    "/v5/real-world-assets/quotes/latest": { body: rwaQuotesNvda() },
    "/v2/cryptocurrency/info": { body: cryptoInfoNvda() },
  });
  return createCmcClient({ apiKey: "test-key-not-real", fetch: f.fetch });
};

// Fixture reference is $143.22. Tokens per $100 by wrapper; anything else 0.69.
const OUT: Record<string, number> = {
  "42161:0x0a85b6ebe3c150a1979a65656e304033d62b1e12": 0.6950, // rNVDA, Arbitrum: best, not on DeSpell
  "8453:0xb20000000000000000000078ee7ce2fe4908108c": 0.6940, // NVDAc, Base: next
  "56:0x02fca66c1d1afb4e2a7884261eb00f63598a7436": 0.6939, // NVDAB, BNB: third
};
const quoter = (fail: Set<number> = new Set()): RouteQuoter => async ({ chainId, tokenAddress, spendUsd }) => {
  if (fail.has(chainId)) throw new QuoteFailedError("LI.FI HTTP 429");
  const key = `${chainId}:${tokenAddress.toLowerCase()}`;
  return { tokensOut: ((OUT[key] ?? 0.69) * spendUsd) / 100, gasUsd: 0.02, extraFeeUsd: 0, feeUsd: 0.25, tool: "fake", source: "lifi" };
};
// LI.FI had no route for the Dinari token on Arbitrum.
const noDinari = (q: RouteQuoter): RouteQuoter => async (req) => {
  if (req.tokenAddress.toLowerCase() === "0x4dafffddea93ddf1e0e7b61e844331455053ce5c") throw new NoRouteError("No available quotes");
  return q(req);
};

// DeSpell's verified list as find_token saw it on 2026-11-26: rNVDA (Arbitrum) and WNVDAX (X Layer) are not on it.
const NOT_ON_DESPELL = new Set(["42161:0x0a85b6ebe3c150a1979a65656e304033d62b1e12", "196:0xa8ddb5cd96b5222afe198316e9a57caa642850d5"]);
const despell = () =>
  fakeConnector((tool, args) => {
    if (tool === "find_token") {
      const key = `${args.chainId}:${String(args.query).toLowerCase()}`;
      return NOT_ON_DESPELL.has(key)
        ? { ok: true, status: "not_found", suggestions: [] }
        : { ok: true, status: "resolved", token: { chainId: args.chainId, address: String(args.query).toLowerCase() } };
    }
    if (tool === "prepare_swap") {
      const t = (args.trades as Record<string, unknown>[])[0]!;
      return {
        ok: true,
        executed: false,
        url: "https://app.despell.io/?handoff=BBBBBBBBBBBBBBBBBBBBBB",
        expiresAt: "2026-11-25T18:30:00.000Z",
        trades: [
          {
            kind: "swap",
            fromChainId: t.fromChainId,
            toChainId: t.fromChainId,
            fromToken: { symbol: "USDC", address: t.fromToken },
            toToken: { symbol: "WRAP", address: t.toToken },
            amount: t.amount,
          },
        ],
      };
    }
    throw new Error(`unexpected tool ${tool}`);
  });

test("best stays on the true winner; the first buyable row gets 'most you can buy on DeSpell'", async () => {
  const d = despell();
  const screen = await loadWrapperScreen({
    cmc: cmc(),
    quoter: noDinari(quoter()),
    symbol: "NVDA",
    connector: createDespellConnector({ fetch: d.fetch }),
  });

  assert.equal(screen.noBest, null);
  const [first, second] = screen.rows;
  assert.equal(first!.symbol, "rNVDA");
  assert.deepEqual(first!.badges, ["best"]);
  assert.deepEqual(first!.buy, { kind: "disabled", reason: "not_on_despell" });
  assert.equal(second!.symbol, "NVDAc");
  assert.deepEqual(second!.badges, ["best_buyable"]);
  assert.deepEqual(second!.buy, { kind: "enabled" });
  assert.equal(screen.rows.filter((r) => r.badges.includes("best_buyable")).length, 1);

  // WNVDAX on X Layer is ranked but cannot be bought either.
  const wnvdax = screen.rows.find((r) => r.symbol === "WNVDAX" && r.chainName === "X Layer")!;
  assert.equal(wnvdax.buy.kind, "disabled");

  // Unranked rows are folded with reasons, not shown as rows.
  assert.equal(screen.rows.length + screen.folded.length, 19);
  assert.ok(screen.folded.some((f) => f.reason === "non_evm_chain"));
  assert.ok(screen.folded.some((f) => f.reason === "no_contract"));
  // find_token is asked only for ranked rows.
  assert.equal(d.calls.filter((c) => c.tool === "find_token").length, screen.rows.length);
});

test("the link made from a row carries that row's chain, token address and amount", async () => {
  const d = despell();
  const connector = createDespellConnector({ fetch: d.fetch });
  const screen = await loadWrapperScreen({ cmc: cmc(), quoter: noDinari(quoter()), symbol: "NVDA", connector });
  for (const row of screen.rows.filter((r) => r.buy.kind === "enabled")) {
    const link = await prepareWrapperBuy(connector, { chainId: row.chainId, tokenAddress: row.address, amount: String(screen.spendUsd) });
    assert.equal(link.chainId, row.chainId, row.key);
    assert.equal(link.receive.address, row.address.toLowerCase(), row.key);
    assert.equal(link.amount, String(screen.spendUsd), row.key);
    const asked = d.calls.at(-1)!.args.trades as Record<string, unknown>[];
    assert.deepEqual(asked, [{ fromChainId: row.chainId, fromToken: link.pay.address, toToken: row.address, amount: "100" }]);
  }
});

test("when the best row can be bought, no second badge appears", async () => {
  const result = await compareWrappers({ cmc: cmc(), quoter: noDinari(quoter()), symbol: "NVDA" });
  const everyoneBuyable = new Map<string, Buyability>(
    result.rows.filter((r) => r.wrapper.chainId != null).map((r) => [rowKey(r.wrapper.chainId, r.wrapper.address, r.wrapper.symbol), { buyable: true }]),
  );
  const screen = buildWrapperScreen(result, everyoneBuyable);
  assert.deepEqual(screen.rows[0]!.badges, ["best"]);
  assert.ok(!screen.rows.some((r) => r.badges.includes("best_buyable")));
});

test("an incomplete ranking shows no badges and says why", async () => {
  const d = despell();
  const screen = await loadWrapperScreen({
    cmc: cmc(),
    quoter: noDinari(quoter(new Set([56]))), // every BNB quote fails
    symbol: "NVDA",
    connector: createDespellConnector({ fetch: d.fetch }),
  });
  assert.equal(screen.noBest, "incomplete");
  assert.equal(screen.incomplete, 3);
  assert.ok(screen.rows.every((r) => !r.badges.includes("best") && !r.badges.includes("best_buyable")));
  assert.ok(screen.folded.filter((f) => f.reason === "quote_failed").length === 3);
});

test("rows whose buyability could not be checked cannot be bought", async () => {
  const result = await compareWrappers({ cmc: cmc(), quoter: noDinari(quoter()), symbol: "NVDA" });
  const screen = buildWrapperScreen(result, new Map());
  assert.ok(screen.rows.every((r) => r.buy.kind === "disabled"));
  // The best is still the best; nothing buyable to fall back to.
  assert.deepEqual(screen.rows[0]!.badges, ["best"]);
  assert.ok(!screen.rows.some((r) => r.badges.includes("best_buyable")));
});

test("'most you can buy on DeSpell' never lands on a row the best rule would refuse", async () => {
  const result = await compareWrappers({ cmc: cmc(), quoter: noDinari(quoter()), symbol: "NVDA" });
  const ranked = result.rows.filter((r) => r.receivedValueUsd != null);
  // Row 2 pays 1.8% below the stock, row 3 shows more than was spent; row 4 is fine.
  ranked[1]!.premiumPct = -1.8;
  ranked[2]!.receivedValueUsd = 100.4;
  const buyable = new Map<string, Buyability>(
    ranked.map((r, i) => [rowKey(r.wrapper.chainId, r.wrapper.address, r.wrapper.symbol), i === 0 ? { buyable: false, reason: "not_on_despell" } : { buyable: true }]),
  );
  const screen = buildWrapperScreen(result, buyable);
  const marked = screen.rows.filter((r) => r.badges.includes("best_buyable"));
  assert.equal(marked.length, 1);
  assert.equal(marked[0]!.key, rowKey(ranked[3]!.wrapper.chainId, ranked[3]!.wrapper.address, ranked[3]!.wrapper.symbol));
});
