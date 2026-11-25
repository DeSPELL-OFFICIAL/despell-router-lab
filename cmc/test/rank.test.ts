import assert from "node:assert/strict";
import { test } from "node:test";
import type { RouteQuote } from "../src/lifi.ts";
import { rankWrappers, type QuoteOutcome } from "../src/rank.ts";
import type { Wrapper } from "../src/wrappers.ts";

const wrapper = (symbol: string, cmcPriceUsd: number | null, extra: Partial<Wrapper> = {}): Wrapper => ({
  cryptoId: 1,
  symbol,
  name: symbol,
  issuer: `${symbol} issuer`,
  cmcPriceUsd,
  cmcMarketCapUsd: 1_000,
  chainName: "Ethereum",
  chainId: 1,
  chainKind: "evm",
  address: "0x0000000000000000000000000000000000000001",
  ...extra,
});
const quoted = (tokensOut: number, gasUsd: number, extraFeeUsd = 0): QuoteOutcome => ({
  ok: true,
  quote: { tokensOut, gasUsd, extraFeeUsd, feeUsd: 0, tool: "test", source: "lifi" } satisfies RouteQuote,
});
const close = (actual: number | null, expected: number) => {
  assert.ok(actual != null && Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
};
const rank = (wrappers: Wrapper[], outcomes: QuoteOutcome[]) =>
  rankWrappers({ wrappers, outcomes, referencePriceUsd: 100, spendUsd: 100 });

test("premium, route cost and received value follow the documented formulas", () => {
  const [a] = rank([wrapper("A", 101)], [quoted(0.98, 0.5, 0.25)]);
  close(a!.premiumPct, 1);
  close(a!.routeCostUsd, 100 - 0.98 * 101 + 0.5 + 0.25);
  close(a!.receivedValueUsd, 0.98 * 100 - 0.5 - 0.25);
});

test("rows sort by received value; the top ranked row is the only best", () => {
  const rows = rank(
    [
      wrapper("A", 101),
      wrapper("B", 99),
      wrapper("C", 100, { chainName: "Solana", chainId: null, chainKind: "non_evm", cmcMarketCapUsd: 9_999 }),
      wrapper("D", null),
    ],
    [quoted(0.98, 0.5), quoted(0.995, 1), { ok: false, reason: "non_evm_chain" }, quoted(0.9, 0)],
  );

  assert.deepEqual(rows.map((r) => r.wrapper.symbol), ["B", "A", "D", "C"]);
  assert.deepEqual(rows.map((r) => r.best), [true, false, false, false]);
  close(rows[0]!.receivedValueUsd, 98.5);

  const d = rows[2]!;
  assert.equal(d.premiumPct, null);
  assert.equal(d.routeCostUsd, null);
  close(d.receivedValueUsd, 90);

  const c = rows[3]!;
  assert.equal(c.unavailable, "non_evm_chain");
  assert.equal(c.receivedValueUsd, null);
  close(c.premiumPct, 0);
});

test("gas can flip the order between two wrappers", () => {
  const rows = rank([wrapper("MoreTokensHighGas", 100), wrapper("Winner", 100)], [quoted(0.99, 3), quoted(0.98, 0.01)]);
  assert.equal(rows[0]!.wrapper.symbol, "Winner");
});

test("fees charged on top of the spend count against a route", () => {
  // Same tokens and gas; X also charges $2 on top, so Y wins.
  const rows = rank([wrapper("X", 100), wrapper("Y", 100)], [quoted(0.99, 0.1, 2), quoted(0.989, 0.1)]);
  assert.equal(rows[0]!.wrapper.symbol, "Y");
  close(rows[1]!.routeCostUsd, 100 - 99 + 0.1 + 2);
});

test("a quote with wrong decimals is not ranked", () => {
  const rows = rank([wrapper("Bad", 100), wrapper("Ok", 100)], [quoted(990_000, 0.1), quoted(0.98, 0.1)]);
  assert.equal(rows[0]!.wrapper.symbol, "Ok");
  assert.equal(rows[0]!.best, true);
  assert.equal(rows[1]!.unavailable, "implausible_quote");
  assert.equal(rows[1]!.receivedValueUsd, null);
  assert.ok(rows[1]!.quote, "the quote is kept for inspection");
});

test("a wrapper that is not 1 token = 1 share is not ranked", () => {
  // Worth a tenth of a share: $100 buys ~7 tokens. At its own price the quote
  // looks fine, but ranking it at the stock price would claim ~$700.
  const rows = rank([wrapper("Tenth", 10), wrapper("Ok", 100)], [quoted(9.9, 0.1), quoted(0.98, 0.1)]);
  assert.equal(rows[0]!.wrapper.symbol, "Ok");
  assert.equal(rows[1]!.unavailable, "implausible_quote");
  assert.match(rows[1]!.unavailableDetail!, /not 1 token = 1 share/);
});

test("a wrapper without a CMC price is checked against the stock price", () => {
  const rows = rank([wrapper("NoPrice", null)], [quoted(9.9, 0.1)]);
  assert.equal(rows[0]!.unavailable, "implausible_quote");
});

test("no best row when nothing could be ranked", () => {
  const rows = rank(
    [wrapper("A", 100), wrapper("B", 100)],
    [{ ok: false, reason: "quote_failed", detail: "LI.FI HTTP 429" }, { ok: false, reason: "unsupported_chain" }],
  );
  assert.ok(rows.every((r) => !r.best));
  assert.equal(rows.find((r) => r.wrapper.symbol === "A")!.unavailableDetail, "LI.FI HTTP 429");
});

test("bad inputs are refused", () => {
  assert.throws(() => rankWrappers({ wrappers: [wrapper("A", 1)], outcomes: [], referencePriceUsd: 1, spendUsd: 100 }));
  assert.throws(() => rankWrappers({ wrappers: [], outcomes: [], referencePriceUsd: 0, spendUsd: 100 }));
  assert.throws(() => rankWrappers({ wrappers: [], outcomes: [], referencePriceUsd: 1, spendUsd: 0 }));
});
