import assert from "node:assert/strict";
import { test } from "node:test";

import { buildPage, median, quantile, readmeBlock, SCHEMA, withReadmeBlock } from "./report.mjs";

const hash = (c) => `0x${c.repeat(64)}`;
const addr = (c) => `0x${c.repeat(40)}`;

/** A measurement shaped like scripts/measure.mjs output: three marked runs, one that never got a mark. */
function fixture() {
  const run = (i, seconds, blocks, extra = {}) => ({
    run: i,
    oldFee: i % 2 ? 500 : 100_000,
    newFee: i % 2 ? 100_000 : 500,
    feeTx: hash(String(i)),
    feeBlock: 1000 + i * 100,
    feeTime: 1_795_700_000 + i * 60,
    result: "marked",
    markTx: hash("a"),
    markBlock: 1000 + i * 100 + blocks,
    markTime: 1_795_700_000 + i * 60 + seconds,
    blocks,
    seconds,
    reactive: { tx: hash("b"), block: 9_300_000 + i, time: 1_795_700_000 + i * 60 + 1 },
    reopenTx: hash("c"),
    ...extra,
  });
  return {
    measuredAt: "2026-11-26T00:00:00.000Z",
    origin: { chain: "Base Sepolia", chainId: 84532, hook: addr("1"), poolId: hash("f") },
    reactive: { chain: "Reactive Lasna", chainId: 5318007, poolReflex: addr("2") },
    destination: { chain: "Base Sepolia", chainId: 84532, poolGuard: addr("3") },
    method: "seconds = block timestamps; blocks = block gap",
    runs: [
      run(1, 2, 9),
      run(2, 1, 5),
      run(3, 4, 18),
      { run: 4, oldFee: 100_000, newFee: 500, feeTx: hash("4"), feeBlock: 1400, feeTime: 1_795_700_240, result: "no mark within 180 s" },
    ],
  };
}

test("median and nearest-rank quantile", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
  assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
  assert.equal(quantile([5], 0.9), 5);
});

test("latency covers only marked runs and counts every run", () => {
  const page = buildPage(fixture(), { generatedAt: "now" });
  assert.equal(page.schema, SCHEMA);
  assert.equal(page.latency.runs, 4);
  assert.equal(page.latency.n, 3);
  assert.equal(page.latency.medianSeconds, 2);
  assert.equal(page.latency.medianBlocks, 9);
  assert.equal(page.latency.minSeconds, 1);
  assert.equal(page.latency.maxSeconds, 4);
  assert.equal(page.latency.shares.withinOneBlock, 0);
  assert.equal(page.latency.shares.withinFiveBlocks, 1 / 3);
  assert.equal(page.latency.shares.withinTwoSeconds, 2 / 3);
});

test("the journal links every transaction to its own explorer", () => {
  const page = buildPage(fixture());
  const first = page.journal[0];
  assert.equal(first.change.label, "0.05% → 10%");
  assert.equal(first.origin.url, `https://sepolia.basescan.org/tx/${hash("1")}`);
  assert.equal(first.origin.reactscan, `https://lasna.reactscan.net/search?q=${hash("1")}`);
  assert.equal(first.reactive.url, `https://lasna.reactscan.net/tx/${hash("b")}`);
  assert.equal(first.mark.url, `https://sepolia.basescan.org/tx/${hash("a")}`);
  assert.equal(page.journal[3].mark, null);
  assert.equal(page.journal[3].result, "no mark within 180 s");
});

test("marksNow is a live snapshot only when statuses are given", () => {
  assert.equal(buildPage(fixture()).marksNow, null);
  const live = buildPage(fixture(), { statuses: { [hash("f")]: 2 } });
  assert.deepEqual(live.marksNow, [{ poolId: hash("f"), status: 2, label: "narrowed (0.1x)" }]);
});

test("the README block is replaced in place, never duplicated", () => {
  const block = readmeBlock(buildPage(fixture()));
  assert.match(block, /3 of 4 fee changes marked/);
  assert.match(block, /\| 4 \| 10% → 0\.05% \|/);
  const once = withReadmeBlock("# reactive\n\nintro\n", block);
  const twice = withReadmeBlock(once, block);
  assert.equal(twice, once);
  assert.equal(once.split("reflex-latency:begin").length, 2);
});
