// Builds the pool judgment circuit from the rules, checks it on every input vector, and writes the netlist that
// DES-699 tapes out: xlayer/circuit/pool-judgment.json.
//
//   node scripts/build-circuit.ts          write the file
//   node scripts/build-circuit.ts --check  fail if the file is missing or differs from a fresh build

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ARTIFACT_URL, artifactText } from "../src/artifact.ts";
import { INPUT_COUNT, OUTPUT_COUNT } from "../src/bits.ts";
import { buildJudgmentCircuit } from "../src/circuit.ts";
import { formatOkb, tapeoutCost } from "../src/cost.ts";
import { compareAll } from "../src/exhaustive-parallel.ts";
import { encodeNetlist } from "../src/netlist.ts";

const OUT_FILE = fileURLToPath(ARTIFACT_URL);

const netlist = buildJudgmentCircuit();
const text = artifactText(netlist);

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(OUT_FILE, "utf8");
  } catch {
    // missing file: reported below
  }
  if (current !== text) {
    console.error("circuit/pool-judgment.json is out of date: run `pnpm build:circuit` in xlayer/");
    process.exit(1);
  }
  console.log(`circuit/pool-judgment.json is up to date (${netlist.gates.length} NAND)`);
  process.exit(0);
}

const result = await compareAll(netlist);
const cost = tapeoutCost(netlist.gates.length);
console.log(`inputs ${INPUT_COUNT}, outputs ${OUTPUT_COUNT}, NAND ${netlist.gates.length}, netlist ${encodeNetlist(netlist).length} bytes`);
console.log(
  `checked ${result.checked.toLocaleString("en-US")} of ${result.combinations.toLocaleString("en-US")} input combinations` +
    ` on ${result.threads} threads in ${result.ms} ms: ${result.mismatches} differ from the rule function`,
);
console.log(
  `tape-out fee ${formatOkb(cost.tapeoutWei)} + ${cost.nands} × 0.0001 = ${formatOkb(cost.feesWei)} OKB` +
    ` (with one mint call's protocol fee ${formatOkb(cost.protocolWei)}: ${formatOkb(cost.totalWei)} OKB)`,
);
if (result.mismatches !== 0) {
  console.error("first difference:", result.first);
  process.exit(1);
}
writeFileSync(OUT_FILE, text);
console.log(`wrote ${OUT_FILE}`);
