import assert from "node:assert/strict";
import { test } from "node:test";
import type { RouteQuote } from "../src/lifi.ts";
import { rankWrappers, type QuoteOutcome, type RankInput } from "../src/rank.ts";
import type { Wrapper } from "../src/wrappers.ts";

const wrapper = (symbol: string, cmcPriceUsd: number | null, extra: Partial<Wrapper> = {}): Wrapper => ({
  cryptoId: 1,
  symbol,
  name: symbol,
  issuer: `${symbol} issuer`,
  cmcPriceUsd,
  cmcMarketCapUsd: 1_000,
  cmcVolume24hUsd: 100,
  listing: "deployed",
  chainName: "Ethereum",
  chainId: 1,
  chainKind: "evm",
  address: "0x0000000000000000000000000000000000000001",
  ...extra,
});
const quoted = (tokensOut: number, gasUsd: number, extraFeeUsd = 0, feeUsd = 0): QuoteOutcome => ({
  ok: true,
  quote: { tokensOut, gasUsd, extraFeeUsd, feeUsd, tool: "test", source: "lifi" } satisfies RouteQuote,
});
const close = (actual: number | null | undefined, expected: number) => {
  assert.ok(actual != null && Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
};
// Reference $100 and spend $100 throughout, so one token = one share = $100.
const rank = (wrappers: Wrapper[], outcomes: QuoteOutcome[], opts: Partial<RankInput> = {}) =>
  rankWrappers({ wrappers, outcomes, referencePriceUsd: 100, spendUsd: 100, ...opts });
const symbols = (rows: { wrapper: Wrapper }[]) => rows.map((r) => r.wrapper.symbol);

test("received value splits into known cost and price gap, at the execution price", () => {
  const { rows } = rank([wrapper("A", 104)], [quoted(0.985, 0.5, 0.25, 0.25)]);
  const a = rows[0]!;
  const exec = (100 - 0.25) / 0.985;
  close(a.execPriceUsd, exec);
  close(a.premiumPct, (exec / 100 - 1) * 100);
  close(a.cmcPremiumPct, 4); // CMC price is informational only
  close(a.receivedValueUsd, 98.5 - 0.75);
  close(a.shortfallUsd, 2.25);
  close(a.knownCostUsd, 1);
  close(a.priceGapUsd, 1.25);
  close(a.knownCostUsd! + a.priceGapUsd!, a.shortfallUsd!);
});

test("rows sort by received value; unranked rows go last", () => {
  const { rows, incomplete } = rank(
    [
      wrapper("A", 101),
      wrapper("B", 99),
      wrapper("C", 100, { chainName: "Solana", chainId: null, chainKind: "non_evm", cmcMarketCapUsd: 9_999 }),
      wrapper("D", null),
    ],
    [quoted(0.98, 0.5), quoted(0.995, 1), { ok: false, reason: "non_evm_chain" }, quoted(0.99, 0)],
  );
  assert.equal(incomplete, 0);
  assert.deepEqual(symbols(rows), ["D", "B", "A", "C"]);
  assert.deepEqual(rows.map((r) => r.best), [true, false, false, false]);
  assert.equal(rows[3]!.unavailable, "non_evm_chain");
  assert.equal(rows[3]!.shortfallUsd, null);
  // shortfall is always in ranking order
  const shorts = rows.slice(0, 3).map((r) => r.shortfallUsd!);
  assert.deepEqual([...shorts].sort((x, y) => x - y), shorts);
});

test("a wrapper trading below the stock cannot win by its discount (review repro)", () => {
  // -15%: $100 buys 1.17 tokens. Before the fix this showed "receives $117" and won.
  const deep = rank([wrapper("Discount15", 85), wrapper("Normal", 100)], [quoted(1.17, 0.1), quoted(0.99, 0.1)]);
  assert.deepEqual(symbols(deep.rows), ["Normal", "Discount15"]);
  assert.equal(deep.rows[0]!.best, true);
  assert.equal(deep.rows[1]!.unavailable, "premium_out_of_band");
  assert.equal(deep.rows[1]!.receivedValueUsd, null);

  // -5% with a wider band: ranked first by value, but never best.
  const wide = rank([wrapper("Discount5", 95), wrapper("Normal", 100)], [quoted(1.05, 0.1), quoted(0.99, 0.1)], { maxPremiumPct: 5 });
  assert.deepEqual(symbols(wide.rows), ["Discount5", "Normal"]);
  assert.equal(wide.rows[0]!.best, false);
  assert.equal(wide.rows[0]!.bestBlocked, "receives_more_than_spent");
  assert.equal(wide.rows[1]!.best, true);
});

test("the premium band defaults to 3% and can be narrowed", () => {
  // Pays +2.56% over the stock.
  const outcomes = [quoted(0.975, 0.1)];
  assert.equal(rank([wrapper("A", 100)], outcomes).rows[0]!.unavailable, null);
  assert.equal(rank([wrapper("A", 100)], outcomes, { maxPremiumPct: 2 }).rows[0]!.unavailable, "premium_out_of_band");
});

test("a quote with wrong decimals falls outside the band", () => {
  const { rows } = rank([wrapper("Bad", 100), wrapper("Ok", 100)], [quoted(990_000, 0.1), quoted(0.98, 0.1)]);
  assert.deepEqual(symbols(rows), ["Ok", "Bad"]);
  assert.equal(rows[1]!.unavailable, "premium_out_of_band");
  assert.ok(rows[1]!.quote, "the quote is kept for inspection");
});

test("gas and fees charged on top count against a route", () => {
  const gas = rank([wrapper("MoreTokensHighGas", 100), wrapper("Winner", 100)], [quoted(0.99, 3), quoted(0.98, 0.01)]);
  assert.equal(gas.rows[0]!.wrapper.symbol, "Winner");
  const fee = rank([wrapper("X", 100), wrapper("Y", 100)], [quoted(0.99, 0.1, 2), quoted(0.989, 0.1)]);
  assert.equal(fee.rows[0]!.wrapper.symbol, "Y");
  close(fee.rows[1]!.knownCostUsd, 2.1);
});

test("a failed or incomplete quote makes the ranking incomplete: no best", () => {
  const { rows, incomplete } = rank(
    [wrapper("A", 100), wrapper("B", 100), wrapper("C", 100)],
    [quoted(0.99, 0.1), { ok: false, reason: "quote_failed", detail: "LI.FI HTTP 429" }, { ok: false, reason: "quote_incomplete" }],
  );
  assert.equal(incomplete, 2);
  assert.ok(rows.every((r) => !r.best));
  assert.equal(rows[0]!.wrapper.symbol, "A");
  assert.equal(rows[0]!.bestBlocked, "ranking_incomplete");

  // Rows that simply have no route do not make it incomplete.
  const ok = rank([wrapper("A", 100), wrapper("B", 100)], [quoted(0.99, 0.1), { ok: false, reason: "no_route" }]);
  assert.equal(ok.incomplete, 0);
  assert.equal(ok.rows[0]!.best, true);
});

test("rows within $0.05 of the best are marked tied", () => {
  const { rows } = rank(
    [wrapper("Best", 100), wrapper("Close", 100), wrapper("Far", 100)],
    [quoted(0.99, 0), quoted(0.9897, 0), quoted(0.989, 0)],
  );
  assert.deepEqual(symbols(rows), ["Best", "Close", "Far"]);
  assert.deepEqual(rows.map((r) => [r.best, r.tiedWithBest]), [[true, false], [false, true], [false, false]]);
});

test("bad inputs are refused", () => {
  assert.throws(() => rank([wrapper("A", 1)], []));
  assert.throws(() => rankWrappers({ wrappers: [], outcomes: [], referencePriceUsd: 0, spendUsd: 100 }));
  assert.throws(() => rankWrappers({ wrappers: [], outcomes: [], referencePriceUsd: 1, spendUsd: 0 }));
  assert.throws(() => rank([], [], { maxPremiumPct: 0 }));
  assert.throws(() => rank([], [], { maxPremiumPct: 50 }));
  assert.throws(() => rank([], [], { tieUsd: -1 }));
});
