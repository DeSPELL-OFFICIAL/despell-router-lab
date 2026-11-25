// Live run against CoinMarketCap and LI.FI.
//
//   CMC_PRO_API_KEY=... node scripts/compare-live.ts NVDA [--spend 100] [--json out.json]
//
// The key is read from the environment only and never printed.

import { writeFileSync } from "node:fs";
import { compareWrappers } from "../src/compare.ts";
import { createCmcClient } from "../src/cmc.ts";
import { formatTable } from "../src/format.ts";
import { createLifiQuoter } from "../src/lifi.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const symbol = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")) ?? "NVDA";
const spendUsd = Number(flag("--spend") ?? 100);
const jsonOut = flag("--json");

const apiKey = process.env.CMC_PRO_API_KEY;
if (!apiKey) {
  console.error("Set CMC_PRO_API_KEY (a CoinMarketCap Pro API key) in the environment.");
  process.exit(1);
}

const result = await compareWrappers({
  cmc: createCmcClient({ apiKey }),
  quoter: createLifiQuoter(),
  symbol,
  spendUsd,
});

console.log(formatTable(result));
if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify(result, null, 2));
  console.log(`\nwrote ${jsonOut}`);
}
