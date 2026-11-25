// The files DES-699 tapes out and checks with: circuit/pool-judgment.json (the netlist) and
// circuit/pool-judgment-samples.json (sample vectors with the rule's answers). Built here so the build script and the
// tests make the same text.

import { createHash } from "node:crypto";
import { INPUT_COUNT, OUTPUT_COUNT } from "./bits.ts";
import { encodeNetlist, toHex, type Netlist } from "./netlist.ts";
import { samples } from "./samples.ts";
import { RULE_SOURCE } from "./source.ts";

export const ARTIFACT_URL = new URL("../circuit/pool-judgment.json", import.meta.url);
export const SAMPLES_URL = new URL("../circuit/pool-judgment-samples.json", import.meta.url);

export function artifactText(netlist: Netlist): string {
  const bytes = encodeNetlist(netlist);
  const artifact = {
    name: "DeSpell pool judgment",
    ruleVersion: RULE_SOURCE.ruleVersion,
    source: RULE_SOURCE.source,
    nIn: INPUT_COUNT,
    nOut: OUTPUT_COUNT,
    nand: netlist.gates.length,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    netlist: toHex(bytes),
  };
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

/** Sample vectors in the shape the Solidity tape-out script reads: parallel arrays, plus a name for each. */
export function samplesText(): string {
  const list = samples();
  const file = {
    nIn: INPUT_COUNT,
    nOut: OUTPUT_COUNT,
    names: list.map((sample) => sample.name),
    vectors: list.map((sample) => sample.vector),
    inputs: list.map((sample) => sample.inputs),
    outputs: list.map((sample) => sample.output),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}
