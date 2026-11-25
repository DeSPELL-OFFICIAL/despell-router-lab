// Reading a TapeOut processor on X Layer: `eval`, `netlist`, `circuitInfo` and the fee views, over plain JSON-RPC
// `eth_call`. No key and no transaction. The app server and the check scripts use this to ask the chain for the
// circuit's judgment (`judgeOnChain`) and compare it with the rule function.

import { decodeOutput, encodeInput, INPUT_COUNT, OUTPUT_COUNT, packPins, unpackPins } from "./bits.ts";
import { fromHex } from "./netlist.ts";
import type { Judgment, JudgmentInput } from "./rule.ts";

export const X_LAYER_CHAIN_ID = 196;
export const X_LAYER_PUBLIC_RPC = "https://rpc.xlayer.tech";

/** Function selectors: the first 4 bytes of keccak256 of each signature. */
export const SELECTOR = {
  eval: "934d06ea", // eval(uint256,bytes)
  netlist: "3fc4be56", // netlist(uint256)
  circuitInfo: "084d60f1", // circuitInfo(uint256)
  tapeoutFee: "adfb2b69", // TAPEOUT_FEE()
  transistors: "6fbd1719", // transistors()
  mintPrice: "6817c76c", // mintPrice()
  protocolFee: "b0e21e8a", // protocolFee()
  supplyCap: "8f770ad0", // supplyCap()
  minted: "4f02c420", // minted()
  nextId: "61b8ce8c", // nextId()
  name: "06fdde03", // name()
  cpuCount: "a94da8a7", // cpuCount() on the factory
  cpus: "d2c26963", // cpus(uint256) on the factory
  creator: "02d05d3f", // creator() on a transistor contract
  circuits: "5f48772d", // circuits() on a transistor contract
} as const;

/** TapeOut CPU factory on X Layer mainnet. */
export const TAPEOUT_FACTORY = "0x1f09DAeFA827f02CBb40967cc91b259763760761";
/** The name the tape-out script gives the DeSpell processor. */
export const DESPELL_PROCESSOR_NAME = "DeSpell Pool Judgment";

export type CircuitInfo = { readonly nIn: number; readonly nOut: number; readonly nState: number; readonly gateCount: number };

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;

export function word(value: bigint | number): string {
  const big = BigInt(value);
  if (big < 0n) throw new RangeError("ABI words here are unsigned");
  return big.toString(16).padStart(64, "0");
}

/**
 * ABI encoding of a `bytes` argument that is the last argument: its offset slot, then the tail (length, padded data).
 * `headWords` is the number of head slots of the whole call, the offset slot included (2 for `eval(uint256,bytes)`),
 * so the tail starts right after the head. The caller writes the other head slots first.
 */
export function encodeBytesArgument(bytes: Uint8Array, headWords: number): string {
  const hex = Buffer.from(bytes).toString("hex");
  return word(headWords * 32) + word(bytes.length) + hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
}

/** ABI decoding of a single returned `bytes`. */
export function decodeBytesResult(hex: string): Uint8Array {
  const body = hex.replace(/^0x/u, "");
  const offset = Number(BigInt(`0x${body.slice(0, 64)}`)) * 2;
  const length = Number(BigInt(`0x${body.slice(offset, offset + 64)}`));
  const data = body.slice(offset + 64, offset + 64 + length * 2);
  if (data.length !== length * 2) throw new RangeError("returned bytes are cut short");
  return fromHex(data);
}

/** The n-th 32-byte word of a returned value, as an unsigned integer. */
export function wordAt(hex: string, index: number): bigint {
  const body = hex.replace(/^0x/u, "");
  const slice = body.slice(index * 64, (index + 1) * 64);
  if (slice.length !== 64) throw new RangeError(`no word ${index} in the result`);
  return BigInt(`0x${slice}`);
}

export class XLayerReader {
  private requestId = 0;
  private readonly rpcUrl: string;
  private readonly fetchFn: Fetch;

  constructor(rpcUrl: string = X_LAYER_PUBLIC_RPC, fetchFn: Fetch = fetch as unknown as Fetch) {
    this.rpcUrl = rpcUrl;
    this.fetchFn = fetchFn;
  }

  async rpc(method: string, params: unknown[]): Promise<string> {
    const response = await this.fetchFn(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.requestId, method, params }),
    });
    if (!response.ok) throw new Error(`${method}: RPC answered HTTP ${response.status}`);
    const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error || typeof body.result !== "string") throw new Error(`${method}: ${body.error?.message ?? "no result"}`);
    return body.result;
  }

  async call(to: string, data: string): Promise<string> {
    if (!ADDRESS.test(to)) throw new RangeError(`not an address: ${to}`);
    return this.rpc("eth_call", [{ to, data: `0x${data}` }, "latest"]);
  }

  async chainId(): Promise<number> {
    return Number(BigInt(await this.rpc("eth_chainId", [])));
  }

  async circuitInfo(processor: string, id: number | bigint): Promise<CircuitInfo> {
    const hex = await this.call(processor, SELECTOR.circuitInfo + word(id));
    const [nIn, nOut, nState, gateCount] = [0, 1, 2, 3].map((index) => Number(wordAt(hex, index)));
    return { nIn: nIn!, nOut: nOut!, nState: nState!, gateCount: gateCount! };
  }

  async netlist(processor: string, id: number | bigint): Promise<Uint8Array> {
    return decodeBytesResult(await this.call(processor, SELECTOR.netlist + word(id)));
  }

  /** `eval(id, inputs)`: the packed output bytes. */
  async evalBytes(processor: string, id: number | bigint, inputs: Uint8Array): Promise<Uint8Array> {
    return decodeBytesResult(await this.call(processor, SELECTOR.eval + word(id) + encodeBytesArgument(inputs, 2)));
  }

  /** `eval` for one input vector of `nIn` pins: the output vector of `nOut` pins. */
  async evalVector(processor: string, id: number | bigint, vector: number, nIn: number, nOut: number): Promise<number> {
    return unpackPins(await this.evalBytes(processor, id, packPins(vector, nIn)), nOut);
  }

  async uintView(contract: string, selector: string): Promise<bigint> {
    return wordAt(await this.call(contract, selector), 0);
  }

  async addressView(contract: string, selector: string): Promise<string> {
    return `0x${(await this.call(contract, selector)).slice(-40)}`;
  }

  async stringView(contract: string, selector: string): Promise<string> {
    return Buffer.from(decodeBytesResult(await this.call(contract, selector))).toString("utf8");
  }

  /** Is `processor` a DeSpell processor that `wallet` made with the factory? */
  async isDespellProcessor(processor: string, wallet: string): Promise<{ readonly ours: boolean; readonly transistors: string }> {
    const transistors = await this.addressView(processor, SELECTOR.transistors);
    const [creator, circuits, name] = await Promise.all([
      this.addressView(transistors, SELECTOR.creator),
      this.addressView(transistors, SELECTOR.circuits),
      this.stringView(processor, SELECTOR.name),
    ]);
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    return { ours: same(creator, wallet) && same(circuits, processor) && name === DESPELL_PROCESSOR_NAME, transistors };
  }

  /** The newest DeSpell processor `wallet` made, searching the factory's whole list from the end; null if none. */
  async findDespellProcessor(wallet: string): Promise<{ readonly processor: string; readonly transistors: string } | null> {
    const count = await this.uintView(TAPEOUT_FACTORY, SELECTOR.cpuCount);
    for (let i = count; i > 0n; i--) {
      const processor = await this.addressView(TAPEOUT_FACTORY, SELECTOR.cpus + word(i - 1n));
      const { ours, transistors } = await this.isDespellProcessor(processor, wallet).catch(() => ({ ours: false, transistors: "" }));
      if (ours) return { processor, transistors };
    }
    return null;
  }

  /** The id of `netlist` on `processor` (ids 1 … nextId()), or null. */
  async findCircuit(processor: string, netlist: Uint8Array): Promise<number | null> {
    const last = Number(await this.uintView(processor, SELECTOR.nextId));
    const wanted = Buffer.from(netlist).toString("hex");
    for (let id = 1; id <= last; id++) {
      const stored = await this.netlist(processor, id).catch(() => null);
      if (stored && Buffer.from(stored).toString("hex") === wanted) return id;
    }
    return null;
  }
}

/** The pool judgment circuit's answer for one input, read from the chain. */
export async function judgeOnChain(reader: XLayerReader, processor: string, id: number | bigint, input: JudgmentInput): Promise<Judgment> {
  return decodeOutput(await reader.evalVector(processor, id, encodeInput(input), INPUT_COUNT, OUTPUT_COUNT));
}
