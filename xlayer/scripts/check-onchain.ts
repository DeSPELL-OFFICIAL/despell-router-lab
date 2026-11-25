// Read-only checks against X Layer mainnet. Sends no transaction and needs no key.
//
//   node scripts/check-onchain.ts [circuitId ...]
//
// 1. Prints the fees the processor and its transistor contract charge today.
// 2. For each circuit id (default: some already taped out on the OrderGuard XL processor with more than 8 inputs or
//    several outputs), reads its netlist, evaluates it locally with src/netlist.ts, and compares with the contract's
//    own `eval` on sample input vectors. That checks the byte format, the input packing across bytes and the output
//    order this folder assumes, and src/onchain.ts with them.
//
// XLAYER_RPC overrides the public RPC; XLAYER_PROCESSOR overrides the processor address.

import { formatOkb } from "../src/cost.ts";
import { decodeNetlist, evaluate } from "../src/netlist.ts";
import { SELECTOR, X_LAYER_CHAIN_ID, X_LAYER_PUBLIC_RPC, XLayerReader } from "../src/onchain.ts";

/** OrderGuard XL processor (github.com/xm1319/tapemkt), X Layer mainnet. */
const PROCESSOR = process.env.XLAYER_PROCESSOR ?? "0x57F319CF056F72F48cF1dbb670F2A3DB007Aa355";
const SAMPLES = 24;
const reader = new XLayerReader(process.env.XLAYER_RPC ?? X_LAYER_PUBLIC_RPC);

async function main(): Promise<void> {
  const chainId = await reader.chainId();
  if (chainId !== X_LAYER_CHAIN_ID) throw new Error(`RPC is chain ${chainId}, not X Layer (196)`);

  const transistors = await reader.addressView(PROCESSOR, SELECTOR.transistors);
  const [tapeoutFee, mintPrice, protocolFee, supplyCap, minted, gasPrice] = await Promise.all([
    reader.uintView(PROCESSOR, SELECTOR.tapeoutFee),
    reader.uintView(transistors, SELECTOR.mintPrice),
    reader.uintView(transistors, SELECTOR.protocolFee),
    reader.uintView(transistors, SELECTOR.supplyCap),
    reader.uintView(transistors, SELECTOR.minted),
    reader.rpc("eth_gasPrice", []).then((hex) => BigInt(hex)),
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
    const { nIn, nOut, nState, gateCount } = await reader.circuitInfo(PROCESSOR, id);
    if (nState !== 0 || nIn > 32 || nOut > 32) {
      console.log(`circuit #${id}: ${nState !== 0 ? "has state (LATCH)" : "more than 32 pins"}, skipped`);
      continue;
    }
    const netlist = decodeNetlist(await reader.netlist(PROCESSOR, id), nIn, nOut);
    let same = 0;
    const outputsSeen = new Set<number>();
    for (let sample = 0; sample < SAMPLES; sample++) {
      // Spread samples over all pins: all zeros, all ones, one pin at a time, then pseudo-random vectors.
      const vector =
        sample === 0 ? 0 : sample === 1 ? 2 ** nIn - 1 : sample < 2 + Math.min(nIn, 8) ? 2 ** (nIn - 1 - (sample - 2)) : Math.floor(Math.random() * 2 ** nIn);
      const local = evaluate(netlist, vector);
      const chain = await reader.evalVector(PROCESSOR, id, vector, nIn, nOut);
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
