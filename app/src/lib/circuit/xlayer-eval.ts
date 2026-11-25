import { bytesToHex, createPublicClient, fallback, hexToBytes, http, parseAbi, type PublicClient } from "viem";
import { xLayer } from "viem/chains";
import { decodeOutput, encodeInput, INPUT_COUNT, OUTPUT_COUNT, packPins, unpackPins } from "@despell-lab/xlayer/src/bits.ts";
import type { Judgment, JudgmentInput } from "@despell-lab/xlayer/src/rule.ts";
import { X_LAYER, type CircuitDeployment } from "./circuit";

/*
  Asks X Layer for the circuit's judgment: TapeOut's `eval(id, inputs)`, a
  view call on the public RPC. No key, no transaction, so it runs in the
  visitor's browser. The same call as `judgeOnChain` in xlayer/src/onchain.ts
  (selector 0x934d06ea), with the input and output bits packed by
  xlayer/src/bits.ts.
*/

export const EVAL_ABI = parseAbi(["function eval(uint256 id, bytes inputs) view returns (bytes)"]);

export type OnChainJudgment = { vector: number; outputs: number; judgment: Judgment; block: bigint };

export async function judgeOnXLayer(client: PublicClient, deployment: CircuitDeployment, input: JudgmentInput): Promise<OnChainJudgment> {
  const vector = encodeInput(input);
  const block = await client.getBlockNumber({ cacheTime: 0 });
  const result = await client.readContract({
    address: deployment.processor,
    abi: EVAL_ABI,
    functionName: "eval",
    args: [deployment.circuitId, bytesToHex(packPins(vector, INPUT_COUNT))],
    blockNumber: block,
  });
  const outputs = unpackPins(hexToBytes(result), OUTPUT_COUNT);
  return { vector, outputs, judgment: decodeOutput(outputs), block };
}

let client: PublicClient | null = null;

/** One X Layer client for the page, over the public RPCs. */
export function xLayerClient(): PublicClient {
  client ??= createPublicClient({ chain: xLayer, transport: fallback(X_LAYER.rpcUrls.map((url) => http(url))) }) as PublicClient;
  return client;
}
