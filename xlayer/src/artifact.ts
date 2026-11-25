// The file DES-699 tapes out: circuit/pool-judgment.json. Built here so the build script and the tests make the
// same text.

import { createHash } from "node:crypto";
import { INPUT_COUNT, OUTPUT_COUNT } from "./bits.ts";
import { encodeNetlist, toHex, type Netlist } from "./netlist.ts";
import { RULE_SOURCE } from "./source.ts";

export const ARTIFACT_URL = new URL("../circuit/pool-judgment.json", import.meta.url);

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
