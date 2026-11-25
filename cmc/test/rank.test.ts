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
  evm: true,
  address: "0x0000000000000000000000000000000000000001",
  ...extra,
});
const quoted = (tokensOut: number, gasUsd: number): QuoteOutcome => ({
  ok: true,
  quote: { tokensOut, gasUsd, feeUsd: 0, tool: "test", source: "lifi" } satisfies RouteQuote,
});
const close = (actual: number | null, expected: number) => {
  assert.ok(actual != null && Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
};

test("premium, route cost and received value follow the documented formulas", () => {
  const rows = rankWrappers({
    wrappers: [wrapper("A", 101)],
    outcomes: [quoted(0.98, 0.5)],
    referencePriceUsd: 100,
    spendUsd: 100,
  });
  const a = rows[0]!;
  close(a.premiumPct, 1);
  close(a.routeCostUsd, 100 - 0.98 * 101 + 0.5);
  close(a.receivedValueUsd, 0.98 * 100 - 0.5);
});

test("rows sort by received value; the top quoted row is the only best", () => {
  const rows = rankWrappers({
    wrappers: [
      wrapper("A", 101),
      wrapper("B", 99),
      wrapper("C", 100, { chainName: "Solana", chainId: null, evm: false, cmcMarketCapUsd: 9_999 }),
      wrapper("D", null),
    ],
    outcomes: [
      quoted(0.98, 0.5),
      quoted(0.995, 1),
      { ok: false, reason: "non_evm_chain" },
      quoted(0.9, 0),
    ],
    referencePriceUsd: 100,
    spendUsd: 100,
  });

  assert.deepEqual(rows.map((r) => r.wrapper.symbol), ["B", "A", "D", "C"]);
  assert.deepEqual(rows.map((r) => r.best), [true, false, false, false]);
  close(rows[0]!.receivedValueUsd, 98.5);

  // A cheaper-looking wrapper can still lose once gas and route cost are in.
  assert.ok(rows[1]!.premiumPct! > rows[0]!.premiumPct!);

  const d = rows[2]!;
  assert.equal(d.premiumPct, null);
  assert.equal(d.routeCostUsd, null);
  close(d.receivedValueUsd, 90);

  const c = rows[3]!;
  assert.equal(c.unavailable, "non_evm_chain");
  assert.equal(c.receivedValueUsd, null);
  close(c.premiumPct, 0);
});

test("gas can flip the order between two wrappers that receive the same tokens", () => {
  const rows = rankWrappers({
    wrappers: [wrapper("CheapGasLoser", 100), wrapper("Winner", 100)],
    outcomes: [quoted(0.99, 3), quoted(0.98, 0.01)],
    referencePriceUsd: 100,
    spendUsd: 100,
  });
  assert.equal(rows[0]!.wrapper.symbol, "Winner");
});

test("no best row when nothing could be quoted", () => {
  const rows = rankWrappers({
    wrappers: [wrapper("A", 100), wrapper("B", 100)],
    outcomes: [{ ok: false, reason: "no_route" }, { ok: false, reason: "unsupported_chain" }],
    referencePriceUsd: 100,
    spendUsd: 100,
  });
  assert.ok(rows.every((r) => !r.best));
});

test("bad inputs are refused", () => {
  assert.throws(() => rankWrappers({ wrappers: [wrapper("A", 1)], outcomes: [], referencePriceUsd: 1, spendUsd: 100 }));
  assert.throws(() => rankWrappers({ wrappers: [], outcomes: [], referencePriceUsd: 0, spendUsd: 100 }));
});
