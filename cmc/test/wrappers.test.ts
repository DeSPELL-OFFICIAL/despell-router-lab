import assert from "node:assert/strict";
import { test } from "node:test";
import { groupWrappers } from "../src/wrappers.ts";
import { cryptoInfoNvda, rwaQuotesNvda } from "./helpers.ts";

const asset = () => rwaQuotesNvda().data!.rwa_assets[0]!;
const info = () => cryptoInfoNvda().data!;

test("NVIDIA tokens expand to one wrapper per token per chain", () => {
  const wrappers = groupWrappers(asset(), info());
  // 9 tokens on CMC: 18 deployments, plus the derivatives index entry, which
  // has no contract and stays as one row saying so.
  assert.equal(wrappers.length, 19);
  const derivatives = wrappers.filter((w) => w.issuer === "NA (Derivatives)");
  assert.equal(derivatives.length, 1);
  assert.equal(derivatives[0]!.listing, "no_contract");
  assert.equal(derivatives[0]!.chainName, null);
  assert.equal(wrappers.filter((w) => w.listing === "deployed").length, 18);

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
  assert.equal(solana.chainKind, "non_evm");
  assert.equal(solana.chainId, null);

  const robinhood = find("NVDAon", "Robinhood Chain");
  assert.equal(robinhood.chainKind, "evm");
  assert.equal(robinhood.chainId, null);
});

test("a token CMC has no price for keeps a null price", () => {
  const dinari = groupWrappers(asset(), info()).find((w) => w.symbol === "NVDA.D")!;
  assert.equal(dinari.cmcPriceUsd, null);
  assert.equal(dinari.chainId, 42161);
});

test("a chain name CMC uses that is not in the table is unknown, not non-EVM", () => {
  const info = cryptoInfoNvda().data!;
  info["42461"]!.contract_address![0]!.platform.name = "Some New L2";
  const w = groupWrappers(asset(), info).find((x) => x.symbol === "NVDAc")!;
  assert.equal(w.chainKind, "unknown");
  assert.equal(w.chainId, null);
});

test("a token missing from crypto info is kept as a row, not dropped", () => {
  const partial = info();
  delete partial["42461"]; // NVDAc
  const rows = groupWrappers(asset(), partial).filter((w) => w.symbol === "NVDAc");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.listing, "no_info");
  assert.equal(rows[0]!.address, null);
  assert.equal(rows[0]!.issuer, "Coinbase");
});

test("an asset without a tokens array gives no wrappers", () => {
  const a = asset();
  delete a.tokens;
  assert.deepEqual(groupWrappers(a, info()), []);
});
