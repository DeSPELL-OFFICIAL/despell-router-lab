import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeInput, encodeInput, encodeOutput, INPUT_COUNT, packPins, PIN, unpackPins } from "../src/bits.ts";
import type { Decision, Family, Stage } from "../src/rule.ts";
import { buildJudgmentCircuit } from "../src/circuit.ts";
import { CONST0, CONST1, decodeNetlist, encodeNetlist, evaluate, evaluate32, fromHex, NandBuilder, scratchFor, toHex } from "../src/netlist.ts";

test("the builder folds constants, double negations and repeated gates", () => {
  const c = new NandBuilder(2);
  const [a, b] = [c.input(0), c.input(1)];
  assert.equal(c.nand(a, CONST0), CONST1);
  assert.equal(c.not(c.not(a)), a);
  assert.equal(c.nand(a, b), c.nand(b, a));
  assert.equal(c.nand(a, c.not(a)), CONST1);
  assert.equal(c.mux(a, CONST1, CONST0), a);
  assert.equal(c.lookup([a, b], () => false), CONST0);
  // The builder made NOT a and NAND(a, b); finish keeps only what the output reads.
  assert.equal(c.finish([c.nand(a, b)]).gates.length, 1);
});

test("finish puts the outputs last, in pin order, even when they are inputs, constants or shared gates", () => {
  const c = new NandBuilder(2);
  const [a, b] = [c.input(0), c.input(1)];
  const and = c.and(a, b);
  const or = c.or(a, b);
  const netlist = c.finish([and, a, CONST1, or, and]);
  for (let vector = 0; vector < 4; vector++) {
    const x = vector & 1;
    const y = (vector >> 1) & 1;
    const expected = (x & y) | (x << 1) | (1 << 2) | ((x | y) << 3) | ((x & y) << 4);
    assert.equal(evaluate(netlist, vector), expected, `vector ${vector}`);
  }
});

test("netlist bytes round-trip and match the format: 0x00, u24 a, u24 b", () => {
  const netlist = buildJudgmentCircuit();
  const bytes = encodeNetlist(netlist);
  assert.equal(bytes.length, netlist.gates.length * 7);
  const [a, b] = netlist.gates[0]!;
  assert.deepEqual([...bytes.subarray(0, 7)], [0, (a >> 16) & 255, (a >> 8) & 255, a & 255, (b >> 16) & 255, (b >> 8) & 255, b & 255]);
  assert.deepEqual(decodeNetlist(fromHex(toHex(bytes)), netlist.nIn, netlist.nOut), netlist);
});

test("decoding refuses other opcodes, cut gates and reads of later signals", () => {
  assert.throws(() => decodeNetlist(Uint8Array.from([1, 0, 0, 2]), 1, 1), /not a whole number|not NAND/u);
  assert.throws(() => decodeNetlist(Uint8Array.from([0, 0, 0, 2, 0, 0]), 1, 1), /not a whole number/u);
  assert.throws(() => decodeNetlist(Uint8Array.from([0, 0, 0, 2, 0, 0, 3]), 1, 1), /future signal 3/u);
  assert.throws(() => decodeNetlist(Uint8Array.from([2, 0, 0, 2, 0, 0, 2]), 1, 1), /not NAND/u);
});

test("the 32-wide evaluator agrees with the one-vector evaluator", () => {
  const netlist = buildJudgmentCircuit();
  const scratch = scratchFor(netlist);
  let seed = 12345;
  const random = () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed;
  };
  for (let round = 0; round < 2000; round++) {
    const base = (random() % 2 ** INPUT_COUNT) & ~31;
    const words = evaluate32(netlist, base, scratch);
    const j = random() % 32;
    let wide = 0;
    for (let k = 0; k < netlist.nOut; k++) wide |= ((words[k]! >>> j) & 1) << k;
    assert.equal(wide, evaluate(netlist, base + j));
  }
});

test("eval packing: pin i is bit i % 8 of byte i / 8", () => {
  assert.deepEqual([...packPins(1 << 26, INPUT_COUNT)], [0, 0, 0, 4]);
  assert.deepEqual([...packPins(0b1_0000_0001, 9)], [1, 1]);
  for (const vector of [0, 1, 0x5a5a5a5, 2 ** INPUT_COUNT - 1]) {
    assert.equal(unpackPins(packPins(vector, INPUT_COUNT), INPUT_COUNT), vector);
  }
  assert.throws(() => packPins(0, 33), /pin count/u);
});

test("a raw stage or family outside the closed list is written as the broken code, not as stray bits", () => {
  const input = decodeInput(0);
  assert.equal(encodeInput({ ...input, stage: "corrupt" as Stage }), 5);
  assert.equal(encodeInput({ ...input, family: "corrupt" as Family }), 3 << PIN.family);
  assert.throws(() => encodeInput({ ...input, decision: "corrupt" as Decision }), /not a decision/u);
  assert.throws(() => encodeOutput({ stage: "corrupt" as Stage, lane: "fast" }), /not a judgment/u);
});

test("input vectors decode and encode back (broken stage codes 6 and 7 come back as 5)", () => {
  for (let vector = 0; vector < 2 ** INPUT_COUNT; vector += 4099) {
    const back = encodeInput(decodeInput(vector));
    const stage = vector & 7;
    assert.equal(back, stage >= 5 ? (vector & ~7) | 5 : vector, `vector ${vector}`);
  }
});
