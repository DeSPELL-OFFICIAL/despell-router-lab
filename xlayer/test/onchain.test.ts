// The chain reader against a fake RPC that answers like a TapeOut processor holding the judgment circuit as id 7.

import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeInput, INPUT_COUNT, OUTPUT_COUNT, packPins, unpackPins } from "../src/bits.ts";
import { buildJudgmentCircuit } from "../src/circuit.ts";
import { encodeNetlist, evaluate } from "../src/netlist.ts";
import { decodeBytesResult, encodeBytesArgument, judgeOnChain, SELECTOR, word, wordAt, XLayerReader } from "../src/onchain.ts";
import { judge } from "../src/rule.ts";
import { samples } from "../src/samples.ts";

const PROCESSOR = "0x00000000000000000000000000000000000000aa";
const CIRCUIT = 7;
const netlist = buildJudgmentCircuit();

/** Plain ABI encoding of a returned `bytes`, written out here so the reader's decoder is checked against it. */
function returnBytes(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString("hex");
  return `0x${"20".padStart(64, "0")}${bytes.length.toString(16).padStart(64, "0")}${hex.padEnd(Math.ceil(hex.length / 64) * 64, "0")}`;
}

/** A processor that holds the judgment circuit as id 7, decoding calls by hand. */
async function fakeRpc(_url: string, init: { body: string }) {
  const request = JSON.parse(init.body) as { id: number; method: string; params: [{ to: string; data: string }, string] };
  const reply = (result: string) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: request.id, result }) });
  if (request.method === "eth_chainId") return reply("0xc4");
  assert.equal(request.method, "eth_call");
  assert.equal(request.params[0].to, PROCESSOR);
  const data = request.params[0].data.slice(2);
  const selector = data.slice(0, 8);
  const id = Number(BigInt(`0x${data.slice(8, 72)}`));
  assert.equal(id, CIRCUIT);
  if (selector === SELECTOR.circuitInfo) return reply(`0x${[INPUT_COUNT, OUTPUT_COUNT, 0, netlist.gates.length].map((n) => n.toString(16).padStart(64, "0")).join("")}`);
  if (selector === SELECTOR.netlist) return reply(returnBytes(encodeNetlist(netlist)));
  assert.equal(selector, SELECTOR.eval);
  assert.equal(BigInt(`0x${data.slice(72, 136)}`), 64n, "bytes offset is right after the two head slots");
  const length = Number(BigInt(`0x${data.slice(136, 200)}`));
  const inputs = Uint8Array.from(Buffer.from(data.slice(200, 200 + length * 2), "hex"));
  const output = evaluate(netlist, unpackPins(inputs, INPUT_COUNT));
  return reply(returnBytes(packPins(output, OUTPUT_COUNT)));
}

const reader = new XLayerReader("http://fake", fakeRpc);

test("eval calldata is the plain ABI encoding of (uint256 id, bytes inputs)", () => {
  const calldata = SELECTOR.eval + word(20) + encodeBytesArgument(Uint8Array.from([1]), 2);
  assert.equal(calldata, `934d06ea${word(20)}${word(0x40)}${word(1)}01${"0".repeat(62)}`);
  assert.deepEqual([...decodeBytesResult(returnBytes(Uint8Array.from([2, 3])))], [2, 3]);
  assert.equal(wordAt(`0x${word(5)}${word(9)}`, 1), 9n);
  assert.throws(() => word(-1));
});

test("the reader reads the circuit's info and netlist back", async () => {
  assert.equal(await reader.chainId(), 196);
  assert.deepEqual(await reader.circuitInfo(PROCESSOR, CIRCUIT), { nIn: 27, nOut: 5, nState: 0, gateCount: netlist.gates.length });
  assert.deepEqual(await reader.netlist(PROCESSOR, CIRCUIT), encodeNetlist(netlist));
});

test("judgeOnChain gives the rule function's judgment on every sample", async () => {
  for (const sample of samples()) {
    const input = decodeInput(sample.vector);
    assert.deepEqual(await judgeOnChain(reader, PROCESSOR, CIRCUIT, input), judge(input), sample.name);
  }
});

test("the reader refuses a bad address and passes RPC errors on", async () => {
  await assert.rejects(reader.call("0x123", SELECTOR.eval), /not an address/u);
  const failing = new XLayerReader("http://fake", async () => ({ ok: true, status: 200, json: async () => ({ error: { message: "execution reverted: no circuit" } }) }));
  await assert.rejects(failing.circuitInfo(PROCESSOR, 1), /no circuit/u);
  const down = new XLayerReader("http://fake", async () => ({ ok: false, status: 429, json: async () => ({}) }));
  await assert.rejects(down.chainId(), /HTTP 429/u);
});
