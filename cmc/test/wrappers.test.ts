import assert from "node:assert/strict";
import { test } from "node:test";
import { groupWrappers } from "../src/wrappers.ts";
import { cryptoInfoNvda, rwaQuotesNvda } from "./helpers.ts";

const asset = () => rwaQuotesNvda().data!.rwa_assets[0]!;
const info = () => cryptoInfoNvda().data!;

test("NVIDIA tokens expand to one wrapper per token per chain", () => {
  const wrappers = groupWrappers(asset(), info());
  // 9 tokens on CMC; the derivatives index entry has no contract and drops out.
  assert.equal(wrappers.length, 18);
  assert.ok(!wrappers.some((w) => w.issuer === "NA (Derivatives)"));

  const nvdax = wrappers.filter((w) => w.symbol === "NVDAX");
  assert.deepEqual(
    nvdax.map((w) => w.chainName).sort(),
    ["BNB Smart Chain (BEP20)", "Ethereum", "Ink", "Solana", "TON", "X Layer"],
  );
  assert.ok(nvdax.every((w) => w.issuer === "Backed Assets" && w.cmcPriceUsd === nvdax[0]!.cmcPriceUsd));
});

test("chains map to EVM chain ids, and non-EVM chains are flagged", () => {
  const wrappers = groupWrappers(asset(), info());
  const find = (symbol: string, chain: string) => wrappers.find((w) => w.symbol === symbol && w.chainName === chain)!;

  assert.equal(find("NVDAX", "Ethereum").chainId, 1);
  assert.equal(find("NVDAX", "Ethereum").address, "0xc845b2894dbddd03858fd2d643b4ef725fe0849d");
  assert.equal(find("NVDAon", "BNB Smart Chain (BEP20)").chainId, 56);
  assert.equal(find("NVDAc", "Base").chainId, 8453);
  assert.equal(find("NVDAc", "Base").issuer, "Coinbase");

  const solana = find("NVDAX", "Solana");
  assert.equal(solana.evm, false);
  assert.equal(solana.chainId, null);

  const robinhood = find("NVDAon", "Robinhood Chain");
  assert.equal(robinhood.evm, true);
  assert.equal(robinhood.chainId, null);
});

test("a token CMC has no price for keeps a null price", () => {
  const dinari = groupWrappers(asset(), info()).find((w) => w.symbol === "NVDA.D")!;
  assert.equal(dinari.cmcPriceUsd, null);
  assert.equal(dinari.chainId, 42161);
});
