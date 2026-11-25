// Finds the DeSpell processor a wallet made with the TapeOut factory and records its address in a file outside the
// repository, so later runs name it (DESPELL_PROCESSOR) instead of searching. Read only, no key.
//
//   node scripts/find-processor.ts --wallet 0x… --out <file>
//
// If the file already names a processor, that address is checked (made by this wallet, under our name) and kept.
// Otherwise the factory's whole list is searched from the newest. Exit code 3 when the wallet has none yet.
// Prints only the processor address on stdout, so a shell can read it.
// XLAYER_RPC overrides the public RPC.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { X_LAYER_CHAIN_ID, X_LAYER_PUBLIC_RPC, XLayerReader } from "../src/onchain.ts";

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

const wallet = arg("wallet");
const out = arg("out");
if (!wallet || !/^0x[0-9a-fA-F]{40}$/u.test(wallet) || !out) {
  console.error("Usage: node scripts/find-processor.ts --wallet 0x… --out <file>");
  process.exit(2);
}
const reader = new XLayerReader(process.env.XLAYER_RPC ?? X_LAYER_PUBLIC_RPC);
if ((await reader.chainId()) !== X_LAYER_CHAIN_ID) throw new Error("RPC is not X Layer (196)");

if (existsSync(out)) {
  const recorded = (JSON.parse(readFileSync(out, "utf8")) as { processor?: string }).processor ?? "";
  if (!/^0x[0-9a-fA-F]{40}$/u.test(recorded) || !(await reader.isDespellProcessor(recorded, wallet)).ours) {
    console.error(`${out} names ${recorded || "nothing"}, which is not a DeSpell processor made by ${wallet}`);
    process.exit(1);
  }
  console.error(`recorded processor checked: ${recorded}`);
  console.log(recorded);
  process.exit(0);
}

const found = await reader.findDespellProcessor(wallet);
if (found === null) {
  console.error(`no DeSpell processor made by ${wallet} yet`);
  process.exit(3);
}
writeFileSync(out, `${JSON.stringify({ wallet, ...found, recordedAt: new Date().toISOString() }, null, 2)}\n`);
console.error(`found and recorded in ${out}: ${found.processor}`);
console.log(found.processor);
