// Read-only checks against X Layer mainnet. Sends no transaction and needs no key.
//
//   node scripts/check-onchain.ts [circuitId ...]
//
// 1. Prints the fees the processor and its transistor contract charge today.
// 2. For each circuit id (default: some already taped out on the OrderGuard XL processor with more than 8 inputs or
//    several outputs), reads its netlist, evaluates it locally with src/netlist.ts, and compares with the contract's
//    own `eval` on sample input vectors. That checks the byte format, the input packing across bytes and the output
//    order this folder assumes, before DES-699 pays for anything.
//
// XLAYER_RPC overrides the public RPC; XLAYER_PROCESSOR overrides the processor address.

import { packPins, unpackPins } from "../src/bits.ts";
import { formatOkb } from "../src/cost.ts";
import { decodeNetlist, evaluate, fromHex } from "../src/netlist.ts";

const RPC = process.env.XLAYER_RPC ?? "https://rpc.xlayer.tech";
/** OrderGuard XL processor (github.com/xm1319/tapemkt), X Layer mainnet. */
const PROCESSOR = process.env.XLAYER_PROCESSOR ?? "0x57F319CF056F72F48cF1dbb670F2A3DB007Aa355";
const X_LAYER_CHAIN_ID = 196;
const SAMPLES = 24;

// Function selectors (first 4 bytes of keccak256 of the signature).
const SELECTOR = {
  eval: "934d06ea", // eval(uint256,bytes)
  netlist: "3fc4be56", // netlist(uint256)
  circuitInfo: "084d60f1", // circuitInfo(uint256)
  tapeoutFee: "adfb2b69", // TAPEOUT_FEE()
  transistors: "6fbd1719", // transistors()
  mintPrice: "6817c76c", // mintPrice()
  protocolFee: "b0e21e8a", // protocolFee()
  supplyCap: "8f770ad0", // supplyCap()
  minted: "4f02c420", // minted()
} as const;

let requestId = 0;
async function rpc(method: string, params: unknown[]): Promise<string> {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
  });
  if (!response.ok) throw new Error(`${method}: RPC answered HTTP ${response.status}`);
  const body = (await response.json()) as { result?: string; error?: { message: string } };
  if (body.error || typeof body.result !== "string") throw new Error(`${method}: ${body.error?.message ?? "no result"}`);
  return body.result;
}

const word = (value: bigint | number) => BigInt(value).toString(16).padStart(64, "0");
const call = (to: string, data: string) => rpc("eth_call", [{ to, data: `0x${data}` }, "latest"]);
const uint = (hex: string, index = 0) => BigInt(`0x${hex.slice(2 + index * 64, 2 + (index + 1) * 64)}`);

function decodeBytes(hex: string): Uint8Array {
  const body = hex.slice(2);
  const offset = Number(BigInt(`0x${body.slice(0, 64)}`)) * 2;
  const length = Number(BigInt(`0x${body.slice(offset, offset + 64)}`));
  return fromHex(body.slice(offset + 64, offset + 64 + length * 2));
}

function encodeBytesArg(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString("hex");
  const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
  return word(0x40) + word(bytes.length) + padded;
}

async function main(): Promise<void> {
  const chainId = Number(BigInt(await rpc("eth_chainId", [])));
  if (chainId !== X_LAYER_CHAIN_ID) throw new Error(`RPC is chain ${chainId}, not X Layer (196)`);

  const transistors = `0x${(await call(PROCESSOR, SELECTOR.transistors)).slice(-40)}`;
  const [tapeoutFee, mintPrice, protocolFee, supplyCap, minted, gasPrice] = await Promise.all([
    call(PROCESSOR, SELECTOR.tapeoutFee).then((hex) => uint(hex)),
    call(transistors, SELECTOR.mintPrice).then((hex) => uint(hex)),
    call(transistors, SELECTOR.protocolFee).then((hex) => uint(hex)),
    call(transistors, SELECTOR.supplyCap).then((hex) => uint(hex)),
    call(transistors, SELECTOR.minted).then((hex) => uint(hex)),
    rpc("eth_gasPrice", []).then((hex) => BigInt(hex)),
  ]);
  console.log(`processor ${PROCESSOR}, transistors ${transistors}`);
  console.log(
    `TAPEOUT_FEE ${formatOkb(tapeoutFee)} OKB · mintPrice ${formatOkb(mintPrice)} OKB per NAND · protocolFee ${formatOkb(protocolFee)} OKB per mint` +
      ` · NAND supply ${minted}/${supplyCap} · gas price ${gasPrice} wei`,
  );

  const ids = process.argv.slice(2).map((arg) => {
    if (!/^[0-9]+$/u.test(arg)) throw new Error(`circuit id must be a whole number: ${arg}`);
    return Number(arg);
  });
  let failures = 0;
  for (const id of ids.length > 0 ? ids : [15, 18, 20, 26, 27]) {
    const info = await call(PROCESSOR, SELECTOR.circuitInfo + word(id));
    const [nIn, nOut, nState, gateCount] = [0, 1, 2, 3].map((index) => Number(uint(info, index)));
    if (nState !== 0 || nIn! > 32 || nOut! > 32) {
      console.log(`circuit #${id}: ${nState !== 0 ? "has state (LATCH)" : "more than 32 pins"}, skipped`);
      continue;
    }
    const netlist = decodeNetlist(decodeBytes(await call(PROCESSOR, SELECTOR.netlist + word(id))), nIn!, nOut!);
    let same = 0;
    const outputsSeen = new Set<number>();
    for (let sample = 0; sample < SAMPLES; sample++) {
      // Spread samples over all pins: all zeros, all ones, one pin at a time, then pseudo-random vectors.
      const vector =
        sample === 0 ? 0 : sample === 1 ? 2 ** nIn! - 1 : sample < 2 + Math.min(nIn!, 8) ? 2 ** (nIn! - 1 - (sample - 2)) : Math.floor(Math.random() * 2 ** nIn!);
      const local = evaluate(netlist, vector);
      const chain = unpackPins(decodeBytes(await call(PROCESSOR, SELECTOR.eval + word(id) + encodeBytesArg(packPins(vector, nIn!)))), nOut!);
      outputsSeen.add(chain);
      if (local === chain) same += 1;
      else console.log(`  #${id} vector ${vector}: local ${local}, eval ${chain}`);
    }
    const ok = same === SAMPLES && netlist.gates.length === gateCount;
    if (!ok) failures += 1;
    console.log(
      `circuit #${id}: ${nIn} in, ${nOut} out, ${gateCount} NAND · local evaluation = on-chain eval on ${same}/${SAMPLES} vectors` +
        ` (${outputsSeen.size} different outputs seen)${ok ? "" : " ✗"}`,
    );
  }
  if (failures > 0) process.exitCode = 1;
}

await main();
