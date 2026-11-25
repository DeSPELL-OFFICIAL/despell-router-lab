import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ARTIFACT_URL, artifactText } from "../src/artifact.ts";
import { INPUT_COUNT, OUTPUT_COUNT, PIN } from "../src/bits.ts";
import { buildJudgmentCircuit } from "../src/circuit.ts";
import { formatOkb, tapeoutCost } from "../src/cost.ts";
import { compareAll } from "../src/exhaustive-parallel.ts";
import { decodeNetlist, encodeNetlist, evaluate32, fromHex, scratchFor, toHex } from "../src/netlist.ts";
import { CHANGE_KINDS, STAGES } from "../src/rule.ts";

const netlist = buildJudgmentCircuit();
const artifactFile = readFileSync(ARTIFACT_URL, "utf8");
const artifact = JSON.parse(artifactFile) as {
  nIn: number;
  nOut: number;
  nand: number;
  bytes: number;
  netlist: string;
};

test("the circuit equals the rule function on every input combination", async (t) => {
  const result = await compareAll(netlist);
  t.diagnostic(
    `${result.checked.toLocaleString("en-US")} of ${result.combinations.toLocaleString("en-US")} combinations (2^${INPUT_COUNT}), ` +
      `${result.mismatches} differ, ${netlist.gates.length} NAND, ${result.threads} threads, ${result.ms} ms`,
  );
  assert.equal(result.combinations, 2 ** INPUT_COUNT);
  assert.equal(result.checked, result.combinations);
  assert.equal(result.mismatches, 0, `first difference: ${JSON.stringify(result.first)}`);
});

test("the committed netlist is the one the rules build today", (t) => {
  assert.equal(artifactFile, artifactText(netlist), "run `pnpm build:circuit` in xlayer/");
  const bytes = encodeNetlist(netlist);
  assert.equal(artifact.nIn, INPUT_COUNT);
  assert.equal(artifact.nOut, OUTPUT_COUNT);
  assert.equal(artifact.nand, netlist.gates.length);
  assert.equal(artifact.bytes, bytes.length);
  assert.equal(artifact.netlist, toHex(bytes), "run `pnpm build:circuit` in xlayer/");
  // What DES-699 tapes out decodes back to the same gates.
  assert.deepEqual(decodeNetlist(fromHex(artifact.netlist), artifact.nIn, artifact.nOut).gates, netlist.gates);
  const cost = tapeoutCost(artifact.nand);
  t.diagnostic(`${artifact.nand} NAND · fees ${formatOkb(cost.feesWei)} OKB · with protocol fee ${formatOkb(cost.totalWei)} OKB`);
});

test("the circuit never opens a pool without an AI full review, approved family and passing probe facts", () => {
  // Checked on the circuit itself, every input: the stage code only goes up when all of these are 1.
  const scratch = scratchFor(netlist);
  let openings = 0;
  for (let base = 0; base < 2 ** INPUT_COUNT; base += 32) {
    const words = evaluate32(netlist, base, scratch);
    for (let j = 0; j < 32; j++) {
      const vector = base + j;
      const next = ((words[0]! >>> j) & 1) | (((words[1]! >>> j) & 1) << 1) | (((words[2]! >>> j) & 1) << 2);
      assert.ok(next < STAGES.length, `stage code ${next} at ${vector}`);
      const current = (vector >>> PIN.stage) & 7;
      if (current >= STAGES.length) {
        assert.equal(next, 0, `broken stage must become blocked at ${vector}`);
        continue;
      }
      if (next === STAGES.indexOf("trusted")) assert.equal(current, next, `trusted only stays trusted (${vector})`);
      if (next <= current) continue;
      openings += 1;
      const decision = (vector >>> PIN.decision) & 3;
      const family = (vector >>> PIN.family) & 3;
      const all = [
        PIN.fullReview,
        PIN.tokenPermissionsClear,
        PIN.lossUnderReflexLine,
        PIN.hiddenLossWithinOpenLimit,
        PIN.sellNotReverted,
        PIN.codeHashMatches,
      ].every((pin) => (vector >>> pin) & 1);
      assert.ok(all && family <= 1, `opened without its conditions at ${vector}`);
      // The only two ways up: allow to probation from below it, or the admin handle path from unknown to restricted.
      const allowUp = decision === 1 && next === STAGES.indexOf("probation") && current < next;
      const handleUp =
        decision === 2 &&
        ((vector >>> PIN.adminHandleRestrict) & 1) === 1 &&
        current === STAGES.indexOf("unknown") &&
        next === STAGES.indexOf("restricted");
      assert.ok(allowUp || handleUp, `opened by another path at ${vector}`);
    }
  }
  assert.ok(openings > 0, "some combinations do open");
});

test("an operator block or a pause always closes the lane", () => {
  const scratch = scratchFor(netlist);
  for (let base = 0; base < 2 ** INPUT_COUNT; base += 32) {
    const words = evaluate32(netlist, base, scratch);
    const closedEveryWhere = words[3]! & words[4]!;
    const blocked = (base >>> PIN.operatorBlocked) & 1;
    const paused = (base >>> (PIN.changes + CHANGE_KINDS.indexOf("paused"))) & 1;
    if (blocked || paused) assert.equal(closedEveryWhere, -1, `lane not closed in word ${base}`);
  }
});
