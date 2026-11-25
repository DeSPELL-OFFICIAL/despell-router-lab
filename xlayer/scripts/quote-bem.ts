// Fetches a LI.FI quote for OKB -> BEM on X Layer and writes contracts/quote/bem-swap.json for the tape-out script
// (`forge script ... --sig "swapForBem()"`). Sends nothing: a quote is a read.
//
//   node scripts/quote-bem.ts --wallet 0x... [--bem 12000000]   (BEM in 1e-8 units; default 0.12 BEM)
//
// The quote is checked before it is written, and the script checks it again before it sends the swap:
// same chain, OKB in, BEM out, the wallet pays and receives, the LI.FI Diamond is the contract called, the minimum
// received covers what the tape-out needs, and no more than 0.025 OKB goes in. LIFI_API_KEY is sent if set.

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const X_LAYER = 196;
const OKB = "0x0000000000000000000000000000000000000000";
const BEM = "0x60e62efa9405d6873c5deabd4e6cc91c25363952";
const LIFI_DIAMOND = "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae";
/** What a fresh wallet needs: 0.1 BEM deploy fee + 157 NAND at 1e-8 + 0.01 BEM mint fee. */
const BEM_NEEDED = 11_000_157n;
const MAX_OKB_IN = 25_000_000_000_000_000n;
const OUT_FILE = fileURLToPath(new URL("../contracts/quote/bem-swap.json", import.meta.url));

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

function fail(message: string): never {
  console.error(`quote-bem: ${message}`);
  process.exit(1);
}

const wallet = arg("wallet")?.toLowerCase();
if (!wallet || !/^0x[0-9a-f]{40}$/u.test(wallet)) fail("--wallet 0x… is required");
const bemOut = BigInt(arg("bem") ?? "12000000");
if (bemOut < BEM_NEEDED) fail(`--bem must be at least ${BEM_NEEDED}`);

const url = new URL("https://li.quest/v1/quote/toAmount");
for (const [key, value] of Object.entries({
  fromChain: String(X_LAYER),
  toChain: String(X_LAYER),
  fromToken: OKB,
  toToken: BEM,
  toAmount: bemOut.toString(),
  fromAddress: wallet,
  toAddress: wallet,
  slippage: "0.03",
})) {
  url.searchParams.set(key, value);
}
const headers: Record<string, string> = { accept: "application/json" };
if (process.env.LIFI_API_KEY) headers["x-lifi-api-key"] = process.env.LIFI_API_KEY;

const response = await fetch(url, { headers });
const quote = (await response.json()) as {
  message?: string;
  tool?: string;
  action?: { fromChainId: number; toChainId: number; fromToken: { address: string }; toToken: { address: string }; fromAddress?: string; toAddress?: string };
  estimate?: { fromAmount: string; toAmount: string; toAmountMin: string; fromAmountUSD?: string; toAmountUSD?: string };
  transactionRequest?: { to: string; from?: string; data: string; value: string; chainId: number };
};
if (!response.ok || !quote.action || !quote.estimate || !quote.transactionRequest) {
  fail(`LI.FI answered HTTP ${response.status}: ${quote.message ?? "no quote"}`);
}
const { action, estimate, transactionRequest: tx } = quote;
const lower = (value: string | undefined) => (value ?? "").toLowerCase();
const value = BigInt(tx.value);
const minOut = BigInt(estimate.toAmountMin);

if (action.fromChainId !== X_LAYER || action.toChainId !== X_LAYER || tx.chainId !== X_LAYER) fail("quote is not on X Layer");
if (lower(action.fromToken.address) !== OKB) fail("quote does not spend OKB");
if (lower(action.toToken.address) !== BEM) fail("quote does not buy BEM");
if (lower(action.fromAddress) !== wallet || lower(tx.from) !== wallet) fail("quote is for another wallet");
if (lower(action.toAddress) !== wallet) fail("quote pays another address");
if (lower(tx.to) !== LIFI_DIAMOND) fail(`quote calls ${tx.to}, not the LI.FI Diamond`);
if (minOut < BEM_NEEDED) fail(`minimum received ${minOut} is below the ${BEM_NEEDED} the tape-out needs`);
if (value > MAX_OKB_IN) fail(`quote spends ${value} wei of OKB, over ${MAX_OKB_IN}`);

const file = {
  chainId: X_LAYER,
  tool: quote.tool ?? null,
  to: tx.to,
  data: tx.data,
  value: value.toString(),
  fromAddress: wallet,
  toAddress: wallet,
  toToken: BEM,
  toAmount: estimate.toAmount,
  toAmountMin: estimate.toAmountMin,
  fromAmountUSD: estimate.fromAmountUSD ?? null,
  toAmountUSD: estimate.toAmountUSD ?? null,
  fetchedAt: Math.floor(Date.now() / 1000),
};
mkdirSync(new URL("../contracts/quote/", import.meta.url), { recursive: true });
writeFileSync(OUT_FILE, `${JSON.stringify(file, null, 2)}\n`);
console.log(
  `quote via ${file.tool}: ${Number(value) / 1e18} OKB in (≈ $${file.fromAmountUSD}) for at least ${Number(minOut) / 1e8} BEM` +
    ` (≈ $${file.toAmountUSD}); written to contracts/quote/bem-swap.json, good for 5 minutes`,
);
