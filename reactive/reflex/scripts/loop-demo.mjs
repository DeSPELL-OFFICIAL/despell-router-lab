#!/usr/bin/env node
// The loop demo: the reflex loop on test pool A, one step at a time, so a screen recording of the app's Reactive card
// can show each step as it lands. Every step waits for a go signal from the recorder, sends one Base Sepolia
// transaction and records the whole loop it starts:
//   raise   pool A's fee 0.05% -> 10%: PoolReflex reacts on Lasna, PoolGuard marks A narrowed, the card leaves A out
//   lower   pool A's fee back to 0.05%: another change, so PoolGuard keeps the mark (MarkKept); A stays out
//   reopen  the owner reopens A: the card routes through A again
// Pool B stays open the whole time, so the card always has a route.
//
//   node --env-file=<env file> ../scripts/with-key.mjs -- node scripts/loop-demo.mjs      (run from reactive/reflex)
//
// Inputs (environment): PRIVATE_KEY (the hook and PoolGuard owner; only the forge child processes read it), GUARD and
// REFLEX (the deployed contracts), SIGNAL_DIR (each step waits until <SIGNAL_DIR>/<step>.go exists, up to
// WAIT_MINUTES, default 30), OUT (default ../deployments/loop-demo-base-sepolia.json). CHECK_ONLY=1 runs the read-only
// checks and stops before sending; it needs no key.
//
// Every run that passes the checks replaces OUT. The default path holds the committed record of the demo video's run,
// so give a new run its own OUT, or copy the old record first, to keep both.
//
// Three Base Sepolia transactions from the owner. The reactions (Lasna) and the marks (Base Sepolia) come from
// Reactive Network. The record is written after every step and names no path on this machine.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASE_RPC,
  blockOf,
  feeOf,
  findReaction,
  forgeSend,
  HOOK,
  LASNA_RPC,
  latest,
  POOL_B_ID,
  POOL_ID,
  precheck,
  sleep,
  statusInLog,
  statusOf,
  waitForMark,
} from "./chain.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REFLEX_DIR = resolve(HERE, "..");
const POOL_DIR = resolve(HERE, "../..");

const LOW_FEE = 500; // 0.05%
const HIGH_FEE = 100_000; // 10%
const MARK_TIMEOUT_MS = 180_000;
const REACTION_TIMEOUT_MS = 60_000;
const REACTIONS = 2n; // A to 10%, A back to 0.05%
const LREACT_PER_REACTION = 20_000_000_000_000_000n; // 0.02 lREACT
const GAS_WEI = 100_000_000_000_000n; // 0.0001 ETH for three transactions, with room
const STEPS = ["raise", "lower", "reopen"];

const env = process.env;
const GUARD = must("GUARD");
const REFLEX = must("REFLEX");
const SIGNAL_DIR = env.SIGNAL_DIR ? resolve(env.SIGNAL_DIR) : fail("SIGNAL_DIR must be set");
const WAIT_MS = Number(env.WAIT_MINUTES ?? 30) * 60_000;
const OUT = resolve(REFLEX_DIR, env.OUT ?? "../deployments/loop-demo-base-sepolia.json");
if (!(WAIT_MS > 0)) fail("WAIT_MINUTES must be a positive number");

function must(name) {
  const v = env[name];
  if (!v || !/^0x[0-9a-fA-F]{40}$/.test(v)) fail(`${name} must be an address`);
  return v;
}
function fail(msg) {
  console.error(`loop-demo: ${msg}`);
  process.exit(2);
}

const record = {
  startedAt: new Date().toISOString(),
  origin: { chain: "Base Sepolia", chainId: 84532, hook: HOOK, pool: POOL_ID },
  reactive: { chain: "Reactive Lasna", chainId: 5318007, poolReflex: REFLEX },
  destination: { chain: "Base Sepolia", chainId: 84532, poolGuard: GUARD },
  method: "seconds = PoolGuard answer block timestamp - change block timestamp (whole seconds); blocks = Base Sepolia block gap (about 0.2 s each)",
  steps: [],
};
const save = () => writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
const log = (msg) => console.log(`loop-demo: ${msg}`);

/** Waits until the recorder says go (<SIGNAL_DIR>/<step>.go), or WAIT_MS passes. */
async function waitForGo(step) {
  const signal = join(SIGNAL_DIR, `${step}.go`);
  // The record is committed: it names the step, never a path on this machine.
  record.waitingFor = { step, since: new Date().toISOString() };
  save();
  log(`waiting for ${signal}, at most ${WAIT_MS / 60_000} min`);
  const until = Date.now() + WAIT_MS;
  while (!existsSync(signal) && Date.now() < until) await sleep(500);
  delete record.waitingFor;
  save();
  return existsSync(signal);
}

/** Sends one forge script and records its transaction under `name`. */
async function send(name, cwd, script, extraEnv) {
  const lasnaFrom = (await latest(LASNA_RPC)) - 20;
  const sent = await forgeSend(cwd, script, "base_sepolia", extraEnv);
  const block = await blockOf(BASE_RPC, sent.block);
  const step = { step: name, tx: sent.hash, block: block.number, time: block.time };
  record.steps.push(step);
  save();
  log(`${name}: ${sent.hash} (block ${block.number})`);
  return { step, lasnaFrom };
}

/** Records the loop a fee change starts: PoolGuard's answer on Base Sepolia and PoolReflex's reaction on Lasna. */
async function loop(step, lasnaFrom) {
  const { found } = await waitForMark({ guard: GUARD, pool: POOL_ID, originTx: step.tx, fromBlock: step.block, timeoutMs: MARK_TIMEOUT_MS });
  if (!found) {
    step.answer = { result: `no answer within ${MARK_TIMEOUT_MS / 1000} s` };
    save();
    return step.answer;
  }
  const mark = await blockOf(BASE_RPC, Number(found.log.blockNumber));
  step.answer = {
    result: found.kind,
    tx: found.log.transactionHash,
    block: mark.number,
    time: mark.time,
    status: statusInLog(found.log),
    blocks: mark.number - step.block,
    seconds: mark.time - step.time,
  };
  save();
  log(`  -> ${found.kind} ${step.answer.tx} (block ${mark.number}), status ${step.answer.status}, ${step.answer.seconds} s / ${step.answer.blocks} blocks`);
  // Lasna's logs can lag the callback; the answer above is what the card waits for, so this lookup comes after it.
  const until = Date.now() + REACTION_TIMEOUT_MS;
  while (!step.reaction && Date.now() < until) {
    step.reaction = await findReaction({ reflex: REFLEX, pool: POOL_ID, originTx: step.tx, fromBlock: lasnaFrom }).catch(() => null);
    if (!step.reaction) await sleep(2_000);
  }
  save();
  log(`  -> reaction on Lasna: ${step.reaction ? `${step.reaction.tx} (block ${step.reaction.block})` : "not found yet"}`);
  return step.answer;
}

function stop(msg) {
  record.stopped = msg;
  save();
  throw new Error(msg);
}

async function main() {
  log(`hook ${HOOK} · PoolGuard ${GUARD} · PoolReflex ${REFLEX} · pool A ${POOL_ID}`);
  if ((await feeOf(POOL_ID)) !== LOW_FEE) fail(`pool A's fee is not ${LOW_FEE}; set it back first`);
  if ((await statusOf(GUARD, POOL_ID)) !== 0) fail("pool A is marked; reopen it first");
  if ((await statusOf(GUARD, POOL_B_ID)) !== 0) fail("pool B is marked; reopen it first, or the card has no route while A is out");
  const checks = await precheck({ guard: GUARD, reflex: REFLEX, lreactNeeded: LREACT_PER_REACTION * REACTIONS, ethNeeded: GAS_WEI });
  if (checks.problems.length) fail(`not starting:\n  - ${checks.problems.join("\n  - ")}`);
  log(`checks passed · owner ${checks.ownerEth} wei · PoolReflex funds ${checks.reflexFunds} wei · PoolGuard funds ${checks.guardFunds} wei`);
  if (env.CHECK_ONLY === "1") {
    log("CHECK_ONLY=1: nothing sent");
    process.exit(0);
  }
  // A signal left from an earlier run would start a step before the recorder is ready. Cleared only once the checks
  // pass, so a second run started by mistake stops before it touches a running demo's signals.
  mkdirSync(SIGNAL_DIR, { recursive: true });
  for (const step of STEPS) rmSync(join(SIGNAL_DIR, `${step}.go`), { force: true });
  log(`record: ${OUT} (replaces any earlier record there)`);
  save();

  // 1. A's fee to 10%: PoolReflex marks A narrowed, and the card routes through B.
  if (!(await waitForGo("raise"))) stop("no go for raise; nothing sent");
  const raised = await send("raise", POOL_DIR, "script/SetFee.s.sol", { HOOK, NEW_FEE: String(HIGH_FEE) });
  if ((await loop(raised.step, raised.lasnaFrom)).result !== "marked") {
    stop("pool A was not marked after its fee change; pool A is left at 10%, and a late answer may still mark it");
  }

  // 2. A's fee back to 0.05%: another change, so PoolGuard keeps A narrowed. Wait for that answer before reopening, or
  //    a late callback would mark A again after the reopen.
  if (!(await waitForGo("lower"))) stop("no go for lower; pool A is left at 10% and marked");
  const lowered = await send("lower", POOL_DIR, "script/SetFee.s.sol", { HOOK, NEW_FEE: String(LOW_FEE) });
  if ((await loop(lowered.step, lowered.lasnaFrom)).result.startsWith("no answer")) {
    stop("no answer to pool A's fee change back; pool A is left at 0.05% and marked. Not reopening A, or the late answer would mark it again after");
  }

  // 3. The owner reopens A: both pools are open, and the card routes through A, which pays more.
  if (!(await waitForGo("reopen"))) stop("no go for reopen; pool A is left at 0.05% and marked");
  await send("reopen", REFLEX_DIR, "script/Reopen.s.sol", { GUARD, POOL_ID });
}

main()
  .catch((err) => {
    console.error(`loop-demo: ${err.message}`);
    record.error = err.message;
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      record.end = {
        feeA: await feeOf(POOL_ID),
        statusA: await statusOf(GUARD, POOL_ID),
        statusB: await statusOf(GUARD, POOL_B_ID),
        at: new Date().toISOString(),
      };
      log(`end · pool A fee ${record.end.feeA}, status ${record.end.statusA} · pool B status ${record.end.statusB}`);
    } catch (err) {
      log(`could not read the end state: ${err.message}`);
    }
    save();
  });
