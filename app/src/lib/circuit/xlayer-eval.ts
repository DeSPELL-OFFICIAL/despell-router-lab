import {
  BaseError,
  bytesToHex,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  createPublicClient,
  fallback,
  hexToBytes,
  http,
  parseAbi,
  type PublicClient,
} from "viem";
import { xLayer } from "viem/chains";
import { decodeOutput, encodeInput, INPUT_COUNT, OUTPUT_COUNT, packPins, unpackPins } from "@despell-lab/xlayer/src/bits.ts";
import type { Judgment, JudgmentInput } from "@despell-lab/xlayer/src/rule.ts";
import { CIRCUIT, X_LAYER, type CircuitDeployment } from "./circuit";

/*
  Asks X Layer for the circuit's judgment: TapeOut's `eval(id, inputs)`, a
  view call on the public RPC (the contract function, not JavaScript eval).
  No key, no transaction, so it runs in the visitor's browser. The same calls
  as xlayer/src/onchain.ts (same selectors), with the bits packed by
  xlayer/src/bits.ts.

  Before the first judgment the configured circuit is read back (`netlist`,
  `circuitInfo`) and compared with the netlist committed here.

  Two kinds of failure are kept apart. When the chain itself answers that the
  circuit is not there or not this one (a revert, an empty answer from an
  address with no code, a different netlist, an output that is not a
  judgment), that is a CircuitRefusedError and the card holds. A transport
  failure (HTTP error, rate limit, timeout) compares nothing and the card is
  not held, by the default to be confirmed in DES-704: the server decides,
  the circuit is a second, public copy.
*/

export const CIRCUIT_ABI = parseAbi([
  "function eval(uint256 id, bytes inputs) view returns (bytes)",
  "function netlist(uint256 id) view returns (bytes)",
  "function circuitInfo(uint256 id) view returns (uint256 nIn, uint256 nOut, uint256 nState, uint256 gateCount)",
]);
/** Kept for the selector test against xlayer/src/onchain.ts. */
export const EVAL_ABI = [CIRCUIT_ABI[0]] as const;

export type CircuitProblem = "not-found" | "wrong-circuit" | "not-a-judgment";

/** X Layer answered, and the answer says this is not the pool judgment circuit (or not a judgment). The card holds. */
export class CircuitRefusedError extends Error {
  readonly problem: CircuitProblem;
  constructor(problem: CircuitProblem, message: string) {
    super(message);
    this.name = "CircuitRefusedError";
    this.problem = problem;
  }
}

/** The chain said no: a revert, or no data (an address with no code). Not a network failure. */
export function chainSaidNo(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  return Boolean(error.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError));
}

async function read<T>(what: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (chainSaidNo(error)) throw new CircuitRefusedError("not-found", `${what} reverted or returned nothing: no such circuit on this processor`);
    throw error;
  }
}

/** Reads the configured circuit back and checks it is the committed netlist. */
export async function verifyCircuit(client: PublicClient, deployment: CircuitDeployment): Promise<void> {
  const target = { address: deployment.processor, abi: CIRCUIT_ABI } as const;
  const [info, netlist] = await Promise.all([
    read("circuitInfo", () => client.readContract({ ...target, functionName: "circuitInfo", args: [deployment.circuitId] })),
    read("netlist", () => client.readContract({ ...target, functionName: "netlist", args: [deployment.circuitId] })),
  ]);
  const [nIn, nOut, nState, gates] = info.map(Number);
  if (nIn !== CIRCUIT.nIn || nOut !== CIRCUIT.nOut || nState !== 0 || gates !== CIRCUIT.nand) {
    throw new CircuitRefusedError("wrong-circuit", `circuit #${deployment.circuitId} has ${nIn} in, ${nOut} out, ${gates} NAND, not this circuit`);
  }
  if (netlist.toLowerCase() !== CIRCUIT.netlistHex.toLowerCase()) {
    throw new CircuitRefusedError("wrong-circuit", `circuit #${deployment.circuitId}'s netlist is not the committed one`);
  }
}

const verified = new Map<string, Promise<void>>();

/**
 * verifyCircuit once per deployment for the page's lifetime. A refusal is kept (the card stays held until reload); a
 * transport failure is forgotten so the next read tries again.
 */
export function verifyOnce(client: PublicClient, deployment: CircuitDeployment): Promise<void> {
  const key = `${deployment.processor}#${deployment.circuitId}`;
  let pending = verified.get(key);
  if (!pending) {
    pending = verifyCircuit(client, deployment).catch((error: unknown) => {
      if (!(error instanceof CircuitRefusedError)) verified.delete(key);
      throw error;
    });
    verified.set(key, pending);
  }
  return pending;
}

export type OnChainJudgment = { vector: number; outputs: number; judgment: Judgment; block: bigint };

export async function judgeOnXLayer(client: PublicClient, deployment: CircuitDeployment, input: JudgmentInput): Promise<OnChainJudgment> {
  const vector = encodeInput(input);
  // At "latest", as xlayer/src/onchain.ts does: pinning a block read in a separate call can land on a node behind it.
  const result = await read("eval", () =>
    client.readContract({
      address: deployment.processor,
      abi: CIRCUIT_ABI,
      functionName: "eval",
      args: [deployment.circuitId, bytesToHex(packPins(vector, INPUT_COUNT))],
    }),
  );
  const block = await client.getBlockNumber({ cacheTime: 0 });
  const outputs = unpackPins(hexToBytes(result), OUTPUT_COUNT);
  let judgment: Judgment;
  try {
    judgment = decodeOutput(outputs);
  } catch {
    throw new CircuitRefusedError("not-a-judgment", `the circuit answered 0x${outputs.toString(16)}, which is not a judgment`);
  }
  return { vector, outputs, judgment, block };
}

/** The circuit check's read: the configured circuit verified once, then its judgment of `input`. */
export async function verifiedJudgment(client: PublicClient, deployment: CircuitDeployment, input: JudgmentInput): Promise<OnChainJudgment> {
  await verifyOnce(client, deployment);
  return judgeOnXLayer(client, deployment, input);
}

let client: PublicClient | null = null;

/** One X Layer client for the page, over the public RPCs. */
export function xLayerClient(): PublicClient {
  client ??= createPublicClient({ chain: xLayer, transport: fallback(X_LAYER.rpcUrls.map((url) => http(url))) }) as PublicClient;
  return client;
}
