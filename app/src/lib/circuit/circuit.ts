import { getAddress, hexToBytes, isAddress, type Address, type Hex } from "viem";
import artifact from "@despell-lab/xlayer/circuit/pool-judgment.json";
import { decodeOutput, encodeInput, INPUT_COUNT, OUTPUT_COUNT } from "@despell-lab/xlayer/src/bits.ts";
import { decodeNetlist, evaluate } from "@despell-lab/xlayer/src/netlist.ts";
import type { Judgment, JudgmentInput } from "@despell-lab/xlayer/src/rule.ts";

/*
  The pool judgment circuit (xlayer/): the netlist committed in this
  repository, and where it is taped out on X Layer. The processor and the
  circuit id exist only after the tape-out (DES-699); until then they are
  null and the app says the circuit is being prepared.
*/

export const X_LAYER = {
  id: 196,
  name: "X Layer",
  /** The RPC xlayer/src/onchain.ts reads, then viem's default for the chain. */
  rpcUrls: ["https://rpc.xlayer.tech", "https://xlayerrpc.okx.com"],
  explorer: "https://www.oklink.com/xlayer",
} as const;

export const CIRCUIT = {
  name: artifact.name,
  ruleVersion: artifact.ruleVersion,
  nIn: artifact.nIn,
  nOut: artifact.nOut,
  nand: artifact.nand,
  bytes: artifact.bytes,
  sha256: artifact.sha256,
  netlistHex: artifact.netlist as Hex,
} as const;

if (CIRCUIT.nIn !== INPUT_COUNT || CIRCUIT.nOut !== OUTPUT_COUNT) {
  throw new Error("The committed netlist does not match the pin layout in xlayer/src/bits.ts");
}

const NETLIST = decodeNetlist(hexToBytes(CIRCUIT.netlistHex), CIRCUIT.nIn, CIRCUIT.nOut);

/** The committed netlist evaluated here, gate by gate, the way `eval` does on chain. */
export function evaluateLocally(input: JudgmentInput): { vector: number; outputs: number; judgment: Judgment } {
  const vector = encodeInput(input);
  const outputs = evaluate(NETLIST, vector);
  return { vector, outputs, judgment: decodeOutput(outputs) };
}

export type CircuitDeployment = { processor: Address; circuitId: bigint };

/**
 * Where the circuit is taped out, from NEXT_PUBLIC_XLAYER_PROCESSOR and NEXT_PUBLIC_XLAYER_CIRCUIT_ID (public values,
 * set once DES-699 has taped it out). null when either is missing or malformed: the circuit is then "being prepared".
 */
export function parseDeployment(processor: string | undefined, circuitId: string | undefined): CircuitDeployment | null {
  const p = processor?.trim();
  const id = circuitId?.trim();
  if (!p || !id || !isAddress(p) || !/^[1-9][0-9]{0,9}$/u.test(id)) return null;
  return { processor: getAddress(p), circuitId: BigInt(id) };
}

// Written out literally so Next.js inlines the values into the browser bundle.
export const DEPLOYMENT: CircuitDeployment | null = parseDeployment(process.env.NEXT_PUBLIC_XLAYER_PROCESSOR, process.env.NEXT_PUBLIC_XLAYER_CIRCUIT_ID);
