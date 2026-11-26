// The replay command's exit codes: 0 same, 1 a difference, 2 nothing trustworthy to report. --chain runs against a fake
// RPC, so no network is used.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { INPUT_COUNT, OUTPUT_COUNT, packPins, unpackPins } from "../src/bits.ts";
import { buildJudgmentCircuit } from "../src/circuit.ts";
import { encodeNetlist, evaluate, NandBuilder } from "../src/netlist.ts";
import { SELECTOR, TAPED_OUT, XLayerReader } from "../src/onchain.ts";
import { replayCommand, type ReplayCommandDeps } from "../src/replay-command.ts";

const SAMPLE = new URL("./fixtures/journal-sample.json", import.meta.url);
const netlist = buildJudgmentCircuit();

function returnBytes(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString("hex");
  return `0x${"20".padStart(64, "0")}${bytes.length.toString(16).padStart(64, "0")}${hex.padEnd(Math.ceil(hex.length / 64) * 64, "0")}`;
}

type Node = {
  chainId?: string;
  /** What circuitInfo and netlist answer with; "revert" for no such circuit, "empty" for an address with no code. */
  circuit?: "ok" | "revert" | "empty" | "other";
  /** Fail every eval call after this many. */
  evalFailsAfter?: number;
  /** HTTP status for every request. */
  status?: number;
};

/** A fake X Layer node holding the committed circuit as TAPED_OUT. */
function fakeNode(node: Node = {}) {
  let evals = 0;
  const other = new NandBuilder(INPUT_COUNT);
  const otherNetlist = other.finish([other.nand(2, 3)]);
  return async (_url: string, init: { body: string }) => {
    const request = JSON.parse(init.body) as { id: number; method: string; params: [{ to: string; data: string }, string] };
    const reply = (body: object) => ({ ok: node.status === undefined, status: node.status ?? 200, json: async () => ({ jsonrpc: "2.0", id: request.id, ...body }) });
    if (request.method === "eth_chainId") return reply({ result: node.chainId ?? "0xc4" });
    const data = request.params[0].data.slice(2);
    const selector = data.slice(0, 8);
    const kind = node.circuit ?? "ok";
    if (selector === SELECTOR.circuitInfo || selector === SELECTOR.netlist) {
      if (kind === "revert") return reply({ error: { message: "execution reverted" } });
      if (kind === "empty") return reply({ result: "0x" });
      const held = kind === "other" ? otherNetlist : netlist;
      if (selector === SELECTOR.netlist) return reply({ result: returnBytes(encodeNetlist(held)) });
      return reply({ result: `0x${[INPUT_COUNT, kind === "other" ? 1 : OUTPUT_COUNT, 0, held.gates.length].map((n) => n.toString(16).padStart(64, "0")).join("")}` });
    }
    assert.equal(selector, SELECTOR.eval);
    evals += 1;
    if (node.evalFailsAfter !== undefined && evals > node.evalFailsAfter) return reply({ error: { message: "rate limited" } });
    const length = Number(BigInt(`0x${data.slice(136, 200)}`));
    const inputs = Uint8Array.from(Buffer.from(data.slice(200, 200 + length * 2), "hex"));
    return reply({ result: returnBytes(packPins(evaluate(netlist, unpackPins(inputs, INPUT_COUNT)), OUTPUT_COUNT)) });
  };
}

function deps(node: Node = {}, files: Record<string, string> = {}): ReplayCommandDeps & { written: Map<string, string> } {
  const written = new Map<string, string>();
  return {
    written,
    readText: (path) => {
      const key = String(path);
      if (key in files) return files[key]!;
      return readFileSync(path, "utf8");
    },
    writeText: (path, text) => written.set(path, text),
    reader: () => new XLayerReader("http://fake", fakeNode(node)),
  };
}

const samplePath = SAMPLE.pathname;

test("0: every replayed step gives the server's stage, here and through eval", async () => {
  const local = await replayCommand(["--file", samplePath], deps());
  assert.equal(local.code, 0, local.stderr);
  assert.match(local.stdout, /^8 of 8 judged patrol steps/u);
  assert.match(local.stdout, /circuit: the committed netlist/u);

  const withOut = deps();
  const chain = await replayCommand(["--file", samplePath, "--chain", "--out", "report.txt"], withOut);
  assert.equal(chain.code, 0, chain.stderr);
  assert.match(chain.stdout, new RegExp(`circuit: eval on X Layer \\(chain 196\\), processor ${TAPED_OUT.processor}, circuit #1`, "u"));
  assert.equal(withOut.written.get("report.txt"), chain.stdout);
});

test("1: a replayed step differs", async () => {
  const journal = JSON.parse(readFileSync(SAMPLE, "utf8")) as { lines: { pool: string; actor: string; after: string }[] };
  for (const line of journal.lines) if (line.pool === `0x${"7".repeat(40)}` && line.actor === "trust_rule") line.after = "probation";
  const result = await replayCommand(["--file", "tampered.json"], deps({}, { "tampered.json": JSON.stringify(journal) }));
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^7 of 8 judged/u);
});

test("2: bad arguments or an export that fails its checks", async () => {
  assert.equal((await replayCommand([], deps())).code, 2);
  assert.equal((await replayCommand(["--file", samplePath, "--processor", "0x12"], deps())).code, 2);
  assert.equal((await replayCommand(["--file", samplePath, "--id", "0"], deps())).code, 2);
  const bad = await replayCommand(["--file", "bad.json"], deps({}, { "bad.json": JSON.stringify({ chainId: 1, lines: [], pools: [] }) }));
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /chainId: expected 91342/u);
  assert.equal((await replayCommand(["--file", "broken.json"], deps({}, { "broken.json": "{" }))).code, 2);
});

test("2, never 1: with --chain, no circuit, no code, another circuit, another chain, or the RPC failing", async () => {
  const cases: [string, Node, RegExp][] = [
    ["no circuit at that id", { circuit: "revert" }, /no committed circuit to ask .*execution reverted/u],
    ["an address with no code", { circuit: "empty" }, /no committed circuit to ask/u],
    ["another circuit", { circuit: "other" }, /is not the committed pool judgment circuit/u],
    ["another chain", { chainId: "0x1" }, /chain 1, not X Layer/u],
    ["the RPC down", { status: 503 }, /HTTP 503/u],
    ["eval failing part way", { evalFailsAfter: 3 }, /stopped part way.*rate limited/u],
  ];
  for (const [what, node, why] of cases) {
    const result = await replayCommand(["--file", samplePath, "--chain"], deps(node));
    assert.equal(result.code, 2, what);
    assert.equal(result.stdout, "", what);
    assert.match(result.stderr, why, what);
  }
});
