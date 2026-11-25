#!/usr/bin/env node
// The route demo: adds test pool B on the same hook as pool A, then walks PoolGuard through the three states the app's
// Reactive card is shown in, holding each one until it has been captured:
//   no-route   A and B both marked (B is marked when it opens, A after a fee change): the card has no route
//   left-out   A marked, B reopened: the quote goes through B, with a "Left out" row for A
//   both-open  A's fee back at 0.05% and A reopened: the quote goes through A again
//
//   node --env-file=<env file> ../scripts/with-key.mjs -- node scripts/route-demo.mjs      (run from reactive/reflex)
//
// Inputs (environment): PRIVATE_KEY (the hook and PoolGuard owner; only the forge child processes read it), GUARD and
// REFLEX (the deployed contracts), SIGNAL_DIR (at each state the demo waits until <SIGNAL_DIR>/<state>.done exists,
// up to HOLD_MINUTES, default 20), SEED_WEI (pool B's ETH, default 0.01 ETH), OUT (default
// ../deployments/route-demo-base-sepolia.json). CHECK_ONLY=1 runs the read-only checks and stops before sending.
//
// Six Base Sepolia transactions from the owner: initialize and seed B, A's fee to 10% and back, reopen B, reopen A.
// The reactions (Lasna) and the marks (Base Sepolia) come from Reactive Network. The record is written after every step.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_RPC, blockOf, feeOf, forgeSend, HOOK, POOL_B_ID, POOL_ID, precheck, rpc, sleep, statusInLog, statusOf, waitForMark } from "./chain.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REFLEX_DIR = resolve(HERE, "..");
const POOL_DIR = resolve(HERE, "../..");

const STATE_VIEW = "0x571291b572ed32ce6751a2Cb2486EbEe8DEfB9B4";
const GET_SLOT0 = "0xc815641c"; // getSlot0(bytes32)
const LOW_FEE = 500; // 0.05%
const HIGH_FEE = 100_000; // 10%
const MARK_TIMEOUT_MS = 180_000;
const REACTIONS = 3n; // B's opening, A to 10%, A back to 0.05%
const LREACT_PER_REACTION = 20_000_000_000_000_000n; // 0.02 lREACT
const GAS_WEI = 200_000_000_000_000n; // 0.0002 ETH for six transactions, with room

const env = process.env;
const GUARD = must("GUARD");
const REFLEX = must("REFLEX");
const SIGNAL_DIR = env.SIGNAL_DIR ? resolve(env.SIGNAL_DIR) : fail("SIGNAL_DIR must be set");
const HOLD_MS = Number(env.HOLD_MINUTES ?? 20) * 60_000;
const SEED_WEI = BigInt(env.SEED_WEI ?? "10000000000000000");
const OUT = resolve(REFLEX_DIR, env.OUT ?? "../deployments/route-demo-base-sepolia.json");
if (!(HOLD_MS > 0)) fail("HOLD_MINUTES must be a positive number");
if (SEED_WEI <= 0n || SEED_WEI > 20_000_000_000_000_000n) fail("SEED_WEI must be above 0 and at most 0.02 ETH");

function must(name) {
  const v = env[name];
  if (!v || !/^0x[0-9a-fA-F]{40}$/.test(v)) fail(`${name} must be an address`);
  return v;
}
function fail(msg) {
  console.error(`route-demo: ${msg}`);
  process.exit(2);
}

const record = {
  startedAt: new Date().toISOString(),
  chain: { name: "Base Sepolia", chainId: 84532 },
  hook: HOOK,
  poolGuard: GUARD,
  poolReflex: REFLEX,
  pools: { A: POOL_ID, B: POOL_B_ID },
  steps: [],
  states: [],
};
const save = () => writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
const log = (msg) => console.log(`route-demo: ${msg}`);

async function initialized(pool) {
  const slot0 = await rpc(BASE_RPC, "eth_call", [{ to: STATE_VIEW, data: GET_SLOT0 + pool.replace(/^0x/, "") }, "latest"]);
  return BigInt(slot0.slice(0, 66)) !== 0n;
}

/** Sends one forge script and records its transactions under `name`. */
async function send(name, cwd, script, extraEnv, flags) {
  const sent = await forgeSend(cwd, script, "base_sepolia", extraEnv, flags);
  const step = { step: name, txs: sent.all };
  record.steps.push(step);
  save();
  log(`${name}: ${sent.all.map((t) => `${t.hash} (block ${t.block})`).join(", ")}`);
  return { sent, step };
}

/** Waits for PoolGuard's answer to the pool change in `originTx` and adds it to the step. */
async function answer(step, pool, origin) {
  const { found } = await waitForMark({ guard: GUARD, pool, originTx: origin.hash, fromBlock: origin.block, timeoutMs: MARK_TIMEOUT_MS });
  if (!found) {
    step.answer = { result: `no mark within ${MARK_TIMEOUT_MS / 1000} s` };
    save();
    return step.answer;
  }
  const [change, mark] = await Promise.all([blockOf(BASE_RPC, origin.block), blockOf(BASE_RPC, Number(found.log.blockNumber))]);
  step.answer = {
    result: found.kind,
    markTx: found.log.transactionHash,
    markBlock: mark.number,
    status: statusInLog(found.log),
    blocks: mark.number - change.number,
    seconds: mark.time - change.time,
  };
  save();
  log(`  -> ${found.kind} ${step.answer.markTx} (block ${mark.number}), status ${step.answer.status}, ${step.answer.seconds} s / ${step.answer.blocks} blocks`);
  return step.answer;
}

/** Holds a state until the capture is done (the agent creates <SIGNAL_DIR>/<state>.done) or HOLD_MS passes. */
async function hold(state) {
  const statuses = { A: await statusOf(GUARD, POOL_ID), B: await statusOf(GUARD, POOL_B_ID) };
  const signal = join(SIGNAL_DIR, `${state}.done`);
  record.waitingFor = { state, statuses, since: new Date().toISOString(), signal };
  save();
  log(`state ${state} (A ${statuses.A}, B ${statuses.B}) · holding until ${signal} exists, at most ${HOLD_MS / 60_000} min`);
  const until = Date.now() + HOLD_MS;
  while (!existsSync(signal) && Date.now() < until) await sleep(2_000);
  record.states.push({ state, statuses, released: existsSync(signal) ? "captured" : "timed out", at: new Date().toISOString() });
  delete record.waitingFor;
  save();
}

function stop(msg) {
  record.stopped = msg;
  save();
  throw new Error(msg);
}

async function main() {
  mkdirSync(SIGNAL_DIR, { recursive: true });
  log(`hook ${HOOK} · PoolGuard ${GUARD} · PoolReflex ${REFLEX} · pool B seed ${SEED_WEI} wei`);
  if (await initialized(POOL_B_ID)) fail(`pool B ${POOL_B_ID} is already initialized; this demo opens it`);
  if ((await feeOf(POOL_ID)) !== LOW_FEE) fail(`pool A's fee is not ${LOW_FEE}; set it back first`);
  if ((await statusOf(GUARD, POOL_ID)) !== 0) fail("pool A is marked; reopen it first");
  const checks = await precheck({ guard: GUARD, reflex: REFLEX, lreactNeeded: LREACT_PER_REACTION * REACTIONS, ethNeeded: SEED_WEI + GAS_WEI });
  if (checks.problems.length) fail(`not starting:\n  - ${checks.problems.join("\n  - ")}`);
  log(`checks passed · owner ${checks.ownerEth} wei · PoolReflex funds ${checks.reflexFunds} wei · PoolGuard funds ${checks.guardFunds} wei`);
  if (env.CHECK_ONLY === "1") {
    log("CHECK_ONLY=1: nothing sent");
    process.exit(0);
  }
  save();

  // 1. Pool B opens at A's price; its FeeUpdated(0 -> 500) is a change, so PoolReflex marks it narrowed.
  const opened = await send("open pool B", POOL_DIR, "script/LaunchSecondPool.s.sol", { HOOK, SEED_WEI: String(SEED_WEI) }, ["--slow"]);
  if ((await answer(opened.step, POOL_B_ID, opened.sent.all[0])).result !== "marked") stop("pool B was not marked; stopping before A's fee changes");

  // 2. A's fee to 10%: A is marked too, and no pool is left.
  const raised = await send("pool A fee 0.05% -> 10%", POOL_DIR, "script/SetFee.s.sol", { HOOK, NEW_FEE: String(HIGH_FEE) });
  if ((await answer(raised.step, POOL_ID, raised.sent)).result !== "marked") stop("pool A was not marked after its fee change");
  await hold("no-route");

  // 3. The operator reopens B: the quote goes through B and leaves A out.
  await send("reopen pool B", REFLEX_DIR, "script/Reopen.s.sol", { GUARD, POOL_ID: POOL_B_ID });
  await hold("left-out");

  // 4. A's fee back to 0.05%: another change, so PoolGuard keeps A narrowed (MarkKept). Wait for it before reopening,
  //    or a late callback would mark A again after the reopen.
  const lowered = await send("pool A fee 10% -> 0.05%", POOL_DIR, "script/SetFee.s.sol", { HOOK, NEW_FEE: String(LOW_FEE) });
  await answer(lowered.step, POOL_ID, lowered.sent);

  // 5. The operator reopens A: both pools are open, and the quote goes through A, which pays more.
  await send("reopen pool A", REFLEX_DIR, "script/Reopen.s.sol", { GUARD, POOL_ID });
  await hold("both-open");
}

main()
  .catch((err) => {
    console.error(`route-demo: ${err.message}`);
    record.error = err.message;
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      record.end = {
        feeA: await feeOf(POOL_ID),
        feeB: await feeOf(POOL_B_ID),
        statusA: await statusOf(GUARD, POOL_ID),
        statusB: await statusOf(GUARD, POOL_B_ID),
        at: new Date().toISOString(),
      };
      log(`end · pool A fee ${record.end.feeA}, status ${record.end.statusA} · pool B fee ${record.end.feeB}, status ${record.end.statusB}`);
    } catch (err) {
      log(`could not read the end state: ${err.message}`);
    }
    save();
  });
