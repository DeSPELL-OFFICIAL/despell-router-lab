// Replays the router journal's past patrol steps through the pool judgment circuit. Read only, no key.
//
//   node scripts/replay-journal.ts --file <export.json> [--chain [--processor 0x… --id N]] [--out <report.txt>]
//
// <export.json> is the journal in the export shape (src/journal.ts, `JournalExport`). It is made outside this
// repository by whoever can read the journal; nothing here connects to a database.
// Without --chain the committed netlist (circuit/pool-judgment.json) is evaluated here. With --chain every distinct
// input is sent to `eval` on X Layer, after the circuit's info and netlist are read back and found equal to the
// committed ones (the taped-out circuit by default). XLAYER_RPC overrides the public RPC.
// Prints "M of N replayed patrol steps …", every difference and every step that could not be replayed.
// Exits 0 when no replayed step differs, 1 when one does, 2 on bad arguments or input.

import { readFileSync, writeFileSync } from "node:fs";
import { ARTIFACT_URL } from "../src/artifact.ts";
import { INPUT_COUNT, OUTPUT_COUNT } from "../src/bits.ts";
import { parseJournalExport } from "../src/journal.ts";
import { decodeNetlist, evaluate, fromHex, toHex } from "../src/netlist.ts";
import { TAPED_OUT, X_LAYER_CHAIN_ID, X_LAYER_PUBLIC_RPC, XLayerReader } from "../src/onchain.ts";
import { formatReplay, replayJournal, type CircuitJudge } from "../src/replay.ts";

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

const USAGE = "Usage: node scripts/replay-journal.ts --file <export.json> [--chain [--processor 0x… --id N]] [--out <report.txt>]";
const file = arg("file");
const onChain = process.argv.includes("--chain");
const processor = arg("processor") ?? TAPED_OUT.processor;
const idText = arg("id") ?? String(TAPED_OUT.circuitId);
const out = arg("out");
if (!file || !/^0x[0-9a-fA-F]{40}$/u.test(processor) || !/^[0-9]+$/u.test(idText)) {
  console.error(USAGE);
  process.exit(2);
}

let journal;
try {
  journal = parseJournalExport(JSON.parse(readFileSync(file, "utf8")));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const artifact = JSON.parse(readFileSync(ARTIFACT_URL, "utf8")) as { nIn: number; nOut: number; nand: number; netlist: string };
let circuit: CircuitJudge;
let source: string;
if (onChain) {
  const reader = new XLayerReader(process.env.XLAYER_RPC ?? X_LAYER_PUBLIC_RPC);
  const chainId = await reader.chainId();
  if (chainId !== X_LAYER_CHAIN_ID) throw new Error(`RPC is chain ${chainId}, not X Layer (196)`);
  const id = Number(idText);
  const info = await reader.circuitInfo(processor, id);
  const same = toHex(await reader.netlist(processor, id)) === artifact.netlist;
  if (!same || info.nIn !== INPUT_COUNT || info.nOut !== OUTPUT_COUNT || info.nState !== 0 || info.gateCount !== artifact.nand) {
    console.error(`circuit #${id} on ${processor} is not the committed pool judgment circuit; nothing is replayed`);
    process.exit(2);
  }
  circuit = (vector) => reader.evalVector(processor, id, vector, INPUT_COUNT, OUTPUT_COUNT);
  source = `eval on X Layer (chain ${chainId}), processor ${processor}, circuit #${id}`;
} else {
  const netlist = decodeNetlist(fromHex(artifact.netlist), artifact.nIn, artifact.nOut);
  circuit = (vector) => evaluate(netlist, vector);
  source = "the committed netlist, evaluated here (circuit/pool-judgment.json)";
}

const report = await replayJournal(journal, circuit);
const text = `${formatReplay(report)}\ncircuit: ${source}\nexport: ${journal.lines.length} lines, ${journal.pools.length} pools with a card\n`;
process.stdout.write(text);
if (out) writeFileSync(out, text);
process.exit(report.differences.length === 0 ? 0 : 1);
