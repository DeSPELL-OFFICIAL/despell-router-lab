#!/usr/bin/env node
// Measures the on-chain reflex: change the test pool's fee on Base Sepolia, wait for Reactive Network to mark the
// pool on PoolGuard, record the three transactions and the time between them, reopen the pool, repeat.
//
//   node --env-file=<env file> ../scripts/with-key.mjs -- node scripts/measure.mjs      (run from reactive/reflex)
//
// Inputs (environment): PRIVATE_KEY (the hook and PoolGuard owner; only the forge child processes read it),
// GUARD and REFLEX (the deployed contracts), RUNS (default 14, even so the fee ends where it started),
// OUT (default ../deployments/reflex-latency-base-sepolia.json).
//
// Each run sends two transactions with forge (the fee change and the reopen); every read goes over plain JSON-RPC.
// Latency is measured on chain: the PoolGuard mark's block against the fee change's block. Base Sepolia makes a block
// about every 0.2 s and stamps blocks in whole seconds, so both the block gap and the second gap are kept.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REFLEX_DIR = resolve(HERE, "..");
const POOL_DIR = resolve(HERE, "../..");

const BASE_RPC = "https://sepolia.base.org";
const LASNA_RPC = "https://lasna-rpc.rnk.dev/";
const HOOK = "0x18813Bc0B1954490e751e6800Ae5E9d8C5D09000";
const POOL_ID = "0xfbce48fa376e45019cf2c5d4afbe45e0fbf19dd3ad442162431aad7519adbbb4";
// keccak256 of the event signatures (cast keccak).
const MARKED = "0x1fbdf06b61329fded54e41081a1d0978d7424d8c8d6a9489fa9bd86861f39b10"; // Marked(bytes32,uint8,uint8,bytes32,uint256,bytes32)
const MARK_KEPT = "0x5a28ba2feb33e6ddddbe0230f1d37665ca9e6bf067fd29973162c1b687299832"; // MarkKept(bytes32,uint8,uint8,bytes32,bytes32)
const REFLEX_EVENT = "0xbb824a41bd5e2eb86b446be13af337241bc47e64fc7a8f0c55cc730574c355d2"; // Reflex(bytes32,bytes32,uint8,uint24,uint24,uint256,bytes32)
const FEE_OF = "0x430062bd"; // feeOf(bytes32)
const STATUS_OF = "0xc7df14e2"; // statusOf(bytes32)

const LOW_FEE = 500; // 0.05%
const HIGH_FEE = 100_000; // 10%
const MARK_TIMEOUT_MS = 180_000;
const POLL_MS = 1_000;

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => `0x${n.toString(16)}`;
const pad32 = (h) => h.replace(/^0x/, "").padStart(64, "0");

async function rpc(url, method, params, tries = 5) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const body = await res.json();
      if (body.error) throw new Error(`${method}: ${body.error.message}`);
      return body.result;
    } catch (err) {
      if (i >= tries) throw err;
      await sleep(500 * i);
    }
  }
}
const call = (url, to, data) => rpc(url, "eth_call", [{ to, data }, "latest"]);
const blockOf = async (url, n) => {
  const b = await rpc(url, "eth_getBlockByNumber", [hex(n), false]);
  return { number: Number(b.number), time: Number(b.timestamp) };
};
const latest = async (url) => Number(await rpc(url, "eth_blockNumber", []));
const logs = (url, address, fromBlock, topics) =>
  rpc(url, "eth_getLogs", [{ address, fromBlock: hex(fromBlock), toBlock: "latest", topics }]);

/** Runs one forge script that sends a transaction and returns its receipt from the broadcast record. */
function forgeSend(cwd, script, rpcAlias, extraEnv) {
  return new Promise((resolveRun, reject) => {
    const args = ["script", script, "--rpc-url", rpcAlias, "--broadcast"];
    const child = spawn("forge", args, { cwd, env: { ...env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`forge ${script} failed:\n${out.slice(-2000)}`));
      const chain = rpcAlias === "lasna" ? 5318007 : 84532;
      const record = join(cwd, "broadcast", script.replace(/^script\//, ""), String(chain), "run-latest.json");
      const { receipts } = JSON.parse(readFileSync(record, "utf8"));
      const r = receipts.at(-1);
      if (Number(r.status) !== 1) return reject(new Error(`${script}: transaction ${r.transactionHash} failed`));
      resolveRun({ hash: r.transactionHash, block: Number(r.blockNumber) });
    });
  });
}

async function feeNow() {
  return Number(BigInt(await call(BASE_RPC, HOOK, FEE_OF + pad32(POOL_ID))));
}
async function statusNow() {
  return Number(BigInt(await call(BASE_RPC, GUARD, STATUS_OF + pad32(POOL_ID))));
}

async function waitForMark(feeTx, fromBlock) {
  const started = Date.now();
  while (Date.now() - started < MARK_TIMEOUT_MS) {
    const marked = await logs(BASE_RPC, GUARD, fromBlock, [MARKED, POOL_ID, feeTx]);
    if (marked.length) return { kind: "marked", log: marked[0] };
    const kept = await logs(BASE_RPC, GUARD, fromBlock, [MARK_KEPT, POOL_ID, feeTx]);
    if (kept.length) return { kind: "kept", log: kept[0] };
    await sleep(POLL_MS);
  }
  return null;
}

async function findReactive(feeTx, fromBlock) {
  const found = await logs(LASNA_RPC, REFLEX, fromBlock, [REFLEX_EVENT, POOL_ID, feeTx]);
  if (!found.length) return null;
  const b = await blockOf(LASNA_RPC, Number(found[0].blockNumber));
  return { tx: found[0].transactionHash, block: b.number, time: b.time };
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function main() {
  console.log(`measure: ${RUNS} runs · hook ${HOOK} · PoolGuard ${GUARD} · PoolReflex ${REFLEX}`);
  if ((await statusNow()) !== 0) {
    console.log("measure: the pool is marked; reopening first");
    await forgeSend(REFLEX_DIR, "script/Reopen.s.sol", "base_sepolia", { GUARD });
  }
  const lasnaStart = (await latest(LASNA_RPC)) - 50;
  const runs = [];
  for (let i = 1; i <= RUNS; i++) {
    const oldFee = await feeNow();
    const newFee = oldFee === LOW_FEE ? HIGH_FEE : LOW_FEE;
    const fee = await forgeSend(POOL_DIR, "script/SetFee.s.sol", "base_sepolia", { HOOK, NEW_FEE: String(newFee) });
    const feeBlock = await blockOf(BASE_RPC, fee.block);
    const seen = await waitForMark(fee.hash, fee.block);
    const run = { run: i, oldFee, newFee, feeTx: fee.hash, feeBlock: feeBlock.number, feeTime: feeBlock.time };
    if (!seen) {
      run.result = "no mark within 180 s";
      console.log(`#${i} ${oldFee}->${newFee} fee ${fee.hash} block ${fee.block}: no mark within 180 s`);
      runs.push(run);
      continue;
    }
    const markBlock = await blockOf(BASE_RPC, Number(seen.log.blockNumber));
    Object.assign(run, {
      result: seen.kind,
      markTx: seen.log.transactionHash,
      markBlock: markBlock.number,
      markTime: markBlock.time,
      blocks: markBlock.number - feeBlock.number,
      seconds: markBlock.time - feeBlock.time,
    });
    run.reactive = await findReactive(fee.hash, lasnaStart);
    console.log(
      `#${i} ${oldFee}->${newFee} fee ${fee.hash} (${fee.block}) -> mark ${run.markTx} (${run.markBlock}): ` +
        `${run.seconds} s, ${run.blocks} blocks · Lasna ${run.reactive?.tx ?? "not found yet"}`,
    );
    if (seen.kind === "marked") {
      const reopen = await forgeSend(REFLEX_DIR, "script/Reopen.s.sol", "base_sepolia", { GUARD });
      run.reopenTx = reopen.hash;
      run.reopenBlock = reopen.block;
    }
    runs.push(run);
    await sleep(3_000);
  }

  // Lasna logs can lag the mark; look once more for any reactive transaction not found yet.
  for (const run of runs) {
    if (run.markTx && !run.reactive) run.reactive = await findReactive(run.feeTx, lasnaStart);
  }

  const marked = runs.filter((r) => r.result === "marked");
  const summary = {
    runs: runs.length,
    marked: marked.length,
    medianSeconds: marked.length ? median(marked.map((r) => r.seconds)) : null,
    medianBlocks: marked.length ? median(marked.map((r) => r.blocks)) : null,
    minSeconds: marked.length ? Math.min(...marked.map((r) => r.seconds)) : null,
    maxSeconds: marked.length ? Math.max(...marked.map((r) => r.seconds)) : null,
  };
  const record = {
    measuredAt: new Date().toISOString(),
    origin: { chain: "Base Sepolia", chainId: 84532, hook: HOOK, poolId: POOL_ID },
    reactive: { chain: "Reactive Lasna", chainId: 5318007, poolReflex: REFLEX },
    destination: { chain: "Base Sepolia", chainId: 84532, poolGuard: GUARD },
    method:
      "seconds = PoolGuard mark block timestamp - fee change block timestamp (whole seconds); blocks = block gap on Base Sepolia (about 0.2 s each)",
    summary,
    runs,
  };
  writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`measure: ${summary.marked}/${summary.runs} marked · median ${summary.medianSeconds} s (${summary.medianBlocks} blocks) · ${OUT}`);
  if (summary.marked < runs.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`measure: ${err.message}`);
  process.exit(1);
});
