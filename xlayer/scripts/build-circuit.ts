// Builds the pool judgment circuit from the rules, checks it on every input vector, and writes the netlist that
// DES-699 tapes out (xlayer/circuit/pool-judgment.json) and the sample vectors it checks eval with
// (xlayer/circuit/pool-judgment-samples.json).
//
//   node scripts/build-circuit.ts          write the file
//   node scripts/build-circuit.ts --check  fail if a file is missing or differs from a fresh build

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ARTIFACT_URL, artifactText, SAMPLES_URL, samplesText } from "../src/artifact.ts";
import { INPUT_COUNT, OUTPUT_COUNT } from "../src/bits.ts";
import { buildJudgmentCircuit } from "../src/circuit.ts";
import { formatOkb, tapeoutCost } from "../src/cost.ts";
import { compareAll } from "../src/exhaustive-parallel.ts";
import { encodeNetlist } from "../src/netlist.ts";

const OUT_FILE = fileURLToPath(ARTIFACT_URL);
const SAMPLES_FILE = fileURLToPath(SAMPLES_URL);

const netlist = buildJudgmentCircuit();
const text = artifactText(netlist);
const samples = samplesText();

if (process.argv.includes("--check")) {
  const read = (file: string) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return ""; // missing file: reported below
    }
  };
  if (read(OUT_FILE) !== text || read(SAMPLES_FILE) !== samples) {
    console.error("circuit/ is out of date: run `pnpm build:circuit` in xlayer/");
    process.exit(1);
  }
  console.log(`circuit/ is up to date (${netlist.gates.length} NAND)`);
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
writeFileSync(SAMPLES_FILE, samples);
console.log(`wrote ${OUT_FILE} and ${SAMPLES_FILE}`);
