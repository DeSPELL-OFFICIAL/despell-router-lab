#!/usr/bin/env node
// Measures the on-chain reflex: change the test pool's fee on Base Sepolia, wait for Reactive Network to mark the
// pool on PoolGuard, record the three transactions and the time between them, reopen the pool, repeat.
//
//   node --env-file=<env file> ../scripts/with-key.mjs -- node scripts/measure.mjs      (run from reactive/reflex)
//
// Inputs (environment): PRIVATE_KEY (the hook and PoolGuard owner; only the forge child processes read it),
// GUARD and REFLEX (the deployed contracts), RUNS (default 14, even so the fee ends where it started),
// OUT (default ../deployments/reflex-latency-base-sepolia.json). The pool must start at 0.05% (500).
//
// Each run sends two transactions with forge (the fee change and the reopen); every read goes over plain JSON-RPC.
// Results are written after every run, a failed run is recorded and the loop goes on, and every run ends with the
// pool open again, so one slow callback cannot turn the later runs into MarkKept.
// Latency is measured on chain: the PoolGuard mark's block against the fee change's block. Base Sepolia makes a block
// about every 0.2 s and stamps blocks in whole seconds, so both the block gap and the second gap are kept.
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  blockOf,
  feeOf,
  findReaction,
  forgeSend,
  HOOK,
  LASNA_RPC,
  latest,
  oneLine,
  POOL_ID,
  precheck as checkBeforeSending,
  BASE_RPC,
  sleep,
  statusInLog,
  statusOf,
  waitForMark as waitForPoolMark,
} from "./chain.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REFLEX_DIR = resolve(HERE, "..");
const POOL_DIR = resolve(HERE, "../..");

const LOW_FEE = 500; // 0.05%
const HIGH_FEE = 100_000; // 10%
const MARK_TIMEOUT_MS = 180_000;
const LATE_TIMEOUT_MS = 120_000;
const ETH_PER_RUN = 20_000_000_000_000n; // 0.00002 ETH
const LREACT_PER_RUN = 20_000_000_000_000_000n; // 0.02 lREACT

const env = process.env;
const GUARD = must("GUARD");
const REFLEX = must("REFLEX");
const RUNS = Number(env.RUNS ?? 14);
const OUT = resolve(REFLEX_DIR, env.OUT ?? "../deployments/reflex-latency-base-sepolia.json");
if (!Number.isInteger(RUNS) || RUNS < 1 || RUNS > 40) fail("RUNS must be 1..40");

function must(name) {
  const v = env[name];
  if (!v || !/^0x[0-9a-fA-F]{40}$/.test(v)) fail(`${name} must be an address`);
  return v;
}
function fail(msg) {
  console.error(`measure: ${msg}`);
  process.exit(2);
}
const feeNow = () => feeOf(POOL_ID);
const statusNow = () => statusOf(GUARD, POOL_ID);
const waitForMark = (feeTx, fromBlock, timeoutMs) => waitForPoolMark({ guard: GUARD, pool: POOL_ID, originTx: feeTx, fromBlock, timeoutMs });

const findReactive = (feeTx, fromBlock) => findReaction({ reflex: REFLEX, pool: POOL_ID, originTx: feeTx, fromBlock });

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function settle() {
  // Whatever happened in a run, the next one must start from an open pool, or it would only see MarkKept.
  if ((await statusNow()) === 0) return null;
  return forgeSend(REFLEX_DIR, "script/Reopen.s.sol", "base_sepolia", { GUARD });
}

function summarize(runs) {
  const marked = runs.filter((r) => r.result === "marked");
  const secs = marked.map((r) => r.seconds);
  return {
    runs: runs.length,
    marked: marked.length,
    medianSeconds: marked.length ? median(secs) : null,
    medianBlocks: marked.length ? median(marked.map((r) => r.blocks)) : null,
    minSeconds: marked.length ? Math.min(...secs) : null,
    maxSeconds: marked.length ? Math.max(...secs) : null,
  };
}

function save(runs) {
  const record = {
    measuredAt: new Date().toISOString(),
    origin: { chain: "Base Sepolia", chainId: 84532, hook: HOOK, poolId: POOL_ID },
    reactive: { chain: "Reactive Lasna", chainId: 5318007, poolReflex: REFLEX },
    destination: { chain: "Base Sepolia", chainId: 84532, poolGuard: GUARD },
    method:
      "seconds = PoolGuard mark block timestamp - fee change block timestamp (whole seconds); blocks = block gap on Base Sepolia (about 0.2 s each)",
    summary: summarize(runs),
    runs,
  };
  writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
  return record.summary;
}

async function measureOnce(i, run) {
  const oldFee = await feeNow();
  const newFee = oldFee === LOW_FEE ? HIGH_FEE : LOW_FEE;
  Object.assign(run, { oldFee, newFee });
  const lasnaFrom = (await latest(LASNA_RPC)) - 20;
  const fee = await forgeSend(POOL_DIR, "script/SetFee.s.sol", "base_sepolia", { HOOK, NEW_FEE: String(newFee) });
  const feeBlock = await blockOf(BASE_RPC, fee.block);
  Object.assign(run, { feeTx: fee.hash, feeBlock: feeBlock.number, feeTime: feeBlock.time, lasnaFrom });

  const { found: seen, cursor } = await waitForMark(fee.hash, fee.block, MARK_TIMEOUT_MS);
  run.scanCursor = cursor;
  if (!seen) {
    run.result = `no mark within ${MARK_TIMEOUT_MS / 1000} s`;
    console.log(`#${i} ${oldFee}->${newFee} fee ${fee.hash} (${fee.block}): ${run.result}`);
    return;
  }
  const markBlock = await blockOf(BASE_RPC, Number(seen.log.blockNumber));
  // The status the Marked event set, for the page's journal.
  if (seen.kind === "marked") run.newStatus = statusInLog(seen.log);
  Object.assign(run, {
    result: seen.kind,
    markTx: seen.log.transactionHash,
    markBlock: markBlock.number,
    markTime: markBlock.time,
    blocks: markBlock.number - feeBlock.number,
    seconds: markBlock.time - feeBlock.time,
  });
  run.reactive = await findReactive(fee.hash, lasnaFrom).catch(() => null);
  console.log(
    `#${i} ${oldFee}->${newFee} fee ${fee.hash} (${fee.block}) -> ${seen.kind} ${run.markTx} (${run.markBlock}): ` +
      `${run.seconds} s, ${run.blocks} blocks · Lasna ${run.reactive?.tx ?? "not found yet"}`,
  );
}

/** Stops before spending anything if the loop cannot work: wiring, owners, debts and funds. */
async function precheck() {
  const runs = BigInt(RUNS);
  const { problems, reflexFunds, guardFunds } = await checkBeforeSending({
    guard: GUARD,
    reflex: REFLEX,
    lreactNeeded: LREACT_PER_RUN * runs,
    ethNeeded: ETH_PER_RUN * runs,
  });
  if (problems.length) fail(`not starting:\n  - ${problems.join("\n  - ")}`);
  console.log(`measure: checks passed · PoolReflex funds ${reflexFunds} wei · PoolGuard funds ${guardFunds} wei`);
}

async function main() {
  console.log(`measure: ${RUNS} runs · hook ${HOOK} · PoolGuard ${GUARD} · PoolReflex ${REFLEX}`);
  const startFee = await feeNow();
  if (startFee !== LOW_FEE) fail(`the pool's fee is ${startFee}, not ${LOW_FEE}; set it back to ${LOW_FEE} first`);
  if (await settle()) console.log("measure: the pool was marked; reopened it first");

  await precheck();
  const runs = [];
  let silent = 0;
  for (let i = 1; i <= RUNS; i++) {
    const run = { run: i };
    runs.push(run);
    try {
      await measureOnce(i, run);
    } catch (err) {
      run.result = run.result ?? "error";
      run.error = oneLine(err.message);
      console.log(`#${i} error: ${run.error}`);
    }
    try {
      // A late callback can still land; give it another window from where the scan stopped, then reopen the pool.
      if (run.result !== "marked" && run.feeTx) {
        const { found: late } = await waitForMark(run.feeTx, run.scanCursor ?? run.feeBlock, LATE_TIMEOUT_MS);
        if (late) run.late = { kind: late.kind, markTx: late.log.transactionHash, markBlock: Number(late.log.blockNumber) };
      }
      const reopen = await settle();
      if (reopen) Object.assign(run, { reopenTx: reopen.hash, reopenBlock: reopen.block });
    } catch (err) {
      run.settleError = oneLine(err.message);
      console.log(`#${i} could not reopen: ${run.settleError}`);
    }
    delete run.scanCursor;
    save(runs);
    silent = run.result !== "marked" && run.result !== "kept" && !run.late ? silent + 1 : 0;
    if (silent >= 2) {
      console.log("measure: two runs in a row got no mark; stopping so nothing more is spent");
      break;
    }
    await sleep(3_000);
  }

  // Lasna logs can lag the mark; look once more for any reactive transaction not found yet.
  for (const run of runs) {
    if (run.markTx && !run.reactive) run.reactive = await findReactive(run.feeTx, run.lasnaFrom).catch(() => null);
  }
  const summary = save(runs);
  const endFee = await feeNow().catch(() => null);
  console.log(
    `measure: ${summary.marked}/${summary.runs} marked · median ${summary.medianSeconds} s (${summary.medianBlocks} blocks) · ` +
      `fee now ${endFee} · ${OUT}`,
  );
  if (summary.marked < runs.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`measure: ${err.message}`);
  process.exit(1);
});
