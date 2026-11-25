// Checks the taped-out pool judgment circuit on X Layer mainnet against the rule function. Read only, no key.
//
//   node scripts/check-tapeout.ts --processor 0x… [--id N]
//
// Without --id the circuit is found on the processor by its netlist.
// Reads circuitInfo and the netlist back and compares them with circuit/pool-judgment.json, then asks the chain's
// `eval` for every sample in circuit/pool-judgment-samples.json and compares each answer with the rule function.
// Prints one line per sample (name, input vector, chain, rule) and fails on any difference.
// XLAYER_RPC overrides the public RPC.

import { readFileSync } from "node:fs";
import { ARTIFACT_URL, SAMPLES_URL } from "../src/artifact.ts";
import { decodeInput, decodeOutput, INPUT_COUNT, OUTPUT_COUNT } from "../src/bits.ts";
import { fromHex, toHex } from "../src/netlist.ts";
import { judgeOnChain, X_LAYER_CHAIN_ID, X_LAYER_PUBLIC_RPC, XLayerReader } from "../src/onchain.ts";
import { judge } from "../src/rule.ts";

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

const processor = arg("processor");
const idText = arg("id");
if (!processor || !/^0x[0-9a-fA-F]{40}$/u.test(processor) || (idText !== undefined && !/^[0-9]+$/u.test(idText))) {
  console.error("Usage: node scripts/check-tapeout.ts --processor 0x… [--id N]");
  process.exit(2);
}
const artifact = JSON.parse(readFileSync(ARTIFACT_URL, "utf8")) as { netlist: string; nand: number };
const samples = JSON.parse(readFileSync(SAMPLES_URL, "utf8")) as { names: string[]; vectors: number[]; outputs: number[] };
const reader = new XLayerReader(process.env.XLAYER_RPC ?? X_LAYER_PUBLIC_RPC);

const chainId = await reader.chainId();
if (chainId !== X_LAYER_CHAIN_ID) throw new Error(`RPC is chain ${chainId}, not X Layer (196)`);
const id = idText !== undefined ? Number(idText) : await reader.findCircuit(processor, fromHex(artifact.netlist));
if (id === null) {
  console.error(`the pool judgment netlist is not on processor ${processor}`);
  process.exit(1);
}
const info = await reader.circuitInfo(processor, id);
const netlistSame = toHex(await reader.netlist(processor, id)) === artifact.netlist;
console.log(`processor ${processor}, circuit #${id}: ${info.nIn} in, ${info.nOut} out, ${info.gateCount} NAND, state ${info.nState}`);
console.log(`netlist on chain = circuit/pool-judgment.json: ${netlistSame ? "yes" : "NO"}`);
if (!netlistSame || info.nIn !== INPUT_COUNT || info.nOut !== OUTPUT_COUNT || info.nState !== 0 || info.gateCount !== artifact.nand) {
  console.error("this is not the pool judgment circuit: its info or netlist differs, so its answers are not compared");
  process.exit(1);
}
let ok = true;

let same = 0;
for (let i = 0; i < samples.vectors.length; i++) {
  const input = decodeInput(samples.vectors[i]!);
  const chain = await judgeOnChain(reader, processor, id, input);
  const rule = judge(input);
  const recorded = decodeOutput(samples.outputs[i]!);
  const match = chain.stage === rule.stage && chain.lane === rule.lane && rule.stage === recorded.stage && rule.lane === recorded.lane;
  if (match) same += 1;
  else ok = false;
  console.log(
    `${match ? "=" : "≠"} ${String(i + 1).padStart(2)} ${samples.names[i]!.padEnd(48)} vector ${String(samples.vectors[i]).padStart(9)}` +
      `  chain ${chain.stage}/${chain.lane}  rule ${rule.stage}/${rule.lane}`,
  );
}
console.log(`eval on X Layer = rule function on ${same}/${samples.vectors.length} samples`);
if (!ok) process.exitCode = 1;
